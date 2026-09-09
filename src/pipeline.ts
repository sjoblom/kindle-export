import os from 'node:os'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { describeIncompleteCapture } from './capture-status'
import { cleanPageImages, cleanRenderData, formatBytes } from './cleanup'
import { loadConfig } from './config'
import {
  invalidateContent,
  readContentChunks,
  readContentStore,
  selectReusableChunks
} from './content-store'
import { exportBookMarkdown } from './export-book-markdown'
import { exportBookPdf } from './export-book-pdf'
import { runExtraction } from './extract-kindle-book'
import { type FailedPage, transcribeBook } from './transcribe-book-content'
import { assert, getEnv, tryReadJsonFile } from './utils'

/**
 * The per-book pipeline, separated from any one interface.
 *
 * The CLI and the local web app both run the same three stages; what differs
 * is where the narration goes — a terminal wants prefixed lines, a browser
 * wants progress bars. So the stages report through an event callback and the
 * caller decides how to render, rather than this module printing directly.
 */

export interface Options {
  command: string
  asins: string[]
  outDir: string
  profileDir: string
  model?: string
  concurrency?: number
  otp?: string
  json: boolean
  limit?: number
  port?: number
  formats: Array<'md' | 'pdf'>
  keepPages: boolean
  forceCapture: boolean
  forceOcr: boolean
  forceExport: boolean
  /**
   * Minimize the capture browser window instead of leaving it in front. The
   * web app sets this — a window turning its own pages invites closing — and
   * it pops back up by itself if Amazon asks for a sign-in.
   */
  hideBrowser?: boolean
}

/** Nothing supplied by hand; applyConfig fills every path in. */
export const EMPTY_OPTIONS: Options = {
  command: 'all',
  asins: [],
  outDir: '',
  profileDir: '',
  json: false,
  formats: ['md'],
  keepPages: false,
  forceCapture: false,
  forceOcr: false,
  forceExport: false
}

/** Failed pages listed individually before collapsing to a count. */
const MAX_REPORTED_FAILURES = 10

/** How often to look at metadata.json for capture progress. */
const CAPTURE_POLL_MS = 2000

export type PipelineEvent =
  /** Something worth saying. */
  | { kind: 'info'; message: string }
  /** Something wrong but survivable — the book still exports. */
  | { kind: 'warn'; message: string }
  /** A stage is starting work (not emitted when its output is reused). */
  | { kind: 'stage'; stage: 'capture' | 'transcribe' | 'export' }
  /** Pages captured so far; total is unknown until the reader reports it. */
  | { kind: 'capture-progress'; captured: number; total?: number }
  | { kind: 'transcribe-progress'; done: number; total: number }

export type EmitEvent = (event: PipelineEvent) => void

export interface BookResult {
  asin: string
  /** Files written (or already present, for reused stages). */
  outputs: string[]
  /** Lines explaining that the captured pages are only part of the book. */
  incompleteCapture?: string[]
  /** Pages that could not be transcribed; the export is missing them. */
  failedPages: FailedPage[]
  durationMs: number
}

export function defaultProfileDir(): string {
  return path.join(os.homedir(), '.kindle-export', 'profile')
}

/**
 * Fill in anything not given as a flag: environment (including `.env`) first,
 * then stored config, then the built-in default.
 */
export async function applyConfig(options: Options): Promise<Options> {
  const stored = await loadConfig()

  // `||`, not `??`: a blank path means "not supplied" — `setup` builds options
  // by hand rather than through parseArgs, and an empty string there used to
  // survive all the way to `mkdir ''`.
  options.outDir =
    options.outDir || getEnv('KINDLE_OUT_DIR') || stored.outDir || 'out'
  options.profileDir =
    options.profileDir || getEnv('BROWSER_PROFILE_DIR') || defaultProfileDir()
  options.model = options.model ?? getEnv('OCR_MODEL') ?? stored.model
  options.concurrency = options.concurrency ?? stored.concurrency

  // The transcriber reads the key from the environment, so put the stored one
  // there when nothing else supplied it.
  if (!getEnv('OPENAI_API_KEY') && stored.openaiApiKey) {
    // eslint-disable-next-line no-process-env
    process.env.OPENAI_API_KEY = stored.openaiApiKey
  }

  return options
}

export async function readMetadata(
  outDir: string,
  asin: string
): Promise<BookMetadata | undefined> {
  return tryReadJsonFile<BookMetadata>(path.join(outDir, asin, 'metadata.json'))
}

export async function readContent(
  outDir: string,
  asin: string
): Promise<ContentChunk[] | undefined> {
  return readContentChunks(path.join(outDir, asin))
}

/**
 * Say so when the pages on disk are only part of a book.
 *
 * Truncated captures look identical to finished ones — a shorter book — so
 * without this a run that died at chapter 3 exports cleanly and silently.
 */
function reportIncompleteCapture(
  metadata: BookMetadata,
  emit: EmitEvent
): string[] | undefined {
  const lines = describeIncompleteCapture(metadata)
  if (!lines) return

  for (const line of lines) {
    emit({ kind: 'warn', message: line })
  }

  return lines
}

async function capture(
  asin: string,
  options: Options,
  emit: EmitEvent
): Promise<{ metadata: BookMetadata; incompleteCapture?: string[] }> {
  const existing = await readMetadata(options.outDir, asin)
  if (!options.forceCapture && existing?.pages?.length) {
    emit({
      kind: 'info',
      message: `capture: reusing ${existing.pages.length} existing page images`
    })
    return {
      metadata: existing,
      incompleteCapture: reportIncompleteCapture(existing, emit)
    }
  }

  emit({ kind: 'stage', stage: 'capture' })
  emit({ kind: 'info', message: 'capture: opening Kindle reader' })

  // The capture loop rewrites metadata.json after every page, so progress is
  // read from disk rather than threaded through the extraction code.
  let lastCaptured = -1
  const poll = setInterval(() => {
    void readMetadata(options.outDir, asin).then((partial) => {
      const captured = partial?.pages?.length ?? 0
      if (captured <= lastCaptured) return

      lastCaptured = captured
      const total = partial?.nav?.totalNumPages
      emit({
        kind: 'capture-progress',
        captured,
        total: total && total > 0 ? total : undefined
      })
    })
  }, CAPTURE_POLL_MS)

  try {
    // Credentials are optional: the stored session usually covers it, and if
    // it doesn't, you sign in by hand in the browser window that opens.
    await runExtraction({
      asin,
      amazonEmail: getEnv('AMAZON_EMAIL'),
      amazonPassword: getEnv('AMAZON_PASSWORD'),
      outDir: options.outDir,
      profileDir: options.profileDir,
      otp: options.otp,
      hideWindow: options.hideBrowser
    })
  } finally {
    clearInterval(poll)
  }

  const metadata = await readMetadata(options.outDir, asin)
  assert(metadata?.pages?.length, `capture produced no page images`)

  // The page images the previous transcription was read from no longer exist,
  // so that text is no longer about this book's pages. Dropping it here is what
  // makes `--force-capture` re-export the book that was just captured instead
  // of quietly re-exporting the one before it.
  await invalidateContent(path.join(options.outDir, asin))

  emit({
    kind: 'info',
    message: `capture: ${metadata.pages.length} page images`
  })
  const incompleteCapture = reportIncompleteCapture(metadata, emit)

  // Amazon's render payloads are only useful during the capture itself.
  const render = await cleanRenderData(options.outDir, asin)
  if (render.freed) {
    emit({
      kind: 'info',
      message: `capture: freed ${formatBytes(render.freed)} of render data`
    })
  }

  return { metadata, incompleteCapture }
}

async function ocr(
  asin: string,
  metadata: BookMetadata,
  options: Options,
  emit: EmitEvent
): Promise<{ content: ContentChunk[]; failedPages: FailedPage[] }> {
  // Not just "enough chunks exist": chunks left over from an earlier capture
  // of the same book count to exactly the same number and describe different
  // pages entirely, so only text that belongs to the capture on disk counts.
  const existing = selectReusableChunks(
    await readContentStore(path.join(options.outDir, asin)),
    metadata
  )
  if (
    !options.forceOcr &&
    existing.length &&
    existing.length >= metadata.pages.length
  ) {
    emit({
      kind: 'info',
      message: `transcribe: reusing ${existing.length} chunks`
    })
    return { content: existing, failedPages: [] }
  }

  emit({ kind: 'stage', stage: 'transcribe' })

  const { content, failedPages } = await transcribeBook({
    asin,
    outDir: options.outDir,
    model: options.model,
    concurrency: options.concurrency,
    force: options.forceOcr,
    onProgress: (done, total) => {
      emit({ kind: 'transcribe-progress', done, total })
    }
  })

  assert(content.length, `transcription produced no text`)

  if (failedPages.length) {
    // The book is still worth exporting, but it has holes in it and the user
    // has to know which pages, and that re-running will retry just those.
    emit({
      kind: 'warn',
      message: `${failedPages.length} of ${metadata.pages.length} pages could not be read:`
    })
    for (const failure of failedPages.slice(0, MAX_REPORTED_FAILURES)) {
      emit({
        kind: 'warn',
        message: `  page ${failure.page} (${failure.error})`
      })
    }
    if (failedPages.length > MAX_REPORTED_FAILURES) {
      emit({
        kind: 'warn',
        message: `  ...and ${failedPages.length - MAX_REPORTED_FAILURES} more`
      })
    }
    emit({
      kind: 'warn',
      message: `the export below is missing those pages — re-run to retry just them`
    })
  }

  // Page images are only the input to this step. Once every page has text
  // they're dead weight, and re-capturing costs time rather than data.
  if (!options.keepPages && !failedPages.length) {
    const pages = await cleanPageImages(options.outDir, asin)
    if (pages.freed) {
      emit({
        kind: 'info',
        message: `transcribe: freed ${formatBytes(pages.freed)} of page images`
      })
    }
  }

  return { content, failedPages }
}

export async function processBook(
  asin: string,
  options: Options,
  emit: EmitEvent = () => {}
): Promise<BookResult> {
  const startedAt = Date.now()

  let incompleteCapture: string[] | undefined
  let metadata: BookMetadata | undefined
  if (options.command === 'ocr' || options.command === 'export') {
    metadata = await readMetadata(options.outDir, asin)
  } else {
    const captured = await capture(asin, options, emit)
    metadata = captured.metadata
    incompleteCapture = captured.incompleteCapture
  }
  assert(
    metadata?.pages?.length,
    `no captured pages — run 'kindle-export capture ${asin}' first`
  )

  if (options.command === 'capture') {
    return {
      asin,
      outputs: [path.join(options.outDir, asin)],
      incompleteCapture,
      failedPages: [],
      durationMs: Date.now() - startedAt
    }
  }

  let content: ContentChunk[] | undefined
  let failedPages: FailedPage[] = []
  if (options.command === 'export') {
    // Same check as the transcribe stage: text left behind by an earlier
    // capture is not this book's text, and exporting it would look like it
    // worked.
    content = selectReusableChunks(
      await readContentStore(path.join(options.outDir, asin)),
      metadata
    )
  } else {
    const transcribed = await ocr(asin, metadata, options, emit)
    content = transcribed.content
    failedPages = transcribed.failedPages
  }
  assert(
    content?.length,
    `no transcribed text — run 'kindle-export ocr ${asin}' first`
  )

  if (options.command === 'ocr') {
    return {
      asin,
      outputs: [path.join(options.outDir, asin, 'content.json')],
      incompleteCapture,
      failedPages,
      durationMs: Date.now() - startedAt
    }
  }

  emit({ kind: 'stage', stage: 'export' })
  const outputs: string[] = []
  for (const format of options.formats) {
    outputs.push(
      format === 'pdf'
        ? await exportBookPdf({ asin, outDir: options.outDir })
        : await exportBookMarkdown({ asin, outDir: options.outDir })
    )
  }

  return {
    asin,
    outputs,
    incompleteCapture,
    failedPages,
    durationMs: Date.now() - startedAt
  }
}
