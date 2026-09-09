/**
 * Transcription is pure OCR — read the page verbatim, no interpretation. The
 * structure work (headings, rejoining paragraphs split across pages, matching
 * sections to the table of contents) all happens deterministically afterwards.
 *
 * That makes the reader swappable: macOS can do it locally for free with the
 * Vision framework, and OpenAI covers everything else.
 */
export interface OcrRequest {
  /** Absolute path to the page image. */
  imagePath: string
  /** 0-based attempt number, so an engine can escalate on a retry. */
  attempt: number
  /** Aborts the attempt when the caller's per-page timeout fires. */
  signal: AbortSignal
}

export interface OcrEngine {
  /** Shown in progress output and errors, e.g. `Apple Vision` or `gpt-4.1-mini`. */
  readonly name: string
  /** Whether pages cost money to read, so callers can warn before a long run. */
  readonly costsMoney: boolean
  /**
   * Read one page. Throwing asks the caller to retry.
   *
   * One newline in the returned text means one paragraph boundary — never a
   * wrapped line — because that is the only structure the formatter has to work
   * from. An engine that sees the page as rendered lines has to put the
   * paragraphs back together itself (see `ocr-layout.ts`).
   */
  recognize(request: OcrRequest): Promise<string>
  /** Release any worker process. Safe to call more than once. */
  close(): Promise<void>
}

/**
 * Thrown when a model declines to transcribe a page rather than failing
 * outright, which is worth retrying differently from a network error.
 */
export class OcrRefusalError extends Error {
  constructor(readonly text: string) {
    super(`Model refused to transcribe the page: ${text}`)
    this.name = 'OcrRefusalError'
  }
}
