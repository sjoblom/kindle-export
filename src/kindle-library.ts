import type { BrowserContext } from './extract-kindle-book'
import { normalizeAuthors } from './utils'

/**
 * Reading the signed-in account's Kindle library.
 *
 * The library page fetches its own contents from an internal JSON endpoint, so
 * we call that from inside the page rather than scraping the DOM — the markup
 * is virtualised and changes often, whereas the payload is stable and already
 * carries exactly the fields we need.
 */

const LIBRARY_URL = 'https://read.amazon.com/kindle-library'
const SEARCH_PATH = '/kindle-library/search'
const DEFAULT_PAGE_SIZE = 50

/** Guard against an unbounded loop if the endpoint keeps returning a token. */
const MAX_PAGES = 40

export interface LibraryBook {
  asin: string
  title: string
  authors: string[]
  /** `EBOOK`, `KINDLE_EDITION_WITH_AUDIO`, … — samples and audiobooks differ. */
  resourceType?: string
  /** 0-100, when Amazon reports reading progress. */
  percentageRead?: number
}

export interface LibraryPage {
  books: LibraryBook[]
  paginationToken?: string
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Amazon packs every author into one colon-delimited string, each written
 * "Last, First" — `"Alonso, Ana:Callaghan, Harrison:"`. Splitting on commas
 * would turn one author into two. `normalizeAuthors` already handles this
 * shape, including the trailing separator.
 */
function parseAuthors(value: unknown): string[] {
  const entries = (Array.isArray(value) ? value : [value])
    .map((entry) => asString(entry))
    .filter((entry): entry is string => !!entry)

  return entries.flatMap((entry) => normalizeAuthors([entry]))
}

/**
 * Pull the books out of one library response.
 *
 * Kept separate from the network call so it can be tested against a recorded
 * payload — the shape is Amazon's to change, and a silent parse failure here
 * would look identical to an empty library.
 */
export function parseLibraryPage(payload: unknown): LibraryPage {
  if (!payload || typeof payload !== 'object') return { books: [] }

  const record = payload as Record<string, unknown>
  const rawItems = record.itemsList ?? record.items ?? record.OwnedItems
  if (!Array.isArray(rawItems)) return { books: [] }

  const books: LibraryBook[] = []
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue

    const entry = item as Record<string, unknown>
    const rawAsin = asString(entry.asin) ?? asString(entry.ASIN)
    if (!rawAsin) continue

    const asin = rawAsin.toUpperCase()
    books.push({
      asin,
      title: asString(entry.title) ?? asin,
      authors: parseAuthors(entry.authors ?? entry.author),
      resourceType: asString(entry.resourceType),
      percentageRead:
        typeof entry.percentageRead === 'number'
          ? entry.percentageRead
          : undefined
    })
  }

  return {
    books,
    paginationToken:
      asString(record.paginationToken) ?? asString(record.nextPageToken)
  }
}

export class NotSignedInError extends Error {
  constructor() {
    super("not signed in to Amazon — run 'kindle-export login' first")
    this.name = 'NotSignedInError'
  }
}

export interface FetchLibraryOptions {
  /** Books requested per round trip. */
  pageSize?: number
  /** Stop after this many books. */
  limit?: number
  onProgress?: (count: number) => void
}

/**
 * Every book in the signed-in account's Kindle library, newest first.
 */
export async function fetchLibrary(
  context: BrowserContext,
  { pageSize = DEFAULT_PAGE_SIZE, limit, onProgress }: FetchLibraryOptions = {}
): Promise<LibraryBook[]> {
  const page = context.pages()[0] ?? (await context.newPage())

  if (!page.url().startsWith('https://read.amazon.com')) {
    await page.goto(LIBRARY_URL, { waitUntil: 'domcontentloaded' })
  }

  if (/\/ap\/signin|\/gp\/signin/.test(page.url())) {
    throw new NotSignedInError()
  }

  const books: LibraryBook[] = []
  const seen = new Set<string>()
  let paginationToken: string | undefined

  for (let request = 0; request < MAX_PAGES; request++) {
    const payload = await page.evaluate(
      async ({ searchPath, querySize, token }) => {
        // This callback runs in the page, where `globalThis` carries the
        // browser's `location`; the Node types in scope here don't know that.
        const { origin } = (
          globalThis as unknown as { location: { origin: string } }
        ).location
        const url = new URL(searchPath, origin)
        url.searchParams.set('query', '')
        url.searchParams.set('libraryType', 'BOOKS')
        url.searchParams.set('sortType', 'recency')
        url.searchParams.set('querySize', String(querySize))
        if (token) url.searchParams.set('paginationToken', token)

        const res = await fetch(url.toString(), {
          credentials: 'include',
          headers: { accept: 'application/json' }
        })

        if (!res.ok) {
          return { __error: `${res.status} ${res.statusText}` }
        }

        return res.json()
      },
      { searchPath: SEARCH_PATH, querySize: pageSize, token: paginationToken }
    )

    const error = (payload as Record<string, unknown> | undefined)?.__error
    if (typeof error === 'string') {
      if (error.startsWith('401') || error.startsWith('403')) {
        throw new NotSignedInError()
      }

      throw new Error(`Kindle library request failed: ${error}`)
    }

    const parsed = parseLibraryPage(payload)
    for (const book of parsed.books) {
      // The endpoint can repeat entries across pages; keep the first.
      if (seen.has(book.asin)) continue

      seen.add(book.asin)
      books.push(book)
    }

    onProgress?.(books.length)

    if (limit && books.length >= limit) return books.slice(0, limit)
    if (!parsed.paginationToken || !parsed.books.length) break

    paginationToken = parsed.paginationToken
  }

  return books
}
