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
 * At a genuine end the chevron is usually gone, and that is believed on the
 * first attempt — see `shouldStopCapture` — so these extra attempts only cost
 * time when Kindle leaves a live chevron on the last screen. There, a stalled
 * turn could also be a slow render of one more screen, and a second try is
 * cheaper than truncating the book.
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
 * normally, and each of those screens gets captured. Only a refusal to render
 * anything new ends the book.
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

  const lastAttempt = attempt >= maxAttempts

  // The reader removes the chevron when there's nowhere left to go, but it
  // also drops it briefly mid-render — so a missing chevron only counts once
  // we're out of attempts. On the last numbered page it counts at once: the
  // footer already said to expect the end here, and the two agree.
  if (navigation === 'no-next-page' && (lastAttempt || onLastNumberedPage)) {
    return { type: 'stop', complete: true, reason: 'end-of-book' }
  }

  if (lastAttempt) {
    // Out of attempts with a next-page control still on screen. On the last
    // numbered page that's the end confirming itself: the footer says there is
    // no further page, and the reader won't produce one. Anywhere else it's a
    // reader that stopped responding, and the capture is genuinely truncated.
    return onLastNumberedPage
      ? { type: 'stop', complete: true, reason: 'end-of-book' }
      : { type: 'stop', complete: false, reason: 'navigation-failed' }
  }

  return { type: 'retry-navigation' }
}
