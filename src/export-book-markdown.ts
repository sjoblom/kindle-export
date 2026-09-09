import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { readContentChunks } from './content-store'
import { formatContentChunks } from './postprocess-text'
import { resolveBookSections } from './toc-sections'
import { assert, readJsonFile } from './utils'

const MAX_MARKDOWN_FILENAME_STEM_LENGTH = 80

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
  { headingLevel, sectionLabel, nextSectionLabel }: FormatChunksOptions = {}
): string {
  return formatContentChunks(chunks, {
    headingLevel,
    sectionLabel,
    nextSectionLabel
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

  const content = (await readContentChunks(outDir)) ?? []
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
    const text = formatChunks(chunks, {
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
