export interface BookMetadata {
  meta: AmazonBookMeta
  info: AmazonBookInfo
  nav: Nav
  toc: TocItem[]
  pages: PageChunk[]
  locationMap: AmazonRenderLocationMap
  /**
   * Identifies this particular set of page images.
   *
   * Re-capturing a book replaces every image, which makes text transcribed
   * from the previous ones text about a different set of pages — indexes and
   * page numbers alone can't tell the two apart. `content.json` records the id
   * it was read from so a stale transcription can be spotted instead of
   * silently exported. Absent on books captured before this was recorded.
   */
  captureId?: string
  /**
   * How the capture ended. Absent on books captured before this was recorded,
   * which are assumed complete rather than forcing a re-capture of a library.
   */
  capture?: CaptureStatus
}

/**
 * Whether `pages` is the whole book.
 *
 * A capture can stop early — the reader stops responding to the next-page
 * chevron, or the run is interrupted — and the pages written up to that point
 * look exactly like a finished book. Without this, a truncated capture is
 * reused forever and exports cleanly with the tail of the book missing.
 */
export interface CaptureStatus {
  complete: boolean
  reason: CaptureStopReason
  /** Last page reached, to report how much of the book is missing. */
  lastPage: number
  /** Content pages the book claims to have. */
  totalContentPages: number
}

export type CaptureStopReason =
  /** Footer nav reported the last page. */
  | 'end-of-book'
  /** Walked past the last content page. */
  | 'past-last-content-page'
  /** The reader stopped advancing. */
  | 'navigation-failed'
  /**
   * The footer reported the last page but the reader still offered a next
   * page and would not render it, so the final screens may be missing.
   */
  | 'end-unconfirmed'
  /** Page position became unreadable mid-book. */
  | 'no-page-nav'
  /** Metadata written mid-capture; the run never reached an end state. */
  | 'interrupted'

export interface Nav {
  startPosition: number // inclusive
  endPosition: number // inclusive?

  startContentPosition: number // inclusive
  startContentPage: number // inclusive

  endContentPosition: number // exclusive
  endContentPage: number // exclusive?

  totalNumPages: number
  totalNumContentPages: number
}

export interface PageChunk {
  index: number
  page: number
  /**
   * The page image, relative to the book directory (`pages/000-001.png`), so
   * the output tree can be moved and so a later stage run from a different
   * working directory still finds it. Captures made before this stored
   * whatever path the caller passed; `resolveScreenshotPath` reads both.
   */
  screenshot: string
}

export interface ContentChunk {
  index: number
  page: number
  text: string
  /** As `PageChunk.screenshot` — relative to the book directory. */
  screenshot: string
  /**
   * What the engine actually saw, when it works in rendered lines: each line's
   * text and where it sat on the page. `text` is derived from these, and the
   * derivation makes judgment calls (which line breaks are paragraph breaks,
   * how a line-ending hyphen joins). Keeping the raw lines means a better
   * judgment later costs a re-export, not a re-capture or another OCR run.
   */
  lines?: OcrLine[]
}

/** One line of text as an OCR engine recognised it on the page image. */
export interface OcrLine {
  /** The recognised text of one rendered line. */
  text: string
  /** Pixels from the left edge of the page image. */
  left: number
  /** Pixels from the top edge of the page image. */
  top: number
  width: number
  height: number
}

/**
 * A book's `content.json`: the transcribed text plus the capture it came from.
 *
 * Older files are a bare `ContentChunk[]`; see `content-store.ts`.
 */
export interface ContentStore {
  captureId?: string
  chunks: ContentChunk[]
}

export interface PageNav {
  page?: number
  location?: number
  total: number
}

export type TocItem = {
  label: string
  positionId: number
  page?: number
  location?: number
  depth: number
} & (
  | {
      page: number
      location?: never
    }
  | {
      page?: never
      location: number
    }
)

/** Amazon's YT Metadata */
export interface AmazonBookMeta {
  ACR: string
  asin: string
  authorList: Array<string>
  bookSize: string
  bookType: string
  cover: string
  language: string
  positions: {
    cover: number
    srl: number
    toc: number
  }
  publisher: string
  refEmId: string
  releaseDate: string
  sample: boolean
  title: string
  /** A hash unique to the book's version */
  version: string
  startPosition: number
  endPosition: number
}

/** Amazon's Karamel Book Metadata */
export interface AmazonBookInfo {
  clippingLimit: number
  contentChecksum: any
  contentType: string
  contentVersion: string
  deliveredAsin: string
  downloadRestrictionReason: any
  expirationDate: any
  format: string
  formatVersion: string
  fragmentMapUrl: any
  hasAnnotations: boolean
  isOwned: boolean
  isSample: boolean
  kindleSessionId: string
  lastPageReadData: {
    deviceName: string
    position: number
    syncTime: number
  }
  manifestUrl: any
  originType: string
  pageNumberUrl: any
  requestedAsin: string
  srl: number
}

export interface AmazonRenderLocationMap {
  locations: number[]
  navigationUnit: Array<{
    startPosition: number
    page: number // derived
    label: string
  }>
}

export type AmazonRenderToc = Array<AmazonRenderTocItem>

export type AmazonRenderTocItem = {
  label: string
  tocPositionId: number
  entries?: AmazonRenderTocItem[]
}
