import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { missingPages, scanBooks } from './book-status'

let outDir: string

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-test-'))
})

afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true })
})

async function writeBook(
  asin: string,
  {
    pages,
    transcribed,
    files = [],
    capture
  }: {
    pages?: number
    transcribed?: number
    files?: string[]
    capture?: Record<string, unknown>
  }
): Promise<void> {
  const bookDir = path.join(outDir, asin)
  await fs.mkdir(bookDir, { recursive: true })

  if (pages !== undefined) {
    await fs.writeFile(
      path.join(bookDir, 'metadata.json'),
      JSON.stringify({
        meta: { title: `Book ${asin}`, authorList: ['Doe, Jane:'] },
        pages: Array.from({ length: pages }, (_, index) => ({
          index,
          page: index + 1
        })),
        ...(capture ? { capture } : {})
      })
    )
  }

  if (transcribed !== undefined) {
    await fs.writeFile(
      path.join(bookDir, 'content.json'),
      JSON.stringify(
        Array.from({ length: transcribed }, (_, index) => ({
          index,
          page: index + 1,
          text: 'words'
        }))
      )
    )
  }

  for (const file of files) {
    await fs.writeFile(path.join(bookDir, file), 'x')
  }
}

describe('scanBooks', () => {
  it('returns nothing for a missing or empty output directory', async () => {
    expect(await scanBooks(path.join(outDir, 'nope'))).toEqual([])
    expect(await scanBooks(outDir)).toEqual([])
  })

  it('reports captured and transcribed counts', async () => {
    await writeBook('B001', { pages: 3, transcribed: 2 })

    const [book] = await scanBooks(outDir)
    expect(book).toMatchObject({
      asin: 'B001',
      title: 'Book B001',
      authors: ['Jane Doe'],
      capturedPages: 3,
      transcribedPages: 2
    })
    expect(missingPages(book!)).toBe(1)
  })

  it('lists exported files with their formats', async () => {
    await writeBook('B002', {
      pages: 2,
      transcribed: 2,
      files: ['my-book.md', 'book.pdf', 'notes.txt']
    })

    const [book] = await scanBooks(outDir)
    expect(book!.exports.map((file) => file.name)).toEqual([
      'book.pdf',
      'my-book.md'
    ])
    expect(book!.exports.map((file) => file.format)).toEqual(['pdf', 'md'])
  })

  it('carries the incomplete-capture explanation through', async () => {
    await writeBook('B003', {
      pages: 5,
      capture: {
        complete: false,
        reason: 'navigation-failed',
        lastPage: 5,
        totalContentPages: 300
      }
    })

    const [book] = await scanBooks(outDir)
    expect(book!.incompleteCapture?.[0]).toMatch(/stopped at page 5 of 300/)
  })

  it('skips hidden directories and books with nothing in them', async () => {
    await fs.mkdir(path.join(outDir, '.browser-profile'), { recursive: true })
    await fs.mkdir(path.join(outDir, 'B004'), { recursive: true })
    await writeBook('B005', { pages: 1 })

    const books = await scanBooks(outDir)
    expect(books.map((book) => book.asin)).toEqual(['B005'])
  })

  it('survives unreadable metadata rather than dropping the book', async () => {
    const bookDir = path.join(outDir, 'B006')
    await fs.mkdir(bookDir, { recursive: true })
    await fs.writeFile(path.join(bookDir, 'metadata.json'), 'not json{')
    await fs.writeFile(path.join(bookDir, 'the-book.md'), 'text')

    const [book] = await scanBooks(outDir)
    expect(book).toMatchObject({
      asin: 'B006',
      capturedPages: 0,
      transcribedPages: 0
    })
    expect(book!.exports).toHaveLength(1)
  })
})
