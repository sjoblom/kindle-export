import { describe, expect, it } from 'vitest'

import {
  joinWrappedLines,
  type OcrLine,
  parseOcrLines,
  reconstructParagraphs
} from './ocr-layout'

// A page in the shape Vision reports one: a 900px-wide image with a body
// column from x=40 to x=860, 30px lines set 45px apart.
const COLUMN_LEFT = 40
const COLUMN_RIGHT = 860
const LINE_HEIGHT = 30
const PITCH = 45

interface LineOptions {
  /** Left edge, defaulting to the column's own. */
  left?: number
  /** Right edge, defaulting to a justified full-width line. */
  right?: number
  /** Extra space above this line, in whole line pitches. */
  skip?: number
}

/** Lays lines down the page in order, so fixtures read like the page does. */
function page(entries: Array<[string, LineOptions?]>): OcrLine[] {
  let top = 100

  return entries.map(([text, opts = {}], i) => {
    if (i > 0) top += PITCH * (1 + (opts.skip ?? 0))
    const left = opts.left ?? COLUMN_LEFT

    return {
      text,
      left,
      top,
      width: (opts.right ?? COLUMN_RIGHT) - left,
      height: LINE_HEIGHT
    }
  })
}

/** Centres a line of the given width in the column, as a heading is set. */
function centered(width: number): LineOptions {
  const left = COLUMN_LEFT + (COLUMN_RIGHT - COLUMN_LEFT - width) / 2
  return { left, right: left + width }
}

describe('reconstructParagraphs', () => {
  it('joins the wrapped lines of one paragraph with a space', () => {
    const text = reconstructParagraphs(
      page([
        ['This sentence wraps onto'],
        ['the next rendered line and'],
        ['then stops here.', { right: 400 }]
      ])
    )

    expect(text).toBe(
      'This sentence wraps onto the next rendered line and then stops here.'
    )
  })

  it('splits paragraphs separated by extra leading', () => {
    const text = reconstructParagraphs(
      page([
        ['The first paragraph runs on'],
        ['for a couple of lines.', { right: 380 }],
        ['The second one starts after', { skip: 1 }],
        ['a blank line.', { right: 300 }]
      ])
    )

    expect(text).toBe(
      'The first paragraph runs on for a couple of lines.\n' +
        'The second one starts after a blank line.'
    )
  })

  it('splits on a first-line indent with no extra leading', () => {
    const text = reconstructParagraphs(
      page([
        ['The first paragraph runs on'],
        ['for a while before it'],
        ['finally ends here.', { right: 380 }],
        ['The next one is indented', { left: COLUMN_LEFT + 60 }],
        ['but sits on the very next line.', { right: 420 }]
      ])
    )

    expect(text).toBe(
      'The first paragraph runs on for a while before it finally ends here.\n' +
        'The next one is indented but sits on the very next line.'
    )
  })

  it('does not split a full-width line that merely overhangs the margin', () => {
    // A line that starts with a wide glyph — an opening quotation mark, a
    // dash — sits as far right as a real indent would. The line above it runs
    // all the way to the right margin, which no paragraph's last line does, so
    // this is prose running on rather than a new paragraph.
    const text = reconstructParagraphs(
      page([
        ['Prose that keeps going'],
        ['and going and going'],
        ['without ever pausing', { left: COLUMN_LEFT + 60 }],
        ['until the end.', { right: 320 }]
      ])
    )

    expect(text).toBe(
      'Prose that keeps going and going and going without ever pausing until the end.'
    )
  })

  it('keeps a centred heading as its own paragraph', () => {
    const text = reconstructParagraphs(
      page([
        ['THE MOM TEST', centered(300)],
        ['A chapter opens with prose that'],
        ['runs across two lines.', { right: 400 }]
      ])
    )

    expect(text).toBe(
      'THE MOM TEST\nA chapter opens with prose that runs across two lines.'
    )
  })

  it('keeps a heading that wraps onto two centred lines together', () => {
    const text = reconstructParagraphs(
      page([
        ['HOW TO TALK TO', centered(340)],
        ['CUSTOMERS', centered(260)],
        ['And the prose that follows it'],
        ['starts on the next line.', { right: 420 }]
      ])
    )

    expect(text).toBe(
      'HOW TO TALK TO CUSTOMERS\n' +
        'And the prose that follows it starts on the next line.'
    )
  })

  it('keeps a line-ending hyphen, since a soft break and a compound look alike', () => {
    const text = reconstructParagraphs(
      page([
        ['Nobody wants to read some-'],
        ['thing that has been broken', { right: 500 }]
      ])
    )

    // Not ideal for a soft break — but the alternative merged `self-esteem`
    // into `selfesteem`, and the raw lines are stored for a better rule later.
    expect(text).toBe('Nobody wants to read some-thing that has been broken')
  })

  it('leaves the hyphen alone when it is part of the word', () => {
    const text = reconstructParagraphs(
      page([['A study of the Anglo-'], ['Saxon chronicle.', { right: 400 }]])
    )

    expect(text).toBe('A study of the Anglo-Saxon chronicle.')
  })

  it('returns nothing for a page with no text on it', () => {
    expect(reconstructParagraphs([])).toBe('')
    expect(reconstructParagraphs(page([['   ']]))).toBe('')
  })

  it('handles a page of a single line', () => {
    expect(reconstructParagraphs(page([['Just this.', { right: 300 }]]))).toBe(
      'Just this.'
    )
  })
})

describe('joinWrappedLines', () => {
  it('keeps a hyphen after a short prefix, which is rarely a soft break', () => {
    expect(joinWrappedLines('sent by e-', 'mail today')).toBe(
      'sent by e-mail today'
    )
  })

  it('keeps the hyphen of an ordinary lowercase compound', () => {
    expect(joinWrappedLines('her self-', 'esteem grew')).toBe(
      'her self-esteem grew'
    )
    expect(joinWrappedLines('a well-', 'known fact')).toBe('a well-known fact')
    expect(joinWrappedLines('the state-of-the-', 'art model')).toBe(
      'the state-of-the-art model'
    )
  })

  it('joins tight across an em dash rather than adding a space', () => {
    expect(joinWrappedLines('and then—', 'nothing')).toBe('and then—nothing')
  })
})

describe('parseOcrLines', () => {
  it('drops entries a stale worker got wrong rather than throwing', () => {
    const lines = parseOcrLines([
      { text: 'good', left: 1, top: 2, width: 3, height: 4 },
      { text: 'no box' },
      { left: 1, top: 2, width: 3, height: 4 },
      { text: 'nan', left: Number.NaN, top: 2, width: 3, height: 4 },
      null
    ])

    expect(lines).toEqual([
      { text: 'good', left: 1, top: 2, width: 3, height: 4 }
    ])
  })

  it('treats a missing array as an empty page', () => {
    expect(parseOcrLines(undefined)).toEqual([])
    expect(parseOcrLines('lines')).toEqual([])
  })
})
