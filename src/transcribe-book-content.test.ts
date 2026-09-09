import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OcrEngine } from './ocr-engine'
import type { BookMetadata, ContentChunk, ContentStore } from './types'
import {
  type ChatCompletionClient,
  transcribeBook
} from './transcribe-book-content'

const ASIN = 'B000TEST01'

let root: string

/** A book with `pageCount` captured pages, on disk. */
async function writeBook(
  pageCount: number,
  toc: Array<{ label: string; page: number }> = [
    { label: 'Chapter One', page: 1 }
  ],
  {
    captureId,
    startPage = 1,
    absoluteScreenshots = false
  }: {
    captureId?: string
    startPage?: number
    /** Write the pre-relative-path form, as older captures left on disk. */
    absoluteScreenshots?: boolean
  } = {}
): Promise<void> {
  const outDir = path.join(root, ASIN)
  await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })

  const pages = []
  for (let index = 0; index < pageCount; index++) {
    // Captures store the image relative to the book directory.
    const screenshot = path.join('pages', `${index}.png`)
    // Content is irrelevant: the client is faked, it just has to be readable.
    await fs.writeFile(
      path.join(outDir, screenshot),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
    pages.push({
      index,
      page: startPage + index,
      screenshot: absoluteScreenshots
        ? path.join(outDir, screenshot)
        : screenshot
    })
  }

  const metadata: Partial<BookMetadata> = {
    ...(captureId ? { captureId } : {}),
    pages,
    toc: toc.map((item, i) => ({ ...item, positionId: i, depth: 0 })) as any
  }

  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(metadata)
  )
}

async function readContentJson(): Promise<ContentChunk[]> {
  const raw = JSON.parse(
    await fs.readFile(path.join(root, ASIN, 'content.json'), 'utf8')
  ) as ContentStore | ContentChunk[]

  return Array.isArray(raw) ? raw : raw.chunks
}

/** A client whose reply (or thrown error) is decided per call. */
function fakeClient(
  reply: (callIndex: number) => string | Error
): ChatCompletionClient & { calls: number } {
  let calls = 0

  return {
    get calls() {
      return calls
    },
    async createChatCompletion() {
      const result = reply(calls++)
      if (result instanceof Error) throw result

      return { choices: [{ message: { content: result } }] }
    }
  } as ChatCompletionClient & { calls: number }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-test-'))
  // The retry paths sleep; keep the suite fast without faking timers.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('transcribeBook', () => {
  it('transcribes every page and writes content.json', async () => {
    await writeBook(3)

    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client: fakeClient((i) => `text for page ${i + 1}`)
    })

    expect(failedPages).toEqual([])
    expect(content.map((c) => c.text)).toEqual([
      'text for page 1',
      'text for page 2',
      'text for page 3'
    ])
    expect(await readContentJson()).toHaveLength(3)
  })

  it('records a page it could never read instead of dropping it silently', async () => {
    await writeBook(2)

    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      maxRetries: 2,
      client: fakeClient(() => new Error('boom'))
    })

    expect(content).toEqual([])
    expect(failedPages).toHaveLength(2)
    expect(failedPages[0]).toMatchObject({ index: 0, page: 1 })
    expect(failedPages[0]!.error).toContain('boom')
  })

  it('retries a transient error and keeps the eventual text', async () => {
    await writeBook(1)

    const client = fakeClient((i) =>
      i < 2 ? new Error('rate limited') : 'recovered text'
    )
    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      client
    })

    expect(failedPages).toEqual([])
    expect(content[0]!.text).toBe('recovered text')
    expect(client.calls).toBe(3)
  })

  it('retries a refusal rather than storing it as the page text', async () => {
    await writeBook(1)

    const client = fakeClient((i) =>
      i === 0 ? "I'm sorry, I can't help with that." : 'the real page text'
    )
    const { content } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      client
    })

    expect(content[0]!.text).toBe('the real page text')
    expect(client.calls).toBe(2)
  })

  it('accepts a blank page instead of retrying it forever', async () => {
    await writeBook(1)

    const client = fakeClient(() => '')
    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client
    })

    // Books have blank pages, and an empty transcription is the right answer
    // for one. The bound is what matters: an unbounded retry here is an
    // unbounded bill.
    expect(client.calls).toBe(3)
    expect(failedPages).toEqual([])
    expect(content).toHaveLength(1)
    expect(content[0]!.text).toBe('')
  })

  it('treats a whitespace-only reply as blank, not as text', async () => {
    await writeBook(1)

    const client = fakeClient(() => '  \n \t \n ')
    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      maxRetries: 1,
      client
    })

    expect(client.calls).toBe(1)
    expect(failedPages).toEqual([])
    expect(content[0]!.text).toBe('')
  })

  it('keeps a blank page rather than paying to re-read it', async () => {
    await writeBook(2)

    await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      maxRetries: 1,
      client: fakeClient((i) => (i === 0 ? '' : 'page two'))
    })

    const client = fakeClient(() => 'should not be called')
    const { content } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      client
    })

    expect(client.calls).toBe(0)
    expect(content.map((c) => c.text)).toEqual(['', 'page two'])
  })

  it('strips a TOC heading whose label is also regex syntax', async () => {
    await writeBook(2, [{ label: 'C++ Primer (2nd ed.)', page: 2 }])

    const client = fakeClient((i) =>
      i === 0 ? 'page one' : 'C++ Primer (2nd ed.) and then the body text'
    )
    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client
    })

    // Unescaped, this label is an invalid regex and the page dies after a paid
    // request; a label like "Chapter 1 (cont.)" would silently mis-match.
    expect(failedPages).toEqual([])
    expect(content[1]!.text).toBe('and then the body text')
  })

  it('reuses already-transcribed pages and retries only what is missing', async () => {
    await writeBook(3)

    // First run: the middle page fails.
    const first = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client: fakeClient(() => 'ok')
    })
    expect(first.content).toHaveLength(3)

    // Drop one page to simulate a partial run, then transcribe again.
    const partial = (await readContentJson()).filter((c) => c.index !== 1)
    await fs.writeFile(
      path.join(root, ASIN, 'content.json'),
      JSON.stringify(partial)
    )

    const client = fakeClient(() => 'refetched')
    const second = await transcribeBook({
      asin: ASIN,
      outDir: root,
      client
    })

    // Only the missing page cost a call, and order is restored.
    expect(client.calls).toBe(1)
    expect(second.content.map((c) => c.index)).toEqual([0, 1, 2])
    expect(second.content[1]!.text).toBe('refetched')
    expect(second.content[0]!.text).toBe('ok')
  })

  it('re-reads everything when forced', async () => {
    await writeBook(2)

    await transcribeBook({
      asin: ASIN,
      outDir: root,
      client: fakeClient(() => 'first pass')
    })

    const client = fakeClient(() => 'second pass')
    const { content } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      force: true,
      client
    })

    expect(client.calls).toBe(2)
    expect(content.every((c) => c.text === 'second pass')).toBe(true)
  })

  it('reports progress against the pages it actually needs to read', async () => {
    await writeBook(3)
    const seen: Array<[number, number]> = []

    await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client: fakeClient(() => 'ok'),
      onProgress: (done, total) => seen.push([done, total])
    })

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ])
  })

  it('drops text read from a previous capture of the same book', async () => {
    await writeBook(2, undefined, { captureId: 'capture-a' })
    await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client: fakeClient(() => 'old text')
    })
    expect(await readContentJson()).toHaveLength(2)

    // A re-capture: one page, numbered 7, and a new identity.
    await writeBook(1, [{ label: 'Chapter One', page: 7 }], {
      captureId: 'capture-b',
      startPage: 7
    })

    const client = fakeClient(() => 'new text')
    const { content } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client
    })

    // Keyed on index alone the old chunk matched, so this used to cost no
    // calls at all and export the previous capture's pages 1 and 2.
    expect(client.calls).toBe(1)
    expect(content).toEqual([
      expect.objectContaining({ index: 0, page: 7, text: 'new text' })
    ])
  })

  it('drops legacy text whose pages the capture no longer has', async () => {
    await writeBook(1, [{ label: 'Chapter One', page: 7 }], { startPage: 7 })
    // The bare-array shape written before captures had an identity, describing
    // a capture that is plainly not the one on disk.
    await fs.writeFile(
      path.join(root, ASIN, 'content.json'),
      JSON.stringify([
        { index: 0, page: 1, text: 'old page one', screenshot: 'pages/0.png' },
        { index: 1, page: 2, text: 'old page two', screenshot: 'pages/1.png' }
      ])
    )

    const client = fakeClient(() => 'new text')
    const { content } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client
    })

    expect(client.calls).toBe(1)
    expect(content.map((c) => c.text)).toEqual(['new text'])
  })

  it('saves each page as it finishes, so an interruption keeps them', async () => {
    await writeBook(2)

    let releaseSecondPage: (() => void) | undefined
    let secondPageStarted!: () => void
    const secondPageReached = new Promise<void>((resolve) => {
      secondPageStarted = resolve
    })

    const engine: OcrEngine = {
      name: 'fake',
      costsMoney: false,
      async recognize({ imagePath }) {
        if (imagePath.endsWith('0.png')) return 'page one'

        // Stands in for a Ctrl+C: page two never comes back until the test has
        // looked at what page one left behind.
        secondPageStarted()
        await new Promise<void>((resolve) => {
          releaseSecondPage = resolve
        })
        throw new Error('interrupted')
      },
      async close() {}
    }

    const run = transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      maxRetries: 1,
      engine
    })
    await secondPageReached

    // The point of the fix: page one is on disk while the run is still going.
    // Written once at the end, this file would not exist yet, and a run killed
    // here threw away every page it had already paid to read.
    await vi.waitFor(
      async () => {
        expect((await readContentJson()).map((c) => c.text)).toEqual([
          'page one'
        ])
      },
      { timeout: 5000, interval: 25 }
    )

    releaseSecondPage!()
    const { content, failedPages } = await run
    expect(content.map((c) => c.text)).toEqual(['page one'])
    expect(failedPages).toHaveLength(1)
    expect(await readContentJson()).toHaveLength(1)
  })

  it('resumes from the pages an interrupted run saved', async () => {
    await writeBook(2)
    // What the run above leaves behind.
    await fs.writeFile(
      path.join(root, ASIN, 'content.json'),
      JSON.stringify({
        chunks: [
          { index: 0, page: 1, text: 'page one', screenshot: 'pages/0.png' }
        ]
      })
    )

    const client = fakeClient(() => 'page two')
    const { content } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client
    })

    expect(client.calls).toBe(1)
    expect(content.map((c) => c.text)).toEqual(['page one', 'page two'])
  })

  it('finds page images when run from another working directory', async () => {
    await writeBook(2)

    const elsewhere = await fs.mkdtemp(
      path.join(os.tmpdir(), 'kindle-export-cwd-')
    )
    const originalCwd = process.cwd()
    process.chdir(elsewhere)

    try {
      // Paths stored relative to the book directory used to be resolved
      // against the working directory, so this failed with the thoroughly
      // misleading "page images are gone (cleaned up)".
      const { content, failedPages } = await transcribeBook({
        asin: ASIN,
        outDir: path.resolve(root),
        concurrency: 1,
        client: fakeClient(() => 'read from elsewhere')
      })

      expect(failedPages).toEqual([])
      expect(content.map((c) => c.text)).toEqual([
        'read from elsewhere',
        'read from elsewhere'
      ])
    } finally {
      process.chdir(originalCwd)
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('still reads captures that stored absolute image paths', async () => {
    await writeBook(1, undefined, { absoluteScreenshots: true })

    const { content, failedPages } = await transcribeBook({
      asin: ASIN,
      outDir: root,
      concurrency: 1,
      client: fakeClient(() => 'old capture, still readable')
    })

    expect(failedPages).toEqual([])
    expect(content[0]!.text).toBe('old capture, still readable')
  })
})
