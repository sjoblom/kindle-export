import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BookMetadata, ContentChunk } from './types'
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
  ]
): Promise<void> {
  const outDir = path.join(root, ASIN)
  await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })

  const pages = []
  for (let index = 0; index < pageCount; index++) {
    const screenshot = path.join(outDir, 'pages', `${index}.png`)
    // Content is irrelevant: the client is faked, it just has to be readable.
    await fs.writeFile(screenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    pages.push({ index, page: index + 1, screenshot })
  }

  const metadata: Partial<BookMetadata> = {
    pages,
    toc: toc.map((item, i) => ({ ...item, positionId: i, depth: 0 })) as any
  }

  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(metadata)
  )
}

async function readContentJson(): Promise<ContentChunk[]> {
  return JSON.parse(
    await fs.readFile(path.join(root, ASIN, 'content.json'), 'utf8')
  ) as ContentChunk[]
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
})
