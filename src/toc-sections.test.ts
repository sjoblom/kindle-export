import { describe, expect, it } from 'vitest'

import type { ContentChunk, TocItem } from './types'
import { resolveBookSections, resolveTocStartIndices } from './toc-sections'

function content(
  ...pages: Array<[page: number, text: string]>
): ContentChunk[] {
  return pages.map(([page, text], index) => ({
    index,
    page,
    text,
    screenshot: `page-${page}.png`
  }))
}

function toc(...items: Array<[label: string, page: number]>): TocItem[] {
  return items.map(([label, page], i) => ({
    label,
    page,
    positionId: i,
    depth: 0
  })) as TocItem[]
}

describe('resolveTocStartIndices', () => {
  it('separates entries that all report the same page', () => {
    const chunks = content(
      [1, 'THE MOM TEST\nROB FITZPATRICK'],
      [1, 'CONTENTS\nIntroduction'],
      [1, 'INTRODUCTION\nTrying to learn from customers.'],
      [1, 'CHAPTER 1\nTHE MOM TEST\nPeople say you shouldn’t ask.'],
      [16, 'AVOIDING BAD DATA\nThere are three types.']
    )

    expect(
      resolveTocStartIndices(
        toc(
          ['Title Page', 1],
          ['Contents', 1],
          ['Introduction', 1],
          ['1. The Mom Test', 1],
          ['2. Avoiding bad data', 16]
        ),
        chunks
      )
    ).toEqual([0, 1, 2, 3, 4])
  })

  it('finds a chapter heading that falls before its declared page', () => {
    const chunks = content(
      [1, 'Intro body.'],
      [2, 'End of intro.\nCHAPTER 2\nAVOIDING BAD DATA'],
      [3, 'There are three types of bad data.']
    )

    expect(
      resolveTocStartIndices(
        toc(['Introduction', 1], ['2. Avoiding bad data', 3]),
        chunks
      )
    ).toEqual([0, 1])
  })

  it('falls back to the page boundary when the label is absent', () => {
    const chunks = content([1, 'Intro body.'], [5, 'Chapter body.'])

    expect(
      resolveTocStartIndices(
        toc(['Introduction', 1], ['Some Untitled Section', 5]),
        chunks
      )
    ).toEqual([0, 1])
  })

  it('ignores in-text cross references to a chapter title', () => {
    const chunks = content(
      [1, 'As we saw in Avoiding bad data, people lie.'],
      [5, 'AVOIDING BAD DATA\nThere are three types.']
    )

    expect(
      resolveTocStartIndices(
        toc(['Introduction', 1], ['Avoiding bad data', 5]),
        chunks
      )
    ).toEqual([0, 1])
  })

  it('matches on labels alone when TOC pages use a different scale', () => {
    // TOC numbered in Kindle locations, chunks numbered in reader pages.
    const chunks = content(
      [1, 'COVER'],
      [2, 'DEDICATION\nFor someone.'],
      [3, 'INTRODUCTION\nBody text.'],
      [4, 'More body text.']
    )

    expect(
      resolveTocStartIndices(
        toc(['Cover', 1], ['Dedication', 240], ['Introduction', 770]),
        chunks
      )
    ).toEqual([0, 1, 2])
  })

  it('does not let one stray late match starve the entries after it', () => {
    // "Overview" only appears late, in the closing summary. Taking that match
    // greedily would push every later chapter past it and lose all of them.
    const chunks = content(
      [1, 'OVERVIEW\nOpening remarks.'],
      [2, 'CHAPTER ONE\nBody.'],
      [3, 'CHAPTER TWO\nBody.'],
      [4, 'CHAPTER THREE\nBody.'],
      [5, 'OVERVIEW\nClosing summary.']
    )

    expect(
      resolveTocStartIndices(
        toc(
          ['Overview', 1],
          ['Chapter One', 1],
          ['Chapter Two', 1],
          ['Chapter Three', 1]
        ),
        chunks
      )
    ).toEqual([0, 1, 2, 3])
  })

  it('drops entries with no room left', () => {
    const chunks = content([1, 'Only chunk.'])

    expect(
      resolveTocStartIndices(
        toc(['Introduction', 1], ['Nothing Here', 1], ['Nor Here', 1]),
        chunks
      )
    ).toEqual([0, undefined, undefined])
  })

  it('skips entries with no page', () => {
    const chunks = content([1, 'Body.'], [2, 'CHAPTER TWO\nMore.'])
    const items: TocItem[] = [
      { label: 'Introduction', page: 1, positionId: 0, depth: 0 },
      { label: 'Unmapped', location: 42, positionId: 1, depth: 0 },
      { label: 'Chapter Two', page: 2, positionId: 2, depth: 0 }
    ] as TocItem[]

    expect(resolveTocStartIndices(items, chunks)).toEqual([0, undefined, 1])
  })
})

describe('resolveBookSections', () => {
  it('covers every chunk exactly once', () => {
    const chunks = content(
      [1, 'THE MOM TEST'],
      [1, 'INTRODUCTION\nIntro body.'],
      [16, 'AVOIDING BAD DATA\nChapter body.'],
      [20, 'More chapter body.']
    )

    const sections = resolveBookSections(
      toc(['Title Page', 1], ['Introduction', 1], ['2. Avoiding bad data', 16]),
      chunks
    )

    expect(sections.map((s) => s.tocItem.label)).toEqual([
      'Title Page',
      'Introduction',
      '2. Avoiding bad data'
    ])
    expect(sections.map((s) => s.chunks.length)).toEqual([1, 1, 2])
    expect(sections.flatMap((s) => s.chunks)).toHaveLength(chunks.length)
  })

  it('extends the first section back to the start of the book', () => {
    const chunks = content([1, 'Front matter.'], [1, 'INTRODUCTION\nBody.'])

    const sections = resolveBookSections(toc(['Introduction', 1]), chunks)

    expect(sections).toHaveLength(1)
    expect(sections[0]!.chunks).toHaveLength(2)
  })

  it('exposes the next section label', () => {
    const chunks = content(
      [1, 'INTRODUCTION\nBody.'],
      [5, 'CHAPTER ONE\nBody.']
    )

    const sections = resolveBookSections(
      toc(['Introduction', 1], ['Chapter One', 5]),
      chunks
    )

    expect(sections[0]!.nextLabel).toBe('Chapter One')
    expect(sections[1]!.nextLabel).toBeUndefined()
  })

  it('drops back matter that sits past the last captured page', () => {
    const chunks = content(
      [1, 'INTRODUCTION\nBody.'],
      [5, 'CHAPTER ONE\nBody.']
    )

    const sections = resolveBookSections(
      toc(['Introduction', 1], ['Chapter One', 5], ['Index', 90]),
      chunks
    )

    expect(sections.map((s) => s.tocItem.label)).toEqual([
      'Introduction',
      'Chapter One'
    ])
    expect(sections.at(-1)!.nextLabel).toBeUndefined()
  })

  it('returns nothing when no entry resolves', () => {
    expect(resolveBookSections([], content([1, 'Body.']))).toEqual([])
  })
})
