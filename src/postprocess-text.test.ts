import { describe, expect, it } from 'vitest'

import type { ContentChunk } from './types'
import sharedCases from './postprocess-cases.json'
import {
  continuesParagraph,
  formatContentChunks,
  isHeadingLine
} from './postprocess-text'

function chunks(...pages: Array<[page: number, text: string]>): ContentChunk[] {
  return pages.map(([page, text], index) => ({
    index,
    page,
    text,
    screenshot: `page-${page}.png`
  }))
}

describe('isHeadingLine', () => {
  it('accepts all-caps section headings', () => {
    expect(isHeadingLine('FAILING THE MOM TEST')).toBe(true)
    expect(isHeadingLine('WHY ANOTHER BOOK ON TALKING AND SELLING?')).toBe(true)
    expect(isHeadingLine('CHAPTER 1')).toBe(true)
    expect(isHeadingLine('A NOTE ON SCOPE & TERMINOLOGY')).toBe(true)
  })

  it('rejects prose, fragments and separators', () => {
    expect(isHeadingLine('People say you shouldn’t ask your mom.')).toBe(false)
    expect(isHeadingLine('THE MOM TEST is a set of simple rules.')).toBe(false)
    expect(isHeadingLine('MOM,')).toBe(false)
    expect(isHeadingLine('1984')).toBe(false)
    expect(isHeadingLine('* * *')).toBe(false)
    expect(isHeadingLine('I')).toBe(false)
    expect(isHeadingLine('A'.repeat(80))).toBe(false)
  })
})

describe('continuesParagraph', () => {
  it('joins only when both sides look mid-sentence', () => {
    expect(continuesParagraph('To keep the', 'distinction clear, I’m')).toBe(
      true
    )
    expect(
      continuesParagraph('I’d been talking to', 'customers full-time')
    ).toBe(true)
    expect(continuesParagraph('8. Running the process', 'Conclusion')).toBe(
      false
    )
    expect(continuesParagraph('That was the end.', 'She left.')).toBe(false)
    expect(continuesParagraph('That was the end.', 'she left.')).toBe(false)
  })
})

// The Python ingest path reimplements these rules. Both suites assert against
// the same fixture, so changing one implementation alone fails its own tests.
describe('shared contract with kindle_postprocess.py', () => {
  it.each(sharedCases.isHeading)(
    'isHeadingLine($line)',
    ({ line, expected }) => {
      expect(isHeadingLine(line)).toBe(expected)
    }
  )

  it.each(sharedCases.continuesParagraph)(
    'continuesParagraph($prev | $next)',
    ({ prev, next, expected }) => {
      expect(continuesParagraph(prev, next)).toBe(expected)
    }
  )

  it.each(sharedCases.formatText)('$name', ({ chunks: pages, expected }) => {
    expect(
      formatContentChunks(chunks(...(pages as Array<[number, string]>)), {
        detectHeadings: false
      })
    ).toBe(expected)
  })
})

describe('formatContentChunks', () => {
  it('rejoins a paragraph split across a page boundary', () => {
    const out = formatContentChunks(
      chunks(
        [1, 'shouldn’t be confused with the process. To keep the'],
        [2, 'distinction clear, I’m going to refer to chatting.']
      )
    )

    expect(out).toBe(
      'shouldn’t be confused with the process. To keep the distinction clear, I’m going to refer to chatting.'
    )
  })

  it('does not join unrelated paragraphs across a page boundary', () => {
    const out = formatContentChunks(
      chunks([1, '8. Running the process'], [2, 'Conclusion and cheatsheet'])
    )

    expect(out).toBe('8. Running the process\n\nConclusion and cheatsheet')
  })

  it('keeps paragraphs within a page separate', () => {
    const out = formatContentChunks(chunks([1, 'First para\nsecond para']))

    expect(out).toBe('First para\n\nsecond para')
  })

  it('promotes all-caps headings and drops the section restatement', () => {
    const out = formatContentChunks(
      chunks(
        [1, 'CHAPTER 1\nTHE MOM TEST\nPeople say you shouldn’t ask.'],
        [2, 'FAILING THE MOM TEST\nSon: "Mom, I have an idea."']
      ),
      { sectionLabel: '1. The Mom Test', headingLevel: 3 }
    )

    expect(out).toBe(
      [
        'People say you shouldn’t ask.',
        '### FAILING THE MOM TEST',
        'Son: "Mom, I have an idea."'
      ].join('\n\n')
    )
  })

  it('keeps a mid-chapter restatement of the section label', () => {
    const out = formatContentChunks(
      chunks([1, 'Some body text.\nTHE MOM TEST\nMore body text.']),
      { sectionLabel: 'The Mom Test' }
    )

    expect(out).toBe('Some body text.\n\n### THE MOM TEST\n\nMore body text.')
  })

  it('drops trailing headings that restate the next section', () => {
    const out = formatContentChunks(
      chunks([1, 'End of the intro.\nCHAPTER 1\nTHE MOM TEST']),
      { sectionLabel: 'Introduction', nextSectionLabel: '1. The Mom Test' }
    )

    expect(out).toBe('End of the intro.')
  })

  it('keeps a trailing heading that starts new content', () => {
    const out = formatContentChunks(
      chunks([1, 'End of the intro.\nFAILING THE MOM TEST']),
      { sectionLabel: 'Introduction', nextSectionLabel: '1. The Mom Test' }
    )

    expect(out).toBe('End of the intro.\n\n### FAILING THE MOM TEST')
  })

  it('leaves headings as paragraphs when detection is disabled', () => {
    const out = formatContentChunks(
      chunks([1, 'FAILING THE MOM TEST\nBody.']),
      {
        detectHeadings: false
      }
    )

    expect(out).toBe('FAILING THE MOM TEST\n\nBody.')
  })

  it('joins without a space after a dash', () => {
    const out = formatContentChunks(
      chunks([1, 'he said—'], [2, 'well, maybe.'])
    )

    expect(out).toBe('he said—well, maybe.')
  })

  it('ignores empty and whitespace-only chunks', () => {
    const out = formatContentChunks(
      chunks([1, 'Body.'], [2, '   \n  '], [3, ''])
    )

    expect(out).toBe('Body.')
  })
})
