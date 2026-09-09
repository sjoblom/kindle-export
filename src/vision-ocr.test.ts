import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { OcrEngine } from './ocr-engine'
import { createVisionOcrEngine, isVisionOcrAvailable } from './vision-ocr'

// Local OCR only exists on macOS, and only once the binary has been built.
// Everywhere else transcription falls back to OpenAI, so skip rather than fail.
const available = await isVisionOcrAvailable()

let root: string

/** A PNG containing exactly `lines`, rendered as crisp text like a Kindle page. */
async function writePage(name: string, lines: string[]): Promise<string> {
  const body = lines
    .map(
      (line, i) =>
        `<text x="40" y="${80 + i * 70}" font-family="Georgia, serif" font-size="40" fill="black">${line}</text>`
    )
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${120 + lines.length * 70}">
    <rect width="100%" height="100%" fill="white"/>${body}</svg>`

  const file = path.join(root, name)
  await sharp(Buffer.from(svg)).png().toFile(file)
  return file
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

describe.skipIf(!available)('vision OCR engine', () => {
  let engine: OcrEngine

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-vision-'))
    engine = createVisionOcrEngine()
  })

  afterAll(async () => {
    await engine.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reads text off a page image', async () => {
    const imagePath = await writePage('one.png', [
      'The quick brown fox',
      'jumps over the lazy dog'
    ])

    const text = await engine.recognize({
      imagePath,
      attempt: 0,
      signal: withTimeout(30_000)
    })

    expect(text).toContain('quick brown fox')
    expect(text).toContain('lazy dog')
  })

  it('costs nothing, which is the point of using it', () => {
    expect(engine.costsMoney).toBe(false)
  })

  it('reports an unreadable image without taking the worker down with it', async () => {
    const missing = path.join(root, 'does-not-exist.png')

    await expect(
      engine.recognize({
        imagePath: missing,
        attempt: 0,
        signal: withTimeout(30_000)
      })
    ).rejects.toThrow(/unreadable/i)

    // The worker has to survive a bad page: one unreadable image in a 400 page
    // book must not fail the other 399.
    const imagePath = await writePage('after-failure.png', ['still working'])
    const text = await engine.recognize({
      imagePath,
      attempt: 0,
      signal: withTimeout(30_000)
    })
    expect(text).toContain('still working')
  })

  it('handles a book-sized burst of concurrent pages', async () => {
    // Regression test. Dispatching every page at once starved Vision's own
    // internal queues of threads and the worker deadlocked, returning nothing
    // at all rather than failing.
    //
    // Markers are words rather than numbers: Vision's language correction
    // reads an isolated digit as the letter it resembles, which would make this
    // a flaky test of OCR accuracy instead of a test of request routing.
    const markers = [
      'alfa',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
      'lima',
      'mike',
      'november',
      'oscar',
      'papa',
      'quebec',
      'romeo',
      'sierra',
      'tango',
      'uniform',
      'victor',
      'whiskey',
      'xray'
    ]
    const pages = await Promise.all(
      markers.map((marker, i) =>
        writePage(`burst-${i}.png`, [`marker ${marker}`])
      )
    )

    const texts = await Promise.all(
      pages.map((imagePath) =>
        engine.recognize({
          imagePath,
          attempt: 0,
          signal: withTimeout(60_000)
        })
      )
    )

    expect(texts).toHaveLength(markers.length)
    // Each answer must match its own request rather than another page's.
    for (const [i, text] of texts.entries()) {
      expect(text.toLowerCase()).toContain(markers[i]!)
    }
  })

  it('refuses work once closed', async () => {
    const closable = createVisionOcrEngine()
    const imagePath = await writePage('closable.png', ['hello'])

    expect(
      await closable.recognize({
        imagePath,
        attempt: 0,
        signal: withTimeout(30_000)
      })
    ).toContain('hello')

    await closable.close()
    // Closing twice is allowed, since callers close in a finally block.
    await closable.close()

    await expect(
      closable.recognize({
        imagePath,
        attempt: 0,
        signal: withTimeout(30_000)
      })
    ).rejects.toThrow(/closed/i)
  })
})
