import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import pMap from 'p-map'

import type { OcrEngine } from './ocr-engine'
import type { BookMetadata, ContentChunk, TocItem } from './types'
import {
  createContentWriter,
  readContentStore,
  selectReusableChunks
} from './content-store'
import { type ChatCompletionClient, createOpenAiOcrEngine } from './openai-ocr'
import {
  assert,
  escapeRegExp,
  getEnv,
  readJsonFile,
  resolveScreenshotPath
} from './utils'
import { createVisionOcrEngine, isVisionOcrAvailable } from './vision-ocr'

export type { ChatCompletionClient } from './openai-ocr'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_CONCURRENCY = 16
const DEFAULT_MAX_RETRIES = 20
/** Attempts at an empty response before accepting the page really is blank. */
const EMPTY_RESPONSE_RETRIES = 3
const VERBOSE_LOGGING = getEnv('KINDLE_EXPORT_VERBOSE') === '1'

/**
 * Pick who reads the pages.
 *
 * Naming a model is an explicit request for OpenAI. Otherwise prefer local
 * OCR, which is free, offline and needs no API key — the single biggest
 * obstacle to someone using this without a developer's setup.
 */
export async function resolveOcrEngine(model?: string): Promise<OcrEngine> {
  if (!model && (await isVisionOcrAvailable())) {
    return createVisionOcrEngine()
  }

  return createOpenAiOcrEngine({ model })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function withAbortTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}

export interface FailedPage {
  index: number
  page: number
  screenshot: string
  error: string
}

export interface TranscribeBookResult {
  content: ContentChunk[]
  /**
   * Pages that could not be read. Their text is simply absent from `content`,
   * so callers must surface this rather than treating the result as complete.
   */
  failedPages: FailedPage[]
}

export interface TranscribeBookOptions {
  asin: string
  /** Root directory holding one folder per ASIN. Defaults to `out`. */
  outDir?: string
  /**
   * OpenAI vision model to read pages with. Leave unset to use free local OCR
   * where it's available.
   */
  model?: string
  /** Abort a single page request after this long. */
  requestTimeoutMs?: number
  /** Page images read in parallel. */
  concurrency?: number
  /** Attempts per page before giving up on it. */
  maxRetries?: number
  /** Re-read every page, discarding text transcribed on a previous run. */
  force?: boolean
  /** Called as each page completes, for progress reporting. */
  onProgress?: (done: number, total: number) => void
  /** Injectable for tests; overrides engine selection entirely. */
  engine?: OcrEngine
  /** Injectable for tests; forces the OpenAI engine with a faked client. */
  client?: ChatCompletionClient
}

/**
 * Transcribe a book's captured page images to text.
 *
 * Pages already present in `content.json` are kept as-is unless `force` is set,
 * so re-running after a partial failure retries only the pages that failed
 * rather than paying to read the whole book again.
 */
export async function transcribeBook({
  asin,
  outDir: root = 'out',
  model,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  maxRetries = DEFAULT_MAX_RETRIES,
  force = false,
  onProgress,
  engine: injectedEngine,
  client
}: TranscribeBookOptions): Promise<TranscribeBookResult> {
  const outDir = path.join(root, asin)
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.pages?.length, 'no page screenshots found')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const pageToTocItemMap = metadata.toc.reduce(
    (acc, tocItem) => {
      if (tocItem.page !== undefined) {
        acc[tocItem.page] = tocItem
      }
      return acc
    },
    {} as Record<number, TocItem>
  )

  // const pageScreenshotsDir = path.join(outDir, 'pages')
  // const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  // assert(pageScreenshots.length, 'no page screenshots found')

  // A faked client is a test asking for the OpenAI path specifically; anything
  // else goes through normal selection.
  const engine =
    injectedEngine ??
    (client
      ? createOpenAiOcrEngine({ model, client })
      : await resolveOcrEngine(model))
  // Only an engine we created is ours to shut down.
  const ownsEngine = !injectedEngine

  // Keep whatever a previous run managed to read, so a retry only pays for the
  // pages that actually failed — but only text that belongs to the pages on
  // disk right now. After a re-capture the old chunks line up by index and are
  // about entirely different pages.
  const existing = force
    ? []
    : selectReusableChunks(await readContentStore(outDir), metadata)
  const existingByIndex = new Map(
    existing.map((chunk) => [chunk.index, chunk] as const)
  )

  // Pages are saved as they finish rather than in one write at the end, so an
  // interrupted run keeps what it already paid for.
  const writer = createContentWriter(outDir, {
    captureId: metadata.captureId,
    chunks: existing
  })

  const pending = metadata.pages.filter(
    (pageChunk) => !existingByIndex.has(pageChunk.index)
  )
  // Page images are cleaned up once a book is fully transcribed, so a missing
  // one usually means "already done and tidied", not a broken install.
  if (pending.length) {
    const missing = await fs
      .access(resolveScreenshotPath(outDir, pending[0]!.screenshot))
      .then(() => false)
      .catch(() => true)

    assert(
      !missing,
      `page images for ${asin} are gone (cleaned up after transcription). ` +
        `Run 'kindle-export capture ${asin} --force-capture' to fetch them again.`
    )
  }

  const failedPages: FailedPage[] = []
  let completed = 0

  await pMap(
    pending,
    async (pageChunk) => {
      const pageChunkIndex = metadata.pages.indexOf(pageChunk)
      const { screenshot, index, page } = pageChunk
      // Stored relative to the book directory; older captures stored something
      // else again, so never open `screenshot` directly.
      const imagePath = resolveScreenshotPath(outDir, screenshot)

      try {
        let retries = 0

        do {
          // Pinned per iteration: the retry counter is mutated below, and the
          // engine must see the attempt this call actually is.
          const attempt = retries
          let rawText: string
          try {
            rawText = await withAbortTimeout(requestTimeoutMs, (signal) =>
              engine.recognize({ imagePath, attempt, signal })
            )
          } catch (err: any) {
            ++retries
            if (retries >= maxRetries) {
              throw err
            }

            console.warn('retrying OCR error...', {
              index,
              retries,
              screenshot: imagePath,
              error: err?.message ?? String(err)
            })
            const backoffMs = Math.min(2000, 200 * 2 ** retries)
            await sleep(backoffMs)
            continue
          }

          let text = rawText
            .replace(/^\s*\d+\s*$\n+/m, '')
            // .replaceAll(/\n+/g, '\n')
            .replaceAll(/^\s*/gm, '')
            .replaceAll(/\s*$/gm, '')

          ++retries

          // Nothing came back. Retry a couple of times in case the model just
          // hiccuped, then take it at its word: blank pages are ordinary in a
          // book, and an empty page is the honest transcription of one.
          // Failing it instead would mark the book permanently incomplete and
          // keep its page images from ever being cleaned up.
          if (!text && retries < Math.min(EMPTY_RESPONSE_RETRIES, maxRetries)) {
            await sleep(Math.min(2000, 200 * 2 ** retries))
            continue
          }

          if (!text) {
            console.warn('treating page as blank', {
              index,
              screenshot: imagePath
            })
          }

          const prevPageChunk = metadata.pages[pageChunkIndex - 1]
          if (prevPageChunk && prevPageChunk.page !== page) {
            const tocItem = pageToTocItemMap[page]
            if (tocItem) {
              text = text.replace(
                // eslint-disable-next-line security/detect-non-literal-regexp
                new RegExp(`^${escapeRegExp(tocItem.label)}\\s*`, 'i'),
                ''
              )
            }
          }

          const result: ContentChunk = {
            index,
            page,
            text,
            screenshot
          }
          if (VERBOSE_LOGGING) {
            console.log(result)
          }

          // Saved here rather than after the whole book: a page that has been
          // read is work that has been paid for, and Ctrl+C an hour in used to
          // throw all of it away.
          writer.add(result)
          onProgress?.(++completed, pending.length)

          return
        } while (true)
      } catch (err) {
        // Record rather than swallow: a dropped page leaves a hole in the
        // book, and the caller has to be able to tell that from success.
        const message = (err as Error)?.message ?? String(err)
        console.error(`error processing image ${index} (${imagePath})`, err)
        failedPages.push({ index, page, screenshot, error: message })
        onProgress?.(++completed, pending.length)
      }
    },
    { concurrency }
  ).finally(async () => {
    // Local OCR runs as a child process, which would otherwise outlive a
    // failed run and keep the command from exiting.
    if (ownsEngine) await engine.close()
  })

  // The last few pages are still inside the save debounce; this is what makes
  // the file on disk the whole book rather than nearly it.
  await writer.flush()

  return { content: writer.chunks(), failedPages }
}
