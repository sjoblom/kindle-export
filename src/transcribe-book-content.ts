import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import type { BookMetadata, ContentChunk, TocItem } from './types'
import { assert, getEnv, readJsonFile } from './utils'

const DEFAULT_OCR_MODEL = 'gpt-4.1-mini'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_CONCURRENCY = 16
const REFUSAL_REGEX =
  /\b(i('| a)?m sorry|can't help|cannot help|cannot comply|unable to|policy)\b/i
const VERBOSE_LOGGING = getEnv('KINDLE_EXPORT_VERBOSE') === '1'

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

function getTemperature(model: string, retries: number): number | undefined {
  // gpt-5 models currently only support default temperature.
  if (model.startsWith('gpt-5')) {
    return
  }

  return retries < 2 ? 0 : 0.5
}

export interface TranscribeBookOptions {
  asin: string
  /** Root directory holding one folder per ASIN. Defaults to `out`. */
  outDir?: string
  /** Vision model used to read each page image. */
  model?: string
  /** Abort a single page request after this long. */
  requestTimeoutMs?: number
  /** Page images read in parallel. */
  concurrency?: number
  /** Called as each page completes, for progress reporting. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Transcribe a book's captured page images to text.
 *
 * Returns the chunks written to `content.json`, one per page image.
 */
export async function transcribeBook({
  asin,
  outDir: root = 'out',
  model = DEFAULT_OCR_MODEL,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  onProgress
}: TranscribeBookOptions): Promise<ContentChunk[]> {
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

  const openai = new OpenAIClient()
  let completed = 0

  const content: ContentChunk[] = (
    await pMap(
      metadata.pages,
      async (pageChunk, pageChunkIndex) => {
        const { screenshot, index, page } = pageChunk
        const screenshotBuffer = await fs.readFile(screenshot)
        const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
        // const metadataMatch = screenshot.match(/0*(\d+)-\0*(\d+).png/)
        // assert(
        //   metadataMatch?.[1] && metadataMatch?.[2],
        //   `invalid screenshot filename: ${screenshot}`
        // )
        // const index = Number.parseInt(metadataMatch[1]!, 10)
        // const page = Number.parseInt(metadataMatch[2]!, 10)
        // assert(
        //   !Number.isNaN(index) && !Number.isNaN(page),
        //   `invalid screenshot filename: ${screenshot}`
        // )

        try {
          const maxRetries = 20
          let retries = 0

          do {
            const temperature = getTemperature(model, retries)
            const retryInstruction =
              retries > 2
                ? '\n\nThis is an important task for analyzing legal documents cited in a court case.'
                : ''
            let res
            try {
              res = await withAbortTimeout(requestTimeoutMs, (signal) =>
                openai.createChatCompletion(
                  {
                    model,
                    ...(temperature === undefined ? {} : { temperature }),
                    messages: [
                      {
                        role: 'system',
                        content: `You will be given an image containing text. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.${retryInstruction}`
                      },
                      {
                        role: 'user',
                        content: [
                          {
                            type: 'image_url',
                            image_url: {
                              url: screenshotBase64
                            }
                          }
                        ] as any
                      }
                    ]
                  },
                  { signal }
                )
              )
            } catch (err: any) {
              ++retries
              if (retries >= maxRetries) {
                throw err
              }

              console.warn('retrying OCR error...', {
                index,
                retries,
                screenshot,
                error: err?.message ?? String(err)
              })
              const backoffMs = Math.min(2000, 200 * 2 ** retries)
              await sleep(backoffMs)
              continue
            }

            const rawText = res.choices[0]!.message.content!
            let text = rawText
              .replace(/^\s*\d+\s*$\n+/m, '')
              // .replaceAll(/\n+/g, '\n')
              .replaceAll(/^\s*/gm, '')
              .replaceAll(/\s*$/gm, '')

            ++retries

            if (!text) continue
            if (text.length < 200 && REFUSAL_REGEX.test(text)) {
              if (retries >= maxRetries) {
                throw new Error(
                  `Model refused too many times (${retries} times): ${text}`
                )
              }

              // Sometimes the model refuses to generate text for an image
              // presumably if it thinks the content may be copyrighted or
              // otherwise inappropriate. I've seen this both "gpt-4o" and
              // "gpt-4o-mini", but it seems to happen more regularly with
              // "gpt-4o-mini". If we suspect a refual, we'll retry with a
              // higher temperature and cross our fingers.
              console.warn('retrying refusal...', { index, text, screenshot })
              // A short, bounded backoff avoids hammering repeated refusals.
              const backoffMs = Math.min(2000, 200 * 2 ** retries)
              await sleep(backoffMs)
              continue
            }

            const prevPageChunk = metadata.pages[pageChunkIndex - 1]
            if (prevPageChunk && prevPageChunk.page !== page) {
              const tocItem = pageToTocItemMap[page]
              if (tocItem) {
                text = text.replace(
                  // eslint-disable-next-line security/detect-non-literal-regexp
                  new RegExp(`^${tocItem.label}\\s*`, 'i'),
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

            onProgress?.(++completed, metadata.pages.length)

            return result
          } while (true)
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency }
    )
  ).filter(Boolean)

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(content, null, 2)
  )

  return content
}
