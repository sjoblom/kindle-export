import type { BookMetadata, CaptureStopReason, ContentStore } from './types'
import { selectReusableChunks } from './content-store'

/**
 * Whether what is on disk for a book is the whole book.
 *
 * Two different things can be missing and they have different remedies, so
 * they are answered together, once, from the files themselves rather than from
 * whichever stages a particular run happened to execute: the capture can have
 * stopped before the end of the book (only a fresh capture fixes that), and
 * captured pages can have no text (reading those pages again fixes that).
 *
 * Every consumer — the pipeline result, the CLI's exit status, the decision to
 * delete page images, the web app's badges — asks this module, so a book can
 * never be "done" in one place and "incomplete" in another.
 */

const CAPTURE_STOP_REASONS: Record<CaptureStopReason, string> = {
  'end-of-book': 'reached the end of the book',
  'past-last-content-page': 'passed the last content page',
  'navigation-failed': 'the reader stopped turning pages',
  'no-page-nav': 'lost track of the page position',
  interrupted: 'the run was interrupted'
}

/** A captured page that has no text, identified as the book identifies it. */
export interface MissingPage {
  index: number
  page: number
}

/**
 * What would make the book whole.
 *
 * `capture-again` throws the pages away and reads the book from the start;
 * `transcribe-again` keeps them and reads only the pages still without text.
 * The web app turns this straight into a button, so the two must not blur.
 */
export type BookRemedy = 'capture-again' | 'transcribe-again'

export interface BookCompleteness {
  /** The capture reached the end and every captured page has text. */
  complete: boolean
  capturedPages: number
  /** Captured pages with text belonging to *this* capture. */
  transcribedPages: number
  /** Captured pages with no such text, in page order. */
  missingPages: MissingPage[]
  /** The capture itself stopped before the end of the book. */
  captureStoppedEarly: boolean
  remedy?: BookRemedy
  /** One sentence for a person: no flags, no file names. Absent if complete. */
  summary?: string
  /** The same for a terminal, ending with the command that fixes it. */
  warnings: string[]
}

/**
 * Explain that a book's captured pages are only part of it, or `undefined` when
 * there's nothing to say.
 *
 * Separate from the reporting so the decision can be tested: a truncated
 * capture is indistinguishable from a short book once it's on disk, and getting
 * this wrong in either direction is expensive. Too strict and every book
 * captured before the marker existed demands a re-capture; too lax and a run
 * that died at chapter 3 exports silently.
 */
export function describeIncompleteCapture(
  metadata: BookMetadata,
  asin?: string
): string[] | undefined {
  const { capture } = metadata
  // No marker at all means the book predates it. Assume it's fine rather than
  // making a whole library re-capture itself on an upgrade.
  if (!capture || capture.complete) return

  // Metadata is read off disk and can come from another version, so don't
  // assume the reason is one this build knows about.
  const reason = CAPTURE_STOP_REASONS[capture.reason] ?? capture.reason

  return [
    `capture is incomplete: stopped at page ${capture.lastPage} of ` +
      `${capture.totalContentPages} because ${reason}`,
    // "Capture again" is what the web app's button says; the flag is the same
    // instruction for someone in a terminal. Naming both keeps a user who is
    // told one of them able to find the other.
    'the rest of the book is missing — capture it again to get it' +
      (asin ? `: kindle-export ${asin} --force-capture` : ' (--force-capture)')
  ]
}

/**
 * Everything anyone needs to know about how finished a book is.
 *
 * `content` is the store as it sits on disk, not a chunk list: text left behind
 * by an *earlier* capture of the same book counts to exactly the same number
 * and describes different pages, so the staleness check belongs here rather
 * than in each caller.
 */
export function bookCompleteness({
  metadata,
  content,
  asin
}: {
  metadata?: BookMetadata
  content?: ContentStore
  asin?: string
}): BookCompleteness {
  const pages = metadata?.pages ?? []
  const chunks = metadata ? selectReusableChunks(content, metadata) : []

  const transcribed = new Set(chunks.map((chunk) => chunk.index))
  const missingPages = pages
    .filter((page) => !transcribed.has(page.index))
    .map(({ index, page }) => ({ index, page }))

  const captureLines = metadata
    ? describeIncompleteCapture(metadata, asin)
    : undefined
  const capture = metadata?.capture
  const captureStoppedEarly = !!captureLines

  const warnings = [...(captureLines ?? [])]
  let summary: string | undefined
  let remedy: BookRemedy | undefined

  if (captureStoppedEarly && capture) {
    remedy = 'capture-again'
    summary =
      `Stopped at page ${capture.lastPage} of ${capture.totalContentPages}` +
      ' — capture it again to get the rest.'
  } else if (missingPages.length) {
    // Only worth saying on its own: when the capture stopped early the pages
    // without text are the least of the book's problems, and re-capturing
    // replaces them anyway.
    remedy = 'transcribe-again'
    summary =
      `${missingPages.length} of ${pages.length} pages could not be read` +
      ' — retry them to fill the gaps.'
    warnings.push(
      `${missingPages.length} of ${pages.length} captured pages have no text`,
      asin
        ? `retry just those pages: kindle-export ${asin}`
        : 'run the book again to retry just those pages'
    )
  }

  return {
    complete: !captureStoppedEarly && !missingPages.length,
    capturedPages: pages.length,
    transcribedPages: chunks.length,
    missingPages,
    captureStoppedEarly,
    remedy,
    summary,
    warnings
  }
}
