import { describe, expect, it } from 'vitest'

import {
  chevronClickTimeoutMs,
  CLICK_FAILED_TIMEOUT_MS,
  END_CONFIRMATION_ATTEMPTS,
  END_CONFIRMATION_CLICK_TIMEOUT_MS,
  END_CONFIRMATION_MAX_ATTEMPTS,
  END_CONFIRMATION_TIMEOUT_MS,
  isOnLastNumberedPage,
  maxNavigationAttempts,
  NAVIGATION_ATTEMPTS,
  NAVIGATION_CLICK_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  type NavigationResult,
  navigationTimeoutMs,
  shouldStopBeforeCapture,
  shouldStopCapture
} from './capture-termination'

describe('isOnLastNumberedPage', () => {
  it('recognises the footer reporting the final page', () => {
    expect(isOnLastNumberedPage({ value: 145, total: 145 })).toBe(true)
    // Footers occasionally overshoot their own total in back matter.
    expect(isOnLastNumberedPage({ value: 146, total: 145 })).toBe(true)
  })

  it('is false mid-book, and whenever the footer is unusable', () => {
    expect(isOnLastNumberedPage({ value: 144, total: 145 })).toBe(false)
    expect(isOnLastNumberedPage({ value: undefined, total: 145 })).toBe(false)
    // A book whose footer reports locations can have no total at all; that is
    // not a reason to believe we're at the end.
    expect(isOnLastNumberedPage({ value: 8000, total: 0 })).toBe(false)
  })
})

describe('shouldStopCapture: a last numbered page spanning several screens', () => {
  const onLastNumberedPage = true
  const maxAttempts = maxNavigationAttempts(onLastNumberedPage)
  const decide = (observations: NavigationResult[]) =>
    shouldStopCapture({ observations, onLastNumberedPage, maxAttempts })

  it('keeps capturing while the reader still turns the page', () => {
    // The regression this exists for: page 145 of 145 covers three screens.
    // The footer reads "145 of 145" on all three, and stopping on the first
    // one silently dropped two screens while claiming the book was complete.
    expect(decide(['navigated'])).toEqual({ type: 'capture-next-screen' })
    expect(decide(['stalled', 'navigated'])).toEqual({
      type: 'capture-next-screen'
    })
  })

  it('declares the end only once the chevron has stayed gone', () => {
    // The chevron vanishes briefly mid-render too, so one sighting is a hint
    // and the second, a few seconds later, is the confirmation.
    expect(decide(['no-next-page'])).toEqual({ type: 'retry-navigation' })
    expect(decide(['no-next-page', 'no-next-page'])).toEqual({
      type: 'stop',
      complete: true,
      reason: 'end-of-book'
    })
  })

  it('still confirms an end that a single stalled render preceded', () => {
    expect(decide(['stalled', 'no-next-page'])).toEqual({
      type: 'retry-navigation'
    })
    expect(decide(['stalled', 'no-next-page', 'no-next-page'])).toEqual({
      type: 'stop',
      complete: true,
      reason: 'end-of-book'
    })
  })

  it('does not count an absence that a usable chevron interrupted', () => {
    // Gone, back, gone: the first absence was the render, so the last one is
    // a single sighting again — and the budget is spent.
    expect(decide(['no-next-page', 'stalled', 'no-next-page'])).toEqual({
      type: 'stop',
      complete: false,
      reason: 'end-unconfirmed'
    })
  })

  it('never calls a stalled reader on the final page a finished book', () => {
    expect(decide(['stalled'])).toEqual({ type: 'retry-navigation' })
    expect(decide(['stalled', 'stalled'])).toEqual({
      type: 'retry-navigation'
    })

    // A usable next-page control is still on screen and the reader would not
    // turn to it. The footer counts pages, not screens, so it cannot say the
    // screens after this one don't exist; the honest record is "unconfirmed",
    // which the person can resolve by capturing again.
    expect(decide(['stalled', 'stalled', 'stalled'])).toEqual({
      type: 'stop',
      complete: false,
      reason: 'end-unconfirmed'
    })
    // The single absence at the very end is one sighting, not a confirmation.
    expect(decide(['stalled', 'stalled', 'no-next-page'])).toEqual({
      type: 'stop',
      complete: false,
      reason: 'end-unconfirmed'
    })
    expect(decide(['stalled', 'no-next-page', 'stalled'])).toEqual({
      type: 'stop',
      complete: false,
      reason: 'end-unconfirmed'
    })
  })
})

const stalls = (n: number): NavigationResult[] =>
  Array.from({ length: n }, () => 'stalled')

describe('shouldStopCapture: mid-book', () => {
  const onLastNumberedPage = false
  const maxAttempts = maxNavigationAttempts(onLastNumberedPage)
  const decide = (observations: NavigationResult[]) =>
    shouldStopCapture({ observations, onLastNumberedPage, maxAttempts })

  it('retries a stalled turn until the attempts run out', () => {
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      expect(decide(stalls(attempt))).toEqual({ type: 'retry-navigation' })
    }

    expect(decide(stalls(maxAttempts))).toEqual({
      type: 'stop',
      complete: false,
      reason: 'navigation-failed'
    })
  })

  it('retries a briefly missing chevron rather than calling it the end', () => {
    // Kindle drops the chevron mid-render. Believing it the first time would
    // mark a book complete in the middle of a chapter.
    expect(decide(['no-next-page'])).toEqual({ type: 'retry-navigation' })
    expect(decide(['no-next-page', 'no-next-page'])).toEqual({
      type: 'retry-navigation'
    })
  })

  it('accepts a chevron that has stayed missing through the last attempts', () => {
    // Books whose footer never reports the final page end here instead.
    expect(
      decide([...stalls(maxAttempts - 2), 'no-next-page', 'no-next-page'])
    ).toEqual({ type: 'stop', complete: true, reason: 'end-of-book' })
  })

  it('does not accept a chevron missing only on the final attempt', () => {
    expect(decide([...stalls(maxAttempts - 1), 'no-next-page'])).toEqual({
      type: 'stop',
      complete: false,
      reason: 'navigation-failed'
    })
    expect(
      decide([
        ...stalls(maxAttempts - 3),
        'no-next-page',
        'stalled',
        'no-next-page'
      ])
    ).toEqual({ type: 'stop', complete: false, reason: 'navigation-failed' })
  })

  it('carries on as soon as a turn lands', () => {
    expect(decide([...stalls(2), 'navigated'])).toEqual({
      type: 'capture-next-screen'
    })
  })
})

describe('shouldStopBeforeCapture', () => {
  it('captures an ordinary content page', () => {
    expect(
      shouldStopBeforeCapture({
        hasPageNav: true,
        currentPage: 12,
        totalContentPages: 480
      })
    ).toBeUndefined()
  })

  it('captures every screen of the last content page', () => {
    // The check is `>`, not `>=`: page 480 of 480 may span several screens and
    // all of them are content.
    expect(
      shouldStopBeforeCapture({
        hasPageNav: true,
        currentPage: 480,
        totalContentPages: 480
      })
    ).toBeUndefined()
  })

  it('stops, complete, once the page number is into the back matter', () => {
    expect(
      shouldStopBeforeCapture({
        hasPageNav: true,
        currentPage: 481,
        totalContentPages: 480
      })
    ).toEqual({
      type: 'stop',
      complete: true,
      reason: 'past-last-content-page'
    })
  })

  it('stops, incomplete, when the position becomes unreadable', () => {
    expect(
      shouldStopBeforeCapture({
        hasPageNav: false,
        currentPage: 3,
        totalContentPages: 480
      })
    ).toEqual({ type: 'stop', complete: false, reason: 'no-page-nav' })
  })
})

describe('navigation budgets', () => {
  it('spends a few short attempts confirming the end of the book', () => {
    // (b) of the fix: a finished book must not cost 5 × 10s to notice.
    expect(maxNavigationAttempts(true)).toBe(END_CONFIRMATION_MAX_ATTEMPTS)
    expect(END_CONFIRMATION_MAX_ATTEMPTS).toBeLessThan(NAVIGATION_ATTEMPTS)
    // ...but a confirmation needs more than one sighting, and the budget has
    // to leave room for it.
    expect(END_CONFIRMATION_ATTEMPTS).toBeGreaterThan(1)
    expect(END_CONFIRMATION_MAX_ATTEMPTS).toBeGreaterThan(
      END_CONFIRMATION_ATTEMPTS
    )
    expect(
      navigationTimeoutMs({ onLastNumberedPage: true, clickFailed: false })
    ).toBe(END_CONFIRMATION_TIMEOUT_MS)
    expect(END_CONFIRMATION_TIMEOUT_MS).toBeLessThan(NAVIGATION_TIMEOUT_MS)
    // The click itself is part of that cost: at the end there's usually no
    // chevron, so this timeout is always spent in full.
    expect(chevronClickTimeoutMs(true)).toBe(END_CONFIRMATION_CLICK_TIMEOUT_MS)
    expect(END_CONFIRMATION_CLICK_TIMEOUT_MS).toBeLessThan(
      NAVIGATION_CLICK_TIMEOUT_MS
    )
  })

  it('gives an ordinary page turn the full budget', () => {
    expect(maxNavigationAttempts(false)).toBe(NAVIGATION_ATTEMPTS)
    expect(
      navigationTimeoutMs({ onLastNumberedPage: false, clickFailed: false })
    ).toBe(NAVIGATION_TIMEOUT_MS)
    expect(chevronClickTimeoutMs(false)).toBe(NAVIGATION_CLICK_TIMEOUT_MS)
  })

  it('waits only briefly when the click itself never landed', () => {
    for (const onLastNumberedPage of [true, false]) {
      expect(
        navigationTimeoutMs({ onLastNumberedPage, clickFailed: true })
      ).toBe(CLICK_FAILED_TIMEOUT_MS)
    }
  })
})
