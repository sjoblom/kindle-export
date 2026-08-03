import { describe, expect, it } from 'vitest'

import { parseLibraryPage } from './kindle-library'

describe('parseLibraryPage', () => {
  it('reads books out of a library response', () => {
    const { books, paginationToken } = parseLibraryPage({
      itemsList: [
        {
          asin: 'B01H4G2J1U',
          title: 'The Mom Test',
          authors: ['Rob Fitzpatrick'],
          resourceType: 'EBOOK',
          percentageRead: 42
        },
        {
          asin: 'B07PPW5V9C',
          title: 'Obviously Awesome',
          authors: ['April Dunford'],
          resourceType: 'EBOOK'
        }
      ],
      paginationToken: 'next-page'
    })

    expect(books).toEqual([
      {
        asin: 'B01H4G2J1U',
        title: 'The Mom Test',
        authors: ['Rob Fitzpatrick'],
        resourceType: 'EBOOK',
        percentageRead: 42
      },
      {
        asin: 'B07PPW5V9C',
        title: 'Obviously Awesome',
        authors: ['April Dunford'],
        resourceType: 'EBOOK',
        percentageRead: undefined
      }
    ])
    expect(paginationToken).toBe('next-page')
  })

  // These are the exact strings the live endpoint returned, which is how the
  // colon delimiter was found — comma-splitting turned one author into two.
  it('unpacks the colon-delimited "Last, First" author string', () => {
    const { books } = parseLibraryPage({
      itemsList: [
        { asin: 'B1', authors: 'Deida, David:' },
        { asin: 'B2', authors: 'Planet, Lonely:' },
        {
          asin: 'B3',
          authors: 'Alonso, Ana:Callaghan, Harrison:Custers, Robin:'
        },
        { asin: 'B4', authors: 'Michelin Editions:' }
      ]
    })

    expect(books.map((b) => b.authors)).toEqual([
      ['David Deida'],
      ['Lonely Planet'],
      ['Ana Alonso', 'Harrison Callaghan', 'Robin Custers'],
      ['Michelin Editions']
    ])
  })

  it('accepts authors given as an array', () => {
    const { books } = parseLibraryPage({
      itemsList: [{ asin: 'B1', authors: ['Fitzpatrick, Rob:'] }]
    })

    expect(books[0]!.authors).toEqual(['Rob Fitzpatrick'])
  })

  it('uppercases the ASIN and falls back to it for a missing title', () => {
    const { books } = parseLibraryPage({ itemsList: [{ asin: 'b01h4g2j1u' }] })

    expect(books[0]).toMatchObject({
      asin: 'B01H4G2J1U',
      title: 'B01H4G2J1U',
      authors: []
    })
  })

  it('skips entries with no ASIN rather than inventing one', () => {
    const { books } = parseLibraryPage({
      itemsList: [
        { title: 'No identifier' },
        null,
        'not an object',
        { asin: '   ' },
        { asin: 'B999', title: 'Fine' }
      ]
    })

    expect(books.map((b) => b.asin)).toEqual(['B999'])
  })

  it('tolerates the shapes Amazon has used for the list and token', () => {
    expect(parseLibraryPage({ items: [{ asin: 'B1' }] }).books).toHaveLength(1)
    expect(parseLibraryPage({ OwnedItems: [{ ASIN: 'B2' }] }).books).toEqual([
      {
        asin: 'B2',
        title: 'B2',
        authors: [],
        resourceType: undefined,
        percentageRead: undefined
      }
    ])
    expect(
      parseLibraryPage({ itemsList: [], nextPageToken: 'tok' }).paginationToken
    ).toBe('tok')
  })

  it('returns nothing for junk instead of throwing', () => {
    for (const payload of [
      undefined,
      null,
      42,
      'nope',
      {},
      { itemsList: {} }
    ]) {
      expect(parseLibraryPage(payload)).toEqual({
        books: [],
        ...(payload && typeof payload === 'object' ? {} : {})
      })
    }
  })

  it('reports no pagination token when there are no more pages', () => {
    expect(
      parseLibraryPage({ itemsList: [{ asin: 'B1' }] }).paginationToken
    ).toBeUndefined()
  })
})
