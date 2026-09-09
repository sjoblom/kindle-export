import { describe, expect, it } from 'vitest'

import type { BookMetadata, CaptureStatus, ContentStore } from './types'
import { bookCompleteness, describeIncompleteCapture } from './capture-status'

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

  it('names the exact command when it knows which book it is', () => {
    // The web app's button says "capture again"; someone in a terminal needs
    // the same instruction spelled as something they can run.
    const lines = describeIncompleteCapture(book(), 'B01H4G2J1U')

    expect(lines![1]).toContain('capture it again')
    expect(lines![1]).toContain('kindle-export B01H4G2J1U --force-capture')
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

/** A finished capture of `pages` pages, identified as capture `id`. */
function captured(pages: number, id = 'capture-1'): BookMetadata {
  return {
    captureId: id,
    capture: {
      complete: true,
      reason: 'end-of-book',
      lastPage: pages,
      totalContentPages: pages
    },
    pages: Array.from({ length: pages }, (_, index) => ({
      index,
      page: index + 1,
      screenshot: `pages/${index}.png`
    }))
  } as BookMetadata
}

/** Text for the first `pages` pages, stamped with the capture it came from. */
function transcription(pages: number, id = 'capture-1'): ContentStore {
  return {
    captureId: id,
    chunks: Array.from({ length: pages }, (_, index) => ({
      index,
      page: index + 1,
      text: 'words',
      screenshot: `pages/${index}.png`
    }))
  }
}

describe('bookCompleteness', () => {
  it('is complete when every captured page has text', () => {
    const completeness = bookCompleteness({
      metadata: captured(3),
      content: transcription(3)
    })

    expect(completeness).toMatchObject({
      complete: true,
      capturedPages: 3,
      transcribedPages: 3,
      missingPages: [],
      captureStoppedEarly: false
    })
    expect(completeness.remedy).toBeUndefined()
    expect(completeness.summary).toBeUndefined()
    expect(completeness.warnings).toEqual([])
  })

  it('asks for a fresh capture when the capture stopped early', () => {
    // The pages that exist are all transcribed, so nothing about the text is
    // wrong — the book is simply not all there, and only capturing it again
    // can fix that.
    const metadata = captured(2)
    metadata.capture = {
      complete: false,
      reason: 'navigation-failed',
      lastPage: 2,
      totalContentPages: 10
    }

    const completeness = bookCompleteness({
      metadata,
      content: transcription(2),
      asin: 'B00TEST'
    })

    expect(completeness.complete).toBe(false)
    expect(completeness.captureStoppedEarly).toBe(true)
    expect(completeness.remedy).toBe('capture-again')
    expect(completeness.summary).toBe(
      'Stopped at page 2 of 10 — capture it again to get the rest.'
    )
    expect(completeness.warnings.join(' ')).toContain(
      'kindle-export B00TEST --force-capture'
    )
  })

  it('asks for another reading pass when pages have no text', () => {
    const completeness = bookCompleteness({
      metadata: captured(5),
      content: transcription(3),
      asin: 'B00TEST'
    })

    expect(completeness).toMatchObject({
      complete: false,
      capturedPages: 5,
      transcribedPages: 3,
      captureStoppedEarly: false,
      remedy: 'transcribe-again'
    })
    // Identified the way the book identifies them, so a caller can say which
    // pages rather than only how many.
    expect(completeness.missingPages).toEqual([
      { index: 3, page: 4 },
      { index: 4, page: 5 }
    ])
    expect(completeness.summary).toContain('2 of 5 pages could not be read')
    expect(completeness.warnings.join(' ')).toContain('kindle-export B00TEST')
  })

  it('treats text from a previous capture as no text at all', () => {
    // Chunks from an earlier capture of the same book count to exactly the
    // same number and describe different pages; counting them would report a
    // book as finished when none of its pages have been read.
    const completeness = bookCompleteness({
      metadata: captured(3, 'capture-2'),
      content: transcription(3, 'capture-1')
    })

    expect(completeness.complete).toBe(false)
    expect(completeness.transcribedPages).toBe(0)
    expect(completeness.missingPages).toHaveLength(3)
    expect(completeness.remedy).toBe('transcribe-again')
  })

  it('leaves books captured before the marker existed alone', () => {
    // No capture block means an older version wrote it. Nothing can be said
    // about where it stopped, and demanding a re-capture of a whole library on
    // an upgrade is the worse mistake.
    const metadata = captured(2)
    delete metadata.capture
    delete metadata.captureId

    const completeness = bookCompleteness({
      metadata,
      content: { chunks: transcription(2).chunks }
    })

    expect(completeness.complete).toBe(true)
    expect(completeness.captureStoppedEarly).toBe(false)
    expect(completeness.warnings).toEqual([])
  })

  it('says nothing about a book with nothing on disk', () => {
    // A folder holding only an old export: there is no capture to judge, so
    // inventing a complaint would badge a finished book as broken.
    expect(bookCompleteness({})).toMatchObject({
      complete: true,
      capturedPages: 0,
      transcribedPages: 0,
      missingPages: [],
      warnings: []
    })
  })
})
