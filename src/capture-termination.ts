import type { CaptureStopReason } from './types'

/**
 * Deciding when a page capture has actually reached the end of the book.
 *
 * Kindle's page numbers are coarse: one numbered page routinely spans several
 * rendered screens, which is exactly why the capture keeps its own screenshot
 * index alongside the footer's page number. That makes the footer a hint about
 * where we are and never proof that there is nothing left to render — the only
 * proof is asking the reader to turn the page and being refused.
 *
 * This lives apart from the browser driving because it's the part that fails
 * silently: stopping one screen early still writes a metadata file that says
 * the book finished, and nothing downstream can tell the difference.
 */

/** What a single page-turn attempt produced. */
export type NavigationResult =
  /** A different page image rendered — the reader moved. */
  | 'navigated'
  /** Nothing rendered, and the reader offers no next-page control. */
  | 'no-next-page'
  /** Nothing rendered, but a next-page control is still sitting there. */
  | 'stalled'

/** What the capture loop should do next. */
export type CaptureAction =
  | { type: 'capture-next-screen' }
  | { type: 'retry-navigation' }
  | { type: 'stop'; complete: boolean; reason: CaptureStopReason }

/** Turn attempts allowed for an ordinary screen before giving up on it. */
export const NAVIGATION_ATTEMPTS = 5

/**
 * Turn attempts spent confirming the end of the book.
 *
 * Two, because the one positive sign of an ending — the chevron being gone —
 * is also what the reader looks like for a moment mid-render. Seeing it gone
 * twice, a few seconds apart, is the confirmation; seeing it once is not. The
 * cost is a few seconds on every finished capture, which is the price of not
 * declaring a book complete on a hunch.
 */
export const END_CONFIRMATION_ATTEMPTS = 2

/** How long a normal page turn is given to render a new image. */
export const NAVIGATION_TIMEOUT_MS = 10_000

/**
 * How long the end-of-book confirmation turn is given.
 *
 * Short on purpose. A real page turn renders in well under a second — the
 * previous screen's image blob has already arrived by the time we get here —
 * so this only has to outlast a slow render, not a stuck reader.
 */
export const END_CONFIRMATION_TIMEOUT_MS = 3000

/** How long to wait after the chevron click itself failed. */
export const CLICK_FAILED_TIMEOUT_MS = 1000

/** How long to spend trying to click the next-page chevron. */
export const NAVIGATION_CLICK_TIMEOUT_MS = 5000

/**
 * The same, while confirming the end of the book.
 *
 * There is usually no chevron left to click there, so this timeout is spent in
 * full on every finished capture — it buys nothing to make it generous.
 */
export const END_CONFIRMATION_CLICK_TIMEOUT_MS = 2000

export interface FooterPosition {
  /** The page (or location) the footer reports, when it reports one. */
  value?: number
  /** The total the footer reports, which is 0 or negative when unknown. */
  total: number
}

/**
 * Whether the footer says we're on the book's last numbered page.
 *
 * "Last numbered page" is not "last screen" — see the module comment — so this
 * only decides how hard to try turning the page, never whether to stop.
 */
export function isOnLastNumberedPage({
  value,
  total
}: FooterPosition): boolean {
  if (value === undefined) return false
  if (!(total > 0)) return false

  return value >= total
}

/** Attempts to allow for one screen. */
export function maxNavigationAttempts(onLastNumberedPage: boolean): number {
  return onLastNumberedPage ? END_CONFIRMATION_ATTEMPTS : NAVIGATION_ATTEMPTS
}

/** How long to spend on the chevron click itself. */
export function chevronClickTimeoutMs(onLastNumberedPage: boolean): number {
  return onLastNumberedPage
    ? END_CONFIRMATION_CLICK_TIMEOUT_MS
    : NAVIGATION_CLICK_TIMEOUT_MS
}

/** How long to wait for a new page image after clicking the chevron. */
export function navigationTimeoutMs({
  onLastNumberedPage,
  clickFailed
}: {
  onLastNumberedPage: boolean
  clickFailed: boolean
}): number {
  if (clickFailed) return CLICK_FAILED_TIMEOUT_MS

  return onLastNumberedPage
    ? END_CONFIRMATION_TIMEOUT_MS
    : NAVIGATION_TIMEOUT_MS
}

export interface BeforeCaptureInput {
  /** Whether the footer could be read at all. */
  hasPageNav: boolean
  /** The page number this screen belongs to. */
  currentPage: number
  /** The last page counted as content; past it is back matter. */
  totalContentPages: number
}

/**
 * Whether to stop before screenshotting the current screen.
 *
 * The page-number check is safe to act on immediately, unlike the footer's
 * "last page" (which the end-of-book decision has to confirm): it fires only
 * once the number has *strictly passed* the last content page, so every screen
 * belonging to that last page has already been captured. A page number in the
 * back matter is a statement about different content, not a coarse boundary we
 * might be standing on.
 */
export function shouldStopBeforeCapture({
  hasPageNav,
  currentPage,
  totalContentPages
}: BeforeCaptureInput): Extract<CaptureAction, { type: 'stop' }> | undefined {
  if (!hasPageNav) {
    // Losing the position mid-book is not an ending; we simply can't tell
    // where we are any more, so the capture is short and says so.
    return { type: 'stop', complete: false, reason: 'no-page-nav' }
  }

  if (totalContentPages > 0 && currentPage > totalContentPages) {
    return { type: 'stop', complete: true, reason: 'past-last-content-page' }
  }
}

export interface NavigationAttemptInput {
  /** What the turn attempt produced. */
  navigation: NavigationResult
  /** Whether the footer reported the book's last page for this screen. */
  onLastNumberedPage: boolean
  /** 1-based count of turn attempts made for this screen. */
  attempt: number
  /** Attempts allowed for this screen, from `maxNavigationAttempts`. */
  maxAttempts: number
}

/**
 * Decide what to do after one page-turn attempt.
 *
 * A successful turn always means "keep capturing", even on the last numbered
 * page — that's the whole point: a last page spanning several screens turns
 * normally, and each of those screens gets captured.
 *
 * Only one thing marks a capture complete: the reader offering no next page,
 * seen on every attempt this screen was given. A reader that still shows a
 * usable next-page control and won't turn to it is a reader that has stopped
 * responding, wherever the footer says we are — the footer counts pages, not
 * screens, so it cannot vouch for the screens after this one. That case is
 * recorded as incomplete, and the person can capture again, rather than as a
 * finished book that is quietly short.
 */
export function shouldStopCapture({
  navigation,
  onLastNumberedPage,
  attempt,
  maxAttempts
}: NavigationAttemptInput): CaptureAction {
  if (navigation === 'navigated') {
    return { type: 'capture-next-screen' }
  }

  if (attempt < maxAttempts) {
    return { type: 'retry-navigation' }
  }

  // The reader removes the chevron when there's nowhere left to go, but it
  // also drops it briefly mid-render — so a missing chevron only counts once
  // it has stayed missing for every attempt.
  if (navigation === 'no-next-page') {
    return { type: 'stop', complete: true, reason: 'end-of-book' }
  }

  return onLastNumberedPage
    ? { type: 'stop', complete: false, reason: 'end-unconfirmed' }
    : { type: 'stop', complete: false, reason: 'navigation-failed' }
}
