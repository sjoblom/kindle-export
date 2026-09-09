import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk, ContentStore } from './types'
import { tryReadJsonFile } from './utils'

/**
 * The one place that reads and writes a book's `content.json`.
 *
 * Two things go wrong when every caller opens the file itself.
 *
 * The first is staleness. Re-capturing a book replaces every page image, so
 * text read from the previous set is no longer text from this book's pages —
 * but a bare list of chunks keyed by page index looks equally valid against
 * either capture. The file therefore records which capture it was read from,
 * and everyone who reuses it has to check, not just the transcriber.
 *
 * The second is durability. OCR is slow and, with OpenAI, paid, so pages are
 * saved as they finish rather than in one write at the end — which only works
 * if the writes are serialized and atomic.
 */

const CONTENT_FILE = 'content.json'

/** Longest a finished page waits before it is on disk. */
const WRITE_DEBOUNCE_MS = 250

/** Completions that force a save regardless of the debounce. */
const WRITE_EVERY_COMPLETIONS = 16

export function contentPath(bookDir: string): string {
  return path.join(bookDir, CONTENT_FILE)
}

/**
 * Read a book's transcription.
 *
 * Books transcribed before captures had an identity stored a bare array. Those
 * still load; they just can't say which capture they came from, which
 * `selectReusableChunks` handles.
 */
export async function readContentStore(
  bookDir: string
): Promise<ContentStore | undefined> {
  const raw = await tryReadJsonFile<ContentStore | ContentChunk[]>(
    contentPath(bookDir)
  )
  if (!raw) return

  if (Array.isArray(raw)) return { chunks: raw }
  if (!Array.isArray(raw.chunks)) return

  return { captureId: raw.captureId, chunks: raw.chunks }
}

/** The chunks alone, for callers that only render finished text. */
export async function readContentChunks(
  bookDir: string
): Promise<ContentChunk[] | undefined> {
  return (await readContentStore(bookDir))?.chunks
}

let tempFileCounter = 0

/**
 * Replace `content.json` in one step.
 *
 * The temp file lives in the book directory so the rename stays on one
 * filesystem and is therefore atomic: a Ctrl+C mid-save leaves the previous
 * transcription intact rather than a truncated file that parses as nothing.
 */
export async function writeContentStore(
  bookDir: string,
  store: ContentStore
): Promise<void> {
  const target = contentPath(bookDir)
  const temp = path.join(
    bookDir,
    `.${CONTENT_FILE}.${process.pid}.${tempFileCounter++}.tmp`
  )

  try {
    await fs.writeFile(temp, JSON.stringify(store, null, 2))
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Drop a book's transcription because the pages it describes are gone.
 *
 * Called when a capture is replaced. The capture id would catch the mismatch
 * anyway, but leaving text on disk that provably belongs to nothing invites
 * some future reader to trust it.
 */
export async function invalidateContent(bookDir: string): Promise<void> {
  await fs.rm(contentPath(bookDir), { force: true })
}

/**
 * The chunks of `store` that are genuinely text from `metadata`'s pages.
 *
 * Everything else is dropped, so a caller can treat the result as "what this
 * run does not have to read again" without checking anything itself.
 */
export function selectReusableChunks(
  store: ContentStore | undefined,
  metadata: Pick<BookMetadata, 'pages' | 'captureId'>
): ContentChunk[] {
  if (!store?.chunks?.length) return []
  const { chunks } = store

  const pageByIndex = new Map(
    (metadata.pages ?? []).map((page) => [page.index, page.page])
  )
  const belongs = (chunk: ContentChunk | undefined): boolean =>
    typeof chunk?.index === 'number' &&
    pageByIndex.get(chunk.index) === chunk.page

  if (metadata.captureId && store.captureId) {
    // Both sides know which capture they came from, so the answer is exact.
    if (metadata.captureId !== store.captureId) return []
  } else if (!chunks.every((chunk) => belongs(chunk))) {
    // One side predates capture ids, so fall back to what can be observed:
    // text covering pages this capture doesn't have is clearly from a
    // different one. Text that lines up may or may not be, and re-reading a
    // whole book on a maybe is the more expensive mistake.
    return []
  }

  const seen = new Set<number>()
  const reusable: ContentChunk[] = []
  for (const chunk of chunks) {
    if (!belongs(chunk) || seen.has(chunk.index)) continue
    // A blank page reads as an empty string, which is a real answer worth
    // keeping. A chunk with no text field at all is junk and gets read again.
    if (typeof chunk.text !== 'string') continue

    seen.add(chunk.index)
    reusable.push(chunk)
  }

  return reusable.toSorted((a, b) => a.index - b.index)
}

export interface ContentWriter {
  /** Record a finished page. Saving it is coalesced, never interleaved. */
  add(chunk: ContentChunk): void
  /** Everything recorded so far, in page order. */
  chunks(): ContentChunk[]
  /** Save everything recorded so far and wait for it to land. */
  flush(): Promise<void>
}

export interface ContentWriterOptions {
  /** The capture the text is being read from, stamped into every save. */
  captureId?: string
  /** Chunks kept from a previous run, so a save is never a partial book. */
  chunks?: ContentChunk[]
}

/**
 * A serialized, debounced, atomic writer for one book's `content.json`.
 *
 * Transcription reads pages in parallel and used to hold every result in
 * memory until the last one landed, so a Ctrl+C an hour in threw away an
 * hour of paid work. Each finished page now goes through here instead. All
 * saves run on a single promise chain, which is what keeps two workers from
 * writing two different snapshots of the same file at once.
 */
export function createContentWriter(
  bookDir: string,
  { captureId, chunks: initial = [] }: ContentWriterOptions = {}
): ContentWriter {
  const byIndex = new Map(initial.map((chunk) => [chunk.index, chunk]))
  // The first flush always writes, so even a run with nothing to do leaves the
  // file in the current shape rather than an older one.
  let dirty = true
  let sinceWrite = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<void> = Promise.resolve()
  let failure: unknown

  function snapshot(): ContentChunk[] {
    return [...byIndex.values()].toSorted((a, b) => a.index - b.index)
  }

  function cancelTimer(): void {
    if (!timer) return

    clearTimeout(timer)
    timer = undefined
  }

  function enqueue(): Promise<void> {
    queue = queue.then(async () => {
      if (!dirty) return

      dirty = false
      sinceWrite = 0

      try {
        await writeContentStore(bookDir, { captureId, chunks: snapshot() })
      } catch (err) {
        // Losing an intermediate save is survivable — the pages are still in
        // memory for the next one — so the run continues and `flush` reports
        // it. The chain itself never rejects, or a later save would inherit it.
        dirty = true
        failure = err
      }
    })

    return queue
  }

  function schedule(): void {
    if (timer) return

    timer = setTimeout(() => {
      timer = undefined
      void enqueue()
    }, WRITE_DEBOUNCE_MS)
    // A pending save must not be why the process refuses to exit.
    timer.unref?.()
  }

  return {
    add(chunk) {
      byIndex.set(chunk.index, chunk)
      dirty = true

      // A burst of fast pages would otherwise sit behind the debounce
      // indefinitely, each new one pushing the save further out.
      if (++sinceWrite >= WRITE_EVERY_COMPLETIONS) {
        cancelTimer()
        void enqueue()
        return
      }

      schedule()
    },

    chunks: snapshot,

    async flush() {
      cancelTimer()
      failure = undefined
      await enqueue()
      if (failure) throw failure
    }
  }
}
