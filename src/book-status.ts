import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata } from './types'
import { type BookCompleteness, bookCompleteness } from './capture-status'
import { readContentStore } from './content-store'
import { normalizeAuthors, tryReadJsonFile } from './utils'

/**
 * What's on disk for each book, read without touching the network.
 *
 * The web app shows the library with badges — exported, partial, in the
 * middle of transcription — and offers downloads for finished books. All of
 * that is derivable from the files the pipeline leaves behind, so this scans
 * rather than keeping separate state that could drift.
 */

export interface BookExportFile {
  name: string
  format: 'md' | 'pdf'
  size: number
  mtimeMs: number
}

export interface BookStatus {
  asin: string
  title?: string
  authors?: string[]
  /**
   * How much of the book is actually on disk, and what would fix it if the
   * answer is "not all of it". The same check the pipeline and CLI use, so a
   * badge here can never disagree with what an export just said.
   */
  completeness: BookCompleteness
  exports: BookExportFile[]
}

async function scanBook(
  outDir: string,
  asin: string
): Promise<BookStatus | undefined> {
  const bookDir = path.join(outDir, asin)
  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(bookDir, 'metadata.json')
  )
  const content = await readContentStore(bookDir)

  const exports: BookExportFile[] = []
  const entries = await fs
    .readdir(bookDir, { withFileTypes: true })
    .catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const format = entry.name.endsWith('.md')
      ? ('md' as const)
      : entry.name.endsWith('.pdf')
        ? ('pdf' as const)
        : undefined
    if (!format) continue

    const stat = await fs
      .stat(path.join(bookDir, entry.name))
      .catch(() => undefined)
    if (!stat) continue

    exports.push({
      name: entry.name,
      format,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
  }

  // No asin: these lines are read in a browser, where the remedy is a button
  // rather than a command to type.
  const completeness = bookCompleteness({ metadata, content })
  if (
    !completeness.capturedPages &&
    !completeness.transcribedPages &&
    !exports.length
  ) {
    return
  }

  return {
    asin,
    title: metadata?.meta?.title,
    authors: metadata?.meta?.authorList
      ? normalizeAuthors(metadata.meta.authorList)
      : undefined,
    completeness,
    exports: exports.toSorted((a, b) => a.name.localeCompare(b.name))
  }
}

/** Every book with any pipeline output under `outDir`, keyed by ASIN. */
export async function scanBooks(outDir: string): Promise<BookStatus[]> {
  const entries = await fs
    .readdir(outDir, { withFileTypes: true })
    .catch(() => [])

  const statuses: BookStatus[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue

    const status = await scanBook(outDir, entry.name)
    if (status) statuses.push(status)
  }

  return statuses.toSorted((a, b) => a.asin.localeCompare(b.asin))
}
