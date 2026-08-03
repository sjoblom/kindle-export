import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Reclaiming disk space from a book's working files.
 *
 * A finished book is three things on disk: the render data Amazon served during
 * capture, the page images, and the transcribed text. Only the last is small.
 * For a corpus of 49 books the split was roughly 1.2G of render data, 943M of
 * page images and 30M of text.
 */

export interface CleanupResult {
  /** Bytes freed. */
  freed: number
  removed: string[]
}

async function directorySize(dir: string): Promise<number> {
  let total = 0

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(full)
    } else {
      const stat = await fs.stat(full).catch(() => undefined)
      total += stat?.size ?? 0
    }
  }

  return total
}

async function removeDirectory(dir: string): Promise<number> {
  const size = await directorySize(dir)
  if (!size) return 0

  await fs.rm(dir, { recursive: true, force: true })
  return size
}

/**
 * Remove the render payloads Amazon served while capturing.
 *
 * These are glyph and layout blobs. The handful of useful files inside them
 * (`location_map.json`, `metadata.json`, `toc.json`) are read during capture
 * and folded into the book's own `metadata.json`, and nothing reads the
 * directory again — a re-capture re-downloads it.
 */
export async function cleanRenderData(
  outDir: string,
  asin: string
): Promise<CleanupResult> {
  const target = path.join(outDir, asin, 'data')
  const freed = await removeDirectory(target)

  return { freed, removed: freed ? [target] : [] }
}

/**
 * Remove the captured page images.
 *
 * Only safe once every page has been transcribed: they are the input to
 * transcription, so deleting them early turns a retry into a re-capture.
 */
export async function cleanPageImages(
  outDir: string,
  asin: string
): Promise<CleanupResult> {
  const target = path.join(outDir, asin, 'pages')
  const freed = await removeDirectory(target)

  return { freed, removed: freed ? [target] : [] }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
