import type { BookMetadata, CaptureStopReason } from './types'

const CAPTURE_STOP_REASONS: Record<CaptureStopReason, string> = {
  'end-of-book': 'reached the end of the book',
  'past-last-content-page': 'passed the last content page',
  'navigation-failed': 'the reader stopped turning pages',
  'no-page-nav': 'lost track of the page position',
  interrupted: 'the run was interrupted'
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
  metadata: BookMetadata
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
    'the rest of the book is missing — re-run with --force-capture to start over'
  ]
}
