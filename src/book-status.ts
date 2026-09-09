import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata } from './types'
import { describeIncompleteCapture } from './capture-status'
import { readContentChunks } from './content-store'
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
  /** Page images captured (the count survives cleanup; the images may not). */
  capturedPages: number
  /** Lines explaining a capture that stopped before the end of the book. */
  incompleteCapture?: string[]
  /** Pages with transcribed text. */
  transcribedPages: number
  exports: BookExportFile[]
}

/** Pages the finished export is missing, if any. */
export function missingPages(status: BookStatus): number {
  return Math.max(0, status.capturedPages - status.transcribedPages)
}

async function scanBook(
  outDir: string,
  asin: string
): Promise<BookStatus | undefined> {
  const bookDir = path.join(outDir, asin)
  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(bookDir, 'metadata.json')
  )
  const content = await readContentChunks(bookDir)

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

  const capturedPages = metadata?.pages?.length ?? 0
  const transcribedPages = Array.isArray(content) ? content.length : 0
  if (!capturedPages && !transcribedPages && !exports.length) return

  return {
    asin,
    title: metadata?.meta?.title,
    authors: metadata?.meta?.authorList
      ? normalizeAuthors(metadata.meta.authorList)
      : undefined,
    capturedPages,
    incompleteCapture: metadata
      ? describeIncompleteCapture(metadata)
      : undefined,
    transcribedPages,
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
