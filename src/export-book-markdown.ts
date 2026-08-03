import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk, IllustrationChunk } from './types'
import { formatContentChunks } from './postprocess-text'
import { resolveBookSections } from './toc-sections'
import {
  assert,
  getEnv,
  isDirectEntry,
  readJsonFile,
  tryReadJsonFile
} from './utils'

const MAX_MARKDOWN_FILENAME_STEM_LENGTH = 80

function formatIllustration(illustration: IllustrationChunk): string {
  const alt = illustration.description?.trim() || 'Illustration'
  const filename = path.basename(illustration.illustration)
  const relativeImagePath = path.posix.join('illustrations', filename)
  return `![${alt}](${relativeImagePath})`
}

function truncateFilenameStem(stem: string): string {
  if (stem.length <= MAX_MARKDOWN_FILENAME_STEM_LENGTH) return stem

  const clipped = stem
    .slice(0, MAX_MARKDOWN_FILENAME_STEM_LENGTH)
    .replaceAll(/_[^_]*$/g, '')
    .replaceAll(/_+$/g, '')

  return clipped || stem.slice(0, MAX_MARKDOWN_FILENAME_STEM_LENGTH)
}

function filenameFromTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll('&', ' and ')
    .replaceAll(/['\u2019]/g, '')
    .replaceAll(/[^\da-zA-Z]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .toLowerCase()

  return `${truncateFilenameStem(slug || 'book')}.md`
}

function formatChunks(
  chunks: ContentChunk[],
  illustrationsByPage: Record<number, IllustrationChunk[]>,
  { headingLevel, sectionLabel, nextSectionLabel }: FormatChunksOptions = {}
): string {
  return formatContentChunks(chunks, {
    headingLevel,
    sectionLabel,
    nextSectionLabel,
    getPageBlocks: (page) =>
      (illustrationsByPage[page] ?? []).map((illustration) =>
        formatIllustration(illustration)
      )
  })
}

interface FormatChunksOptions {
  headingLevel?: number
  sectionLabel?: string
  nextSectionLabel?: string
}

export interface ExportBookMarkdownOptions {
  asin: string
  /** Root directory holding one folder per ASIN. Defaults to `out`. */
  outDir?: string
}

/**
 * Render an already-transcribed book to markdown.
 *
 * Returns the path written.
 */
export async function exportBookMarkdown({
  asin,
  outDir: root = 'out'
}: ExportBookMarkdownOptions): Promise<string> {
  const outDir = path.join(root, asin)

  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )
  const illustrations =
    (await tryReadJsonFile<IllustrationChunk[]>(
      path.join(outDir, 'illustrations.json')
    )) ?? []
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList
  const publisher = metadata.meta.publisher
  const totalPages = metadata.nav.totalNumContentPages
  const bookAsin = metadata.meta.asin
  const illustrationsByPage = illustrations.reduce(
    (acc, illustration) => {
      const list = (acc[illustration.page] ??= [])
      list.push(illustration)
      return acc
    },
    {} as Record<number, IllustrationChunk[]>
  )
  for (const items of Object.values(illustrationsByPage)) {
    items.sort((a, b) => a.illustrationIndex - b.illustrationIndex)
  }

  // Format release date from DD/MM/YYYY to a human-friendly format
  const formattedDate = (() => {
    const raw = metadata.meta.releaseDate
    if (!raw) return undefined
    const [day, month, year] = raw.split('/')
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    if (Number.isNaN(date.getTime())) return raw
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  })()

  // Format language code to display name
  const formattedLanguage = (() => {
    const code = metadata.meta.language
    if (!code) return undefined
    try {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
      return displayNames.of(code)
    } catch {
      return code
    }
  })()

  const sections = resolveBookSections(metadata.toc, content)
  assert(sections.length, 'no book sections could be resolved')

  // Build a condensed TOC summary (top-level items only)
  const topLevelTocItems = sections
    .map((section) => section.tocItem)
    .filter((tocItem) => tocItem.depth === 0)
  const tocSummary = topLevelTocItems
    .map((item) => `- ${item.label}`)
    .join('\n')

  // Build the details table, only including rows where data is available
  const detailRows: Array<[string, string | number]> = []
  if (publisher) detailRows.push(['Publisher', publisher])
  if (formattedDate) detailRows.push(['Release Date', formattedDate])
  if (formattedLanguage) detailRows.push(['Language', formattedLanguage])
  if (totalPages) detailRows.push(['Pages', totalPages])
  if (topLevelTocItems.length)
    detailRows.push(['Chapters', topLevelTocItems.length])
  if (bookAsin) detailRows.push(['ASIN', bookAsin])

  const detailsTable = detailRows.length
    ? `| | |
|---|---|
${detailRows.map(([label, value]) => `| **${label}** | ${value} |`).join('\n')}`
    : ''

  let output = `# ${title}

> By ${authors.join(', ')}

## Book Details

${detailsTable}

## Chapter Overview

${tocSummary}

---

## Table of Contents

${sections
  .map(
    ({ tocItem }) =>
      `${'  '.repeat(tocItem.depth)}- [${tocItem.label}](#${tocItem.label.toLowerCase().replaceAll(/[^\da-z]+/g, '-')})`
  )
  .join('\n')}

---`

  for (const { tocItem, chunks, nextLabel } of sections) {
    const text = formatChunks(chunks, illustrationsByPage, {
      // Section headings found in the body nest under the TOC heading below.
      headingLevel: tocItem.depth + 3,
      sectionLabel: tocItem.label,
      nextSectionLabel: nextLabel
    })

    output += `

${'#'.repeat(tocItem.depth + 2)} ${tocItem.label}

${text}`
  }

  const outputPath = path.join(outDir, filenameFromTitle(title))
  await fs.writeFile(outputPath, output)

  return outputPath
}

async function cli() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outputPath = await exportBookMarkdown({ asin })
  console.log(path.resolve(outputPath))
}

if (isDirectEntry(import.meta.url)) {
  await cli()
}
