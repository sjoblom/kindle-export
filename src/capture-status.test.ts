import { describe, expect, it } from 'vitest'

import type { BookMetadata, CaptureStatus } from './types'
import { describeIncompleteCapture } from './capture-status'

const PAGES = [{ index: 0, page: 1, screenshot: '0.png' }]

/** A book whose capture stopped 120 pages into 480, unless overridden. */
function book(capture: Partial<CaptureStatus> = {}): BookMetadata {
  return {
    pages: PAGES,
    capture: {
      complete: false,
      reason: 'navigation-failed',
      lastPage: 120,
      totalContentPages: 480,
      ...capture
    }
  } as BookMetadata
}

/** A book captured before the completeness marker existed. */
function bookWithoutCaptureMarker(): BookMetadata {
  return { pages: PAGES } as BookMetadata
}

describe('describeIncompleteCapture', () => {
  it('says nothing about a capture that finished', () => {
    expect(
      describeIncompleteCapture(
        book({ complete: true, reason: 'end-of-book', lastPage: 480 })
      )
    ).toBeUndefined()
  })

  it('leaves books captured before the marker existed alone', () => {
    // The upgrade path: metadata written by an older version has no `capture`.
    // Treating that as incomplete would flag every book in an existing library
    // and tell the user to re-capture all of them.
    expect(
      describeIncompleteCapture(bookWithoutCaptureMarker())
    ).toBeUndefined()
  })

  it('reports how far a truncated capture got and why it stopped', () => {
    const lines = describeIncompleteCapture(book())

    expect(lines).toHaveLength(2)
    expect(lines![0]).toContain('page 120 of 480')
    expect(lines![0]).toContain('the reader stopped turning pages')
    expect(lines![1]).toContain('--force-capture')
  })

  it('reports a run that was killed part-way through', () => {
    // Metadata is written after every page, so an interrupted run leaves a
    // book that looks complete apart from this marker.
    const lines = describeIncompleteCapture(book({ reason: 'interrupted' }))

    expect(lines![0]).toContain('the run was interrupted')
  })

  it('falls back to the raw reason it does not recognise', () => {
    // Metadata comes off disk and can be written by another version.
    const lines = describeIncompleteCapture(
      book({ reason: 'something-new' as any })
    )

    expect(lines![0]).toContain('something-new')
    expect(lines![0]).not.toContain('undefined')
  })
})
