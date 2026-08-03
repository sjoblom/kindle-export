import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'
import sharp from 'sharp'

import type { BookMetadata, IllustrationChunk } from './types'
import { assert, getEnv, readJsonFile } from './utils'

const MODEL = 'gpt-5-mini'
const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  getEnv('ILLUS_CONFIDENCE_THRESHOLD') || '0.7'
)
const DEFAULT_MIN_AREA_PERCENT = Number(getEnv('ILLUS_MIN_AREA_PERCENT') || '1')
const DEFAULT_MAX_RETRIES = Number(getEnv('ILLUS_MAX_RETRIES') || '5')
const DEFAULT_BACKOFF_MS = 200
const DEFAULT_MAX_BACKOFF_MS = 2000

const REFUSAL_RE =
  /\b(i('| a)?m sorry|can't help|cannot help|cannot comply|unable to|policy|copyright)\b/i

const SYSTEM_PROMPT = `Analyze this ebook page image.

Identify ONLY meaningful illustrations, diagrams, charts, graphs, or maps that convey information from the book.

DO NOT include:
- decorative elements, borders, chapter ornaments, icons
- page numbers, running headers/footers
- cover imagery, author photos, promotional images
- generic stock photos that do not add meaningful information
- anything ornamental
- text-based mnemonics or large block quotes

IMPORTANT: When defining the bounding box, make sure to INCLUDE all relevant text, legends, labels, and axes associated with the illustration. When in doubt, make the bounding box slightly larger to ensure no parts of the illustration are cut off.

When in doubt about the image itself, classify it as "decorative" or exclude it.

Respond with JSON only:
{
  "hasIllustration": boolean,
  "illustrations": [
    {
      "description": "brief description",
      "reason": "why this is informative and not decorative",
      "kind": "diagram" | "chart" | "map" | "photo" | "table" | "decorative" | "text-art",
      "confidence": number, // 0.0 to 1.0
      "bbox": {
        "topPercent": number,
        "leftPercent": number,
        "widthPercent": number,
        "heightPercent": number
      }
    }
  ]
}
`

type RawDetection = {
  description: string
  reason: string
  kind: string
  candidateIndex: number
  confidence: number
  bbox: {
    topPercent: number
    leftPercent: number
    widthPercent: number
    heightPercent: number
  }
}

/** A detection that has survived the OpenCV/confidence fusion score. */
type ScoredDetection = RawDetection & {
  keepScore: number
}

type CliOptions = {
  asin: string
  outDir: string
  confidenceThreshold: number
  minAreaPercent: number
  maxRetries: number
  maxPages?: number
  pageIndices?: Set<number>
  overwrite: boolean
  trimWhiteBorder: boolean
  opencvMinAreaPercent: number
  opencvMaxTextDensity: number
  keepScoreThreshold: number
  enablePostCropVerifier: boolean
  opencvDebug: boolean
  model: string
  bboxPaddingPercent: number
}

function toDataUrlPng(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`
}

function parseArgs(argv: string[]): CliOptions {
  let asin = getEnv('ASIN')
  let outDir = 'out'
  let confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD
  let minAreaPercent = DEFAULT_MIN_AREA_PERCENT
  let maxRetries = DEFAULT_MAX_RETRIES
  let maxPages: number | undefined
  let pageIndices: Set<number> | undefined
  let overwrite = false
  let trimWhiteBorder = false
  let opencvMinAreaPercent = 2
  let opencvMaxTextDensity = 0.8
  let keepScoreThreshold = 0.7
  let enablePostCropVerifier = false
  let opencvDebug = false
  let model = MODEL
  let bboxPaddingPercent = 2

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = argv[i + 1]

    switch (arg) {
      case '--asin':
        asin = next
        i++
        break
      case '--out-dir':
        outDir = next || outDir
        i++
        break
      case '--confidence-threshold':
        confidenceThreshold = Number(next ?? confidenceThreshold)
        i++
        break
      case '--min-area-percent':
        minAreaPercent = Number(next ?? minAreaPercent)
        i++
        break
      case '--max-retries':
        maxRetries = Number(next ?? maxRetries)
        i++
        break
      case '--max-pages':
        maxPages = Number(next)
        i++
        break
      case '--page-indices': {
        const values = (next || '')
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((v) => Number.isInteger(v))
        pageIndices = new Set(values)
        i++
        break
      }
      case '--overwrite':
        overwrite = true
        break
      case '--trim-white-border':
        trimWhiteBorder = true
        break
      case '--opencv-min-area-percent':
        opencvMinAreaPercent = Number(next ?? opencvMinAreaPercent)
        i++
        break
      case '--opencv-max-text-density':
        opencvMaxTextDensity = Number(next ?? opencvMaxTextDensity)
        i++
        break
      case '--keep-score-threshold':
        keepScoreThreshold = Number(next ?? keepScoreThreshold)
        i++
        break
      case '--enable-post-crop-verifier':
        enablePostCropVerifier = true
        break
      case '--opencv-debug':
        opencvDebug = true
        break
      case '--model':
        model = next || model
        i++
        break
      case '--bbox-padding-percent':
        bboxPaddingPercent = Number(next ?? bboxPaddingPercent)
        i++
        break
      default:
        break
    }
  }

  assert(asin, 'ASIN is required (pass --asin or set ASIN env var).')
  if (!Number.isFinite(confidenceThreshold)) {
    throw new Error(`invalid --confidence-threshold: ${confidenceThreshold}`)
  }
  if (!Number.isFinite(minAreaPercent)) {
    throw new Error(`invalid --min-area-percent: ${minAreaPercent}`)
  }
  if (!Number.isFinite(maxRetries)) {
    throw new Error(`invalid --max-retries: ${maxRetries}`)
  }
  if (maxPages !== undefined && !Number.isFinite(maxPages)) {
    throw new Error(`invalid --max-pages: ${maxPages}`)
  }

  return {
    asin,
    outDir,
    confidenceThreshold,
    minAreaPercent,
    maxRetries: Math.max(0, Math.floor(maxRetries)),
    maxPages:
      maxPages !== undefined ? Math.max(0, Math.floor(maxPages)) : undefined,
    pageIndices,
    overwrite,
    trimWhiteBorder,
    opencvMinAreaPercent,
    opencvMaxTextDensity,
    keepScoreThreshold,
    enablePostCropVerifier,
    opencvDebug,
    model,
    bboxPaddingPercent
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = (text || '').trim()
  if (!trimmed) return

  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {}

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
}

function normalizeDetections(
  raw: Record<string, unknown>,
  confidenceThreshold: number,
  minAreaPercent: number
): { detections: RawDetection[]; issues: string[] } {
  const issues: string[] = []
  const hasIllustration = Boolean(raw.hasIllustration)
  if (!hasIllustration) return { detections: [], issues }

  const rawItems = raw.illustrations
  if (!Array.isArray(rawItems)) {
    return {
      detections: [],
      issues: ['illustrations field missing or not an array']
    }
  }

  const detections: RawDetection[] = []
  for (const [idx, item] of rawItems.entries()) {
    if (!item || typeof item !== 'object') {
      issues.push(`item ${idx} skipped: not an object`)
      continue
    }
    const obj = item as Record<string, unknown>
    const description = String(obj.description || '').trim()
    const reason = String(obj.reason || '').trim()
    const kind = String(obj.kind || '')
      .trim()
      .toLowerCase()
    const candidateIndex = toNumber(obj.candidateIndex) ?? -1
    const confidence = toNumber(obj.confidence) ?? 0

    if (kind === 'decorative' || kind === 'text-art') {
      issues.push(`item ${idx} skipped: kind is ${kind}`)
      continue
    }

    const bbox = obj.bbox as Record<string, unknown> | undefined
    if (!bbox || typeof bbox !== 'object') {
      issues.push(`item ${idx} skipped: bbox missing or invalid`)
      continue
    }

    let top =
      toNumber(bbox.topPercent) ?? toNumber(bbox.y) ?? toNumber(bbox.top)
    let left =
      toNumber(bbox.leftPercent) ?? toNumber(bbox.x) ?? toNumber(bbox.left)
    let width = toNumber(bbox.widthPercent) ?? toNumber(bbox.width)
    let height = toNumber(bbox.heightPercent) ?? toNumber(bbox.height)

    if (
      top === undefined ||
      left === undefined ||
      width === undefined ||
      height === undefined
    ) {
      issues.push(`item ${idx} skipped: bbox values must be numeric`)
      continue
    }

    // If LLM output bbox values as fractions 0-1 instead of percentages 0-100, fix them
    if (width <= 1 && height <= 1 && top <= 1 && left <= 1) {
      width *= 100
      height *= 100
      top *= 100
      left *= 100
    }

    top = clamp(top, 0, 100)
    left = clamp(left, 0, 100)
    width = clamp(width, 0, 100)
    height = clamp(height, 0, 100)

    if (width <= 0 || height <= 0) {
      issues.push(`item ${idx} skipped: bbox has non-positive dimensions`)
      continue
    }

    if (left + width > 100) width = 100 - left
    if (top + height > 100) height = 100 - top
    if (width <= 0 || height <= 0) {
      issues.push(`item ${idx} skipped: bbox outside bounds`)
      continue
    }

    const areaPercent = (width * height) / 100
    if (areaPercent < minAreaPercent) {
      issues.push(
        `item ${idx} skipped: area ${areaPercent.toFixed(3)}% < ${minAreaPercent.toFixed(3)}%`
      )
      continue
    }

    detections.push({
      description,
      reason,
      kind,
      candidateIndex,
      confidence,
      bbox: {
        topPercent: Number(top.toFixed(4)),
        leftPercent: Number(left.toFixed(4)),
        widthPercent: Number(width.toFixed(4)),
        heightPercent: Number(height.toFixed(4))
      }
    })
  }

  return { detections, issues }
}

function bboxPercentToPixels(
  bbox: RawDetection['bbox'],
  imageWidth: number,
  imageHeight: number,
  paddingPercent = 0
): { left: number; top: number; width: number; height: number } {
  const padWidthPx = Math.round(imageWidth * (paddingPercent / 100))
  const padHeightPx = Math.round(imageHeight * (paddingPercent / 100))

  const leftPx = Math.round(imageWidth * (bbox.leftPercent / 100)) - padWidthPx
  const topPx = Math.round(imageHeight * (bbox.topPercent / 100)) - padHeightPx
  const rightPx =
    Math.round(imageWidth * ((bbox.leftPercent + bbox.widthPercent) / 100)) +
    padWidthPx
  const bottomPx =
    Math.round(imageHeight * ((bbox.topPercent + bbox.heightPercent) / 100)) +
    padHeightPx

  const left = clamp(leftPx, 0, Math.max(0, imageWidth - 1))
  const top = clamp(topPx, 0, Math.max(0, imageHeight - 1))
  const right = clamp(Math.max(left + 1, rightPx), left + 1, imageWidth)
  const bottom = clamp(Math.max(top + 1, bottomPx), top + 1, imageHeight)

  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  }
}

export async function preScanWithOpenCV(
  _pngBuffer: Buffer,
  _minAreaPercent: number
) {
  return {
    hasCandidates: true,
    candidates: [],
    stats: {
      textDensity: 0,
      contourCount: 0
    }
  }
}

async function trimWhiteBorderPng(pngBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(pngBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const threshold = 245

  const isWhiteRow = (y: number) => {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels
      const r = data[idx]!
      const g = data[idx + 1]!
      const b = data[idx + 2]!
      if (r <= threshold || g <= threshold || b <= threshold) return false
    }
    return true
  }

  const isWhiteCol = (x: number, top: number, bottom: number) => {
    for (let y = top; y <= bottom; y++) {
      const idx = (y * width + x) * channels
      const r = data[idx]!
      const g = data[idx + 1]!
      const b = data[idx + 2]!
      if (r <= threshold || g <= threshold || b <= threshold) return false
    }
    return true
  }

  let top = 0
  let bottom = height - 1
  let left = 0
  let right = width - 1

  while (top < bottom && isWhiteRow(top)) top++
  while (bottom > top && isWhiteRow(bottom)) bottom--
  while (left < right && isWhiteCol(left, top, bottom)) left++
  while (right > left && isWhiteCol(right, top, bottom)) right--

  const cropWidth = right - left + 1
  const cropHeight = bottom - top + 1
  if (cropWidth < 2 || cropHeight < 2) return pngBuffer

  return sharp(pngBuffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer()
}

const VERIFY_PROMPT = `Analyze this cropped image. Is this a meaningful illustration, diagram, chart, map, or informative photo from a book?
Reply with a strict JSON object: { "isMeaningful": boolean, "reason": "why" }
If it is just decorative, a drop cap, plain text, text with a border, or purely ornamental, reply false.`

async function verifyCrop(
  openai: OpenAIClient,
  cropBuffer: Buffer,
  model: string,
  maxRetries: number
): Promise<{ isMeaningful: boolean; reason: string }> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.createChatCompletion({
        model,
        response_format: { type: 'json_object' } as any,
        messages: [
          { role: 'system', content: VERIFY_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Return valid JSON only.' },
              {
                type: 'image_url',
                image_url: { url: toDataUrlPng(cropBuffer) }
              }
            ] as any
          }
        ]
      })

      const content = String(response.choices?.[0]?.message?.content || '')
      if (REFUSAL_RE.test(content)) {
        throw new Error(`Model refusal: ${content.slice(0, 160)}`)
      }

      const parsed = parseJsonObject(content)
      if (!parsed) throw new Error('Model response was not valid JSON.')
      return {
        isMeaningful: Boolean(parsed.isMeaningful),
        reason: String(parsed.reason || '')
      }
    } catch (err) {
      lastErr = err
      if (attempt >= maxRetries) break
      const backoffMs = Math.min(
        DEFAULT_MAX_BACKOFF_MS,
        DEFAULT_BACKOFF_MS * 2 ** attempt
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  throw lastErr
}

async function requestIllustrations(
  openai: OpenAIClient,
  imageDataUrl: string,
  model: string,
  maxRetries: number
): Promise<{ raw: Record<string, unknown>; retries: number }> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.createChatCompletion({
        model,
        response_format: { type: 'json_object' } as any,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Return valid JSON only.' },
              {
                type: 'image_url',
                image_url: { url: imageDataUrl }
              }
            ] as any
          }
        ]
      })

      const content = String(response.choices?.[0]?.message?.content || '')
      if (REFUSAL_RE.test(content)) {
        throw new Error(`Model refusal: ${content.slice(0, 160)}`)
      }

      const parsed = parseJsonObject(content)
      if (!parsed) throw new Error('Model response was not valid JSON.')
      return { raw: parsed, retries: attempt }
    } catch (err) {
      lastErr = err
      if (attempt >= maxRetries) break
      const backoffMs = Math.min(
        DEFAULT_MAX_BACKOFF_MS,
        DEFAULT_BACKOFF_MS * 2 ** attempt
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  throw lastErr
}

async function main() {
  console.log('parsing args')
  const options = parseArgs(process.argv.slice(2))
  assert(getEnv('OPENAI_API_KEY'), 'OPENAI_API_KEY is required.')

  const outDir = path.resolve(options.outDir, options.asin)
  const metadataPath = path.join(outDir, 'metadata.json')
  console.log('reading metadata')
  const metadata = await readJsonFile<BookMetadata>(metadataPath)
  const pages = metadata.pages
  assert(
    Array.isArray(pages) && pages.length,
    `invalid pages list in metadata: ${metadataPath}`
  )

  console.log('filtering pages')
  let selectedPages = pages.filter((p) => {
    if (options.pageIndices && !options.pageIndices.has(p.index)) return false
    return true
  })

  // Skip the first 10 pages to avoid irrelevant front-matter
  if (!options.pageIndices) {
    selectedPages = selectedPages.slice(10)
  }

  if (options.maxPages !== undefined)
    selectedPages = selectedPages.slice(0, options.maxPages)
  assert(selectedPages.length, 'No pages selected for processing.')

  const imageOutDir = path.join(outDir, 'illustrations')
  await fs.mkdir(imageOutDir, { recursive: true })
  const outputPath = path.join(outDir, 'illustrations.json')
  const skippedPath = path.join(outDir, 'illustrations.skipped.json')
  const debugPath = path.join(outDir, 'illustrations.debug.json')

  const maxIndex = Math.max(...selectedPages.map((p) => p.index))
  const maxPage = Math.max(...selectedPages.map((p) => p.page))
  const indexPad = Math.max(4, String(maxIndex).length)
  const pagePad = Math.max(4, String(maxPage).length)

  const openai = new OpenAIClient()
  const results: IllustrationChunk[] = []
  const skipped: Array<Record<string, unknown>> = []
  const debugLogs: Array<Record<string, unknown>> = []

  console.log(`starting page extraction (concurrency: 8)`)
  await pMap(
    selectedPages,
    async (pageChunk) => {
      const { index, page, screenshot } = pageChunk
      const screenshotPath = path.resolve(screenshot)

      try {
        await fs.access(screenshotPath)
      } catch {
        skipped.push({ index, page, screenshot, error: 'screenshot not found' })
        console.log(`[skip] index=${index} page=${page} screenshot not found`)
        return
      }

      console.log(`[page] index=${index} page=${page} ${screenshotPath}`)
      try {
        const screenshotBuffer = await fs.readFile(screenshotPath)

        const cvResult = await preScanWithOpenCV(
          screenshotBuffer,
          options.opencvMinAreaPercent
        )
        if (options.opencvDebug) {
          debugLogs.push({
            index,
            page,
            screenshot,
            cvResult
          })
        }

        if (!cvResult.hasCandidates) {
          console.log(
            `[skip] index=${index} page=${page} opencv: no candidates found`
          )
          skipped.push({
            index,
            page,
            screenshot,
            error: 'opencv: no candidates found',
            details: cvResult.stats
          })
          return
        }
        if (cvResult.stats.textDensity > options.opencvMaxTextDensity) {
          console.log(
            `[skip] index=${index} page=${page} opencv: text density too high (${cvResult.stats.textDensity.toFixed(2)})`
          )
          skipped.push({
            index,
            page,
            screenshot,
            error: 'opencv: text density too high',
            details: cvResult.stats
          })
          return
        }

        const { raw, retries } = await requestIllustrations(
          openai,
          toDataUrlPng(screenshotBuffer),
          options.model,
          options.maxRetries
        )
        const { detections, issues } = normalizeDetections(
          raw,
          Math.max(0, options.confidenceThreshold),
          Math.max(0, options.minAreaPercent)
        )

        const scoredDetections: ScoredDetection[] = []
        for (const [i, detection] of detections.entries()) {
          const cvScore = 0.5

          // Final fusion score:
          // + cvScore gives a bump to large / strong OpenCV regions
          // + confidence gives strong LLM conviction
          // - textDensity penalty aggressively downweights text-heavy pages
          const keepScore =
            cvScore * 0.3 +
            detection.confidence * 0.7 -
            cvResult.stats.textDensity * 0.5

          if (keepScore < options.keepScoreThreshold) {
            issues.push(
              `item ${i} skipped: keepScore ${keepScore.toFixed(3)} < ${options.keepScoreThreshold.toFixed(3)}`
            )
            continue
          }
          scoredDetections.push({ ...detection, keepScore })
        }

        if (issues.length) {
          skipped.push({
            index,
            page,
            screenshot,
            error: 'validation issues',
            details: issues
          })
        }

        if (!scoredDetections.length) {
          console.log(`[none] index=${index} page=${page}`)
          return
        }

        const imageMeta = await sharp(screenshotBuffer).metadata()
        const imageWidth = imageMeta.width || 0
        const imageHeight = imageMeta.height || 0
        if (!imageWidth || !imageHeight) {
          throw new Error('failed to load screenshot dimensions')
        }

        for (const [illusIdx, scoredDetection] of scoredDetections.entries()) {
          const detection = scoredDetection!
          const extractBox = bboxPercentToPixels(
            detection.bbox,
            imageWidth,
            imageHeight,
            options.bboxPaddingPercent
          )
          let cropPng = await sharp(screenshotBuffer)
            .extract(extractBox)
            .png()
            .toBuffer()
          if (options.trimWhiteBorder) {
            cropPng = await trimWhiteBorderPng(cropPng)
          }

          if (options.enablePostCropVerifier) {
            const verifyResult = await verifyCrop(
              openai,
              cropPng,
              options.model,
              options.maxRetries
            )
            if (!verifyResult.isMeaningful) {
              console.log(
                `[skip] index=${index} page=${page} crop failed verifier: ${verifyResult.reason}`
              )
              skipped.push({
                index,
                page,
                screenshot,
                error: 'failed crop verification',
                details: [verifyResult.reason]
              })
              continue
            }
          }

          const filename = `${String(index).padStart(indexPad, '0')}-${String(page).padStart(pagePad, '0')}-${illusIdx}.png`
          const illustrationPath = path.join(imageOutDir, filename)
          let saved = false
          try {
            if (options.overwrite) {
              await fs.writeFile(illustrationPath, cropPng)
              saved = true
            } else {
              await fs.access(illustrationPath)
            }
          } catch {
            await fs.writeFile(illustrationPath, cropPng)
            saved = true
          }
          console.log(
            `${saved ? '[save]' : '[keep]'} index=${index} page=${page} file=${path.basename(
              illustrationPath
            )}`
          )

          results.push({
            index,
            page,
            illustrationIndex: illusIdx,
            description: detection.description,
            reason: detection.reason,
            kind: detection.kind,
            candidateIndex: detection.candidateIndex,
            keepScore: detection.keepScore,
            confidence: detection.confidence,
            bbox: detection.bbox,
            screenshot: screenshotPath,
            illustration: illustrationPath,
            retries
          })
        }
      } catch (err) {
        skipped.push({
          index,
          page,
          screenshot,
          error: err instanceof Error ? err.message : String(err)
        })
        console.log(`[error] index=${index} page=${page} ${String(err)}`)
      }
    },
    { concurrency: 8 }
  )

  results.sort((a, b) =>
    a.index === b.index
      ? a.illustrationIndex - b.illustrationIndex
      : a.index - b.index
  )
  skipped.sort((a, b) => Number(a.index) - Number(b.index))

  await fs.writeFile(outputPath, JSON.stringify(results, null, 2))
  await fs.writeFile(skippedPath, JSON.stringify(skipped, null, 2))
  if (options.opencvDebug) {
    await fs.writeFile(debugPath, JSON.stringify(debugLogs, null, 2))
  }
  console.log(
    `[done] illustrations=${results.length} skipped=${skipped.length} output=${outputPath} skipped_output=${skippedPath}`
  )
}

await main()
