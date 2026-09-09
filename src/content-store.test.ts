import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ContentChunk } from './types'
import {
  createContentWriter,
  invalidateContent,
  readContentStore,
  selectReusableChunks,
  writeContentStore
} from './content-store'

let bookDir: string

beforeEach(async () => {
  bookDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-test-'))
})

afterEach(async () => {
  await fs.rm(bookDir, { recursive: true, force: true })
})

function chunk(index: number, page = index + 1): ContentChunk {
  return { index, page, text: `page ${page}`, screenshot: `pages/${index}.png` }
}

function pagesOf(chunks: ContentChunk[]) {
  return chunks.map(({ index, page }) => ({
    index,
    page,
    screenshot: `pages/${index}.png`
  }))
}

describe('readContentStore', () => {
  it('reads the bare array older versions wrote', async () => {
    await fs.writeFile(
      path.join(bookDir, 'content.json'),
      JSON.stringify([chunk(0), chunk(1)])
    )

    const store = await readContentStore(bookDir)
    expect(store?.captureId).toBeUndefined()
    expect(store?.chunks).toHaveLength(2)
  })

  it('returns nothing for a missing or unreadable file', async () => {
    expect(await readContentStore(bookDir)).toBeUndefined()

    await fs.writeFile(path.join(bookDir, 'content.json'), 'not json{')
    expect(await readContentStore(bookDir)).toBeUndefined()
  })

  it('round-trips a store and forgets it when invalidated', async () => {
    await writeContentStore(bookDir, {
      captureId: 'capture-a',
      chunks: [chunk(0)]
    })
    expect(await readContentStore(bookDir)).toMatchObject({
      captureId: 'capture-a'
    })

    await invalidateContent(bookDir)
    expect(await readContentStore(bookDir)).toBeUndefined()
    // Nothing to remove is not an error — most books never had a transcription.
    await expect(invalidateContent(bookDir)).resolves.toBeUndefined()
  })
})

describe('selectReusableChunks', () => {
  const chunks = [chunk(0), chunk(1)]

  it('keeps text stamped with the capture on disk', () => {
    const store = { captureId: 'capture-a', chunks }
    const metadata = { captureId: 'capture-a', pages: pagesOf(chunks) }

    expect(selectReusableChunks(store, metadata)).toHaveLength(2)
  })

  it('drops every chunk when the capture id differs', () => {
    const store = { captureId: 'capture-a', chunks }
    const metadata = { captureId: 'capture-b', pages: pagesOf(chunks) }

    expect(selectReusableChunks(store, metadata)).toEqual([])
  })

  it('drops chunks for pages the current capture does not have', () => {
    const store = { captureId: 'capture-a', chunks }
    const metadata = { captureId: 'capture-a', pages: pagesOf([chunk(0)]) }

    expect(selectReusableChunks(store, metadata)).toEqual([chunk(0)])
  })

  it('keeps an unstamped file that still lines up with the capture', () => {
    // A partial run is normal — fewer chunks than pages is not a mismatch.
    const store = { chunks: [chunk(0)] }
    const metadata = { pages: pagesOf(chunks) }

    expect(selectReusableChunks(store, metadata)).toEqual([chunk(0)])
  })

  it('drops an unstamped file whose pages contradict the capture', () => {
    const store = { chunks }
    // The same index, a different page: a different capture of the book.
    const metadata = { pages: pagesOf([chunk(0, 7)]) }

    expect(selectReusableChunks(store, metadata)).toEqual([])
  })

  it('leaves out junk chunks without condemning the whole file', () => {
    const store = {
      chunks: [chunk(0), { index: 1, page: 2 } as ContentChunk]
    }
    const metadata = { pages: pagesOf(chunks) }

    // No text at all is a page that never got read, not evidence of a
    // different capture — it just gets read again.
    expect(selectReusableChunks(store, metadata)).toEqual([chunk(0)])
  })
})

describe('createContentWriter', () => {
  it('never interleaves concurrent saves', async () => {
    const writer = createContentWriter(bookDir, { captureId: 'capture-a' })

    // More than the forced-save threshold, added the way parallel OCR workers
    // do: whatever lands on disk has to be a whole snapshot, never a mix.
    for (let index = 0; index < 40; index++) writer.add(chunk(index))
    await writer.flush()

    const store = await readContentStore(bookDir)
    expect(store?.captureId).toBe('capture-a')
    expect(store?.chunks.map((c) => c.index)).toEqual(
      Array.from({ length: 40 }, (_, index) => index)
    )
  })

  it('writes pages in order and keeps the ones it started with', async () => {
    const writer = createContentWriter(bookDir, { chunks: [chunk(5)] })
    writer.add(chunk(2))
    writer.add(chunk(9))
    await writer.flush()

    expect(writer.chunks().map((c) => c.index)).toEqual([2, 5, 9])
    expect((await readContentStore(bookDir))?.chunks.map((c) => c.index)) //
      .toEqual([2, 5, 9])
  })

  it('leaves no temp files behind', async () => {
    const writer = createContentWriter(bookDir)
    writer.add(chunk(0))
    await writer.flush()

    expect(await fs.readdir(bookDir)).toEqual(['content.json'])
  })
})
