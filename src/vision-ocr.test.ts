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

interface ProseLine {
  text: string
  /** Render this line centred in the column, as a heading is set. */
  centered?: boolean
  /** Indent this line, as the first line of a paragraph is. */
  indented?: boolean
  /** Leave a blank line above this one. */
  gapAbove?: boolean
}

/**
 * A PNG laid out like a page of a book: a text column with wrapped lines, so
 * the engine has the layout it needs to tell a wrapped line from a new
 * paragraph.
 */
async function writeProsePage(
  name: string,
  lines: ProseLine[]
): Promise<string> {
  const width = 900
  const left = 60
  const pitch = 50

  let y = 90
  const body = lines
    .map((line, i) => {
      if (i > 0) y += pitch * (line.gapAbove ? 2 : 1)
      const x = line.centered ? width / 2 : left + (line.indented ? 60 : 0)
      const anchor = line.centered ? 'middle' : 'start'

      return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Georgia, serif" font-size="34" fill="black">${line.text}</text>`
    })
    .join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 90}">
    <rect width="100%" height="100%" fill="white"/>${body}</svg>`

  const file = path.join(root, name)
  await sharp(Buffer.from(svg)).png().toFile(file)
  return file
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

// The first request pays for spawning the worker and for Vision loading its
// recognition models, which on a cold machine is well past vitest's 5s default.
const TEST_TIMEOUT_MS = 60_000

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

  it(
    'reads text off a page image',
    async () => {
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
    },
    TEST_TIMEOUT_MS
  )

  it(
    'puts wrapped lines back into paragraphs',
    async () => {
      // The bug this guards against: Vision reads one *rendered* line at a time,
      // and the formatter downstream treats every newline as a paragraph break,
      // so returning the lines as-is made every wrapped line its own paragraph.
      const imagePath = await writeProsePage('prose.png', [
        { text: 'A QUIET AFTERNOON', centered: true },
        {
          text: 'The rain had been falling since morning, and the',
          gapAbove: true
        },
        { text: 'gutters along the narrow street were running fast' },
        { text: 'with water that carried the summer dust away.' },
        {
          text: 'Nobody in the house had thought to close the',
          indented: true
        },
        { text: 'window, so the curtain hung heavy and dark' },
        { text: 'against the sill until evening.' },
        {
          text: 'Later, when the sky cleared, the whole street',
          gapAbove: true
        },
        { text: 'smelled of wet stone and someone somewhere' },
        { text: 'was playing a piano badly.' }
      ])

      const paragraphs = (
        await engine.recognize({
          imagePath,
          attempt: 0,
          signal: withTimeout(30_000)
        })
      ).split('\n')

      // The heading, then three paragraphs: one ended by a blank line, one marked
      // only by the indent that follows it, and one that runs to the page's end.
      expect(paragraphs).toHaveLength(4)
      expect(paragraphs[0]).toContain('QUIET AFTERNOON')
      expect(paragraphs[1]).toContain('falling since morning')
      expect(paragraphs[1]).toContain('summer dust away')
      expect(paragraphs[2]).toContain('close the window')
      expect(paragraphs[3]).toContain('piano badly')
    },
    TEST_TIMEOUT_MS
  )

  it('costs nothing, which is the point of using it', () => {
    expect(engine.costsMoney).toBe(false)
  })

  it(
    'reports an unreadable image without taking the worker down with it',
    async () => {
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
    },
    TEST_TIMEOUT_MS
  )

  it(
    'handles a book-sized burst of concurrent pages',
    async () => {
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
    },
    TEST_TIMEOUT_MS
  )

  it(
    'refuses work once closed',
    async () => {
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
    },
    TEST_TIMEOUT_MS
  )
})
