import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { formatContentChunks } from './postprocess-text'
import { resolveBookSections } from './toc-sections'
import { readJsonFile } from './utils'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function formatChunks(
  chunks: ContentChunk[],
  options?: {
    headingLevel?: number
    sectionLabel?: string
    nextSectionLabel?: string
  }
): string {
  return formatContentChunks(chunks, options)
}

function generateBookMarkdown(
  metadata: BookMetadata,
  content: ContentChunk[]
): string {
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

  return output
}

async function main() {
  const outDir = 'out'
  const allMarkdownDir = path.join(outDir, 'all', 'markdown')

  // Ensure output directory exists
  await fs.mkdir(allMarkdownDir, { recursive: true })

  // Find all book directories (named with ASINs)
  const entries = await fs.readdir(outDir, { withFileTypes: true })
  const bookDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'all')
    .map((entry) => entry.name)
    .toSorted()

  if (!bookDirs.length) {
    console.log('No book directories found in out/')
    return
  }

  console.log(`Found ${bookDirs.length} book(s) to export\n`)

  let exported = 0
  let skipped = 0

  for (const asin of bookDirs) {
    const bookDir = path.join(outDir, asin)
    const metadataPath = path.join(bookDir, 'metadata.json')
    const contentPath = path.join(bookDir, 'content.json')

    // Check that both files exist
    try {
      await fs.access(metadataPath)
      await fs.access(contentPath)
    } catch {
      console.log(`Skipping ${asin}: missing metadata.json or content.json`)
      skipped++
      continue
    }

    const metadata = await readJsonFile<BookMetadata>(metadataPath)
    const content = await readJsonFile<ContentChunk[]>(contentPath)

    if (!content.length || !metadata.meta || !metadata.toc?.length) {
      console.log(`Skipping ${asin}: incomplete data`)
      skipped++
      continue
    }

    const title = metadata.meta.title
    const slug = slugify(title)
    const filename = `${asin}-${slug}.md`

    const markdown = generateBookMarkdown(metadata, content)
    await fs.writeFile(path.join(allMarkdownDir, filename), markdown)

    console.log(`Exported: ${filename}`)
    exported++
  }

  console.log(
    `\nDone! Exported ${exported} book(s) to ${allMarkdownDir}/${skipped ? ` (${skipped} skipped)` : ''}`
  )
}

await main()
