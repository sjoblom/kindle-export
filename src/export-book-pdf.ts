import 'dotenv/config'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import PDFDocument from 'pdfkit'

import type { BookMetadata } from './types'
import { readContentChunks } from './content-store'
import { formatContentChunks } from './postprocess-text'
import { resolveBookSections } from './toc-sections'
import { assert } from './utils'

export interface ExportBookPdfOptions {
  asin: string
  /** Root directory holding one folder per ASIN. Defaults to `out`. */
  outDir?: string
}

/**
 * Render an already-transcribed book to PDF.
 *
 * Returns the path written.
 */
export async function exportBookPdf({
  asin,
  outDir: root = 'out'
}: ExportBookPdfOptions): Promise<string> {
  const outDir = path.join(root, asin)

  const content = (await readContentChunks(outDir)) ?? []
  const metadata = JSON.parse(
    await fsp.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as BookMetadata
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: {
      Title: title,
      Author: authors.join(', ')
    }
  })
  const outputPath = path.join(outDir, 'book.pdf')
  const stream = doc.pipe(fs.createWriteStream(outputPath))

  const fontSize = 12

  const renderTitlePage = () => {
    ;(doc as any).outline.addItem('Title Page')
    doc.fontSize(48)
    doc.y = doc.page.height / 2 - doc.heightOfString(title) / 2
    doc.text(title, { align: 'center' })
    const w = doc.widthOfString(title)

    const byline = `By ${authors.join(',\n')}`

    doc.fontSize(20)
    doc.y -= doc.heightOfString(byline) / 2
    doc.text(byline, {
      align: 'center',
      indent: w - doc.widthOfString(byline)
    })

    doc.addPage()
    doc.fontSize(fontSize)
  }

  renderTitlePage()

  let needsNewPage = false

  for (const { tocItem, chunks, nextLabel } of resolveBookSections(
    metadata.toc,
    content
  )) {
    if (needsNewPage) {
      doc.addPage()
    }

    // Aggregate all of the chunks in this chapter into a single string.
    // Headings stay plain paragraphs here since pdfkit renders raw text.
    const text = formatContentChunks(chunks, {
      detectHeadings: false,
      sectionLabel: tocItem.label,
      nextSectionLabel: nextLabel
    })

    ;(doc as any).outline.addItem(tocItem.label)
    doc.fontSize(tocItem.depth === 1 ? 16 : 20)
    doc.text(tocItem.label, { align: 'center', lineGap: 16 })

    doc.fontSize(fontSize)
    doc.moveDown(1)

    doc.text(text, {
      indent: 20,
      lineGap: 4,
      paragraphGap: 8
    })

    needsNewPage = true
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })

  return outputPath
}
