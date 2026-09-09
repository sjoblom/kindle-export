import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PipelineEvent } from './pipeline'
import type { BookMetadata, ContentStore } from './types'

vi.mock('./config', () => ({
  loadConfig: async () => ({}),
  saveConfig: async () => '/dev/null'
}))

const { bookFellShort, EMPTY_OPTIONS, processBook } = await import('./pipeline')

let outDir: string

const ASIN = 'B00TEST'

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-pipeline-'))
})

afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true })
})

/**
 * A book whose capture died at page 2 of 10, with one of its two pages read.
 *
 * The shape that used to export in silence: `ocr` and `export` never looked at
 * the capture marker, and `export` never looked at whether the text covered
 * the pages, so both finished with nothing to say.
 */
async function writeTruncatedBook(transcribedPages = 1): Promise<void> {
  const bookDir = path.join(outDir, ASIN)
  await fs.mkdir(bookDir, { recursive: true })

  await fs.writeFile(
    path.join(bookDir, 'metadata.json'),
    JSON.stringify({
      captureId: 'capture-1',
      capture: {
        complete: false,
        reason: 'navigation-failed',
        lastPage: 2,
        totalContentPages: 10
      },
      meta: { title: 'A Truncated Book', authorList: ['Doe, Jane'] },
      nav: { totalNumPages: 10, totalNumContentPages: 10 },
      toc: [{ label: 'Chapter One', positionId: 1, page: 1, depth: 0 }],
      pages: [
        { index: 0, page: 1, screenshot: 'pages/000.png' },
        { index: 1, page: 2, screenshot: 'pages/001.png' }
      ]
    })
  )

  const content: ContentStore = {
    captureId: 'capture-1',
    chunks: Array.from({ length: transcribedPages }, (_, index) => ({
      index,
      page: index + 1,
      text: `page ${index + 1}`,
      screenshot: `pages/00${index}.png`
    }))
  }
  await fs.writeFile(
    path.join(bookDir, 'content.json'),
    JSON.stringify(content)
  )
}

/** Run one command over the fixture, collecting what it said out loud. */
async function processFixture(command: string) {
  const warnings: string[] = []
  const emit = (event: PipelineEvent) => {
    if (event.kind === 'warn') warnings.push(event.message)
  }

  const result = await processBook(
    ASIN,
    {
      ...EMPTY_OPTIONS,
      command,
      outDir,
      profileDir: path.join(outDir, '.profile')
    },
    emit
  )

  return { result, warnings }
}

describe('processBook', () => {
  it('reports a truncated capture from the export stage alone', async () => {
    // `export` runs no capture and no transcription, so it used to have no
    // opinion at all — the book was written and the run exited 0.
    await writeTruncatedBook()

    const { result, warnings } = await processFixture('export')

    expect(result.completeness).toMatchObject({
      complete: false,
      captureStoppedEarly: true,
      capturedPages: 2,
      transcribedPages: 1,
      remedy: 'capture-again'
    })
    expect(warnings.join('\n')).toContain('stopped at page 2 of 10')
    expect(warnings.join('\n')).toContain(
      `kindle-export ${ASIN} --force-capture`
    )
    expect(bookFellShort(result, 'export')).toBe(true)

    // It still writes the book it has; the point is that it says what is
    // wrong with it.
    expect(result.outputs).toHaveLength(1)
  })

  it('says a captured book has no text for some of its pages', async () => {
    // A complete capture with a hole in the transcription: the remedy is
    // reading those pages again, not throwing the capture away.
    await writeTruncatedBook()
    const metadataPath = path.join(outDir, ASIN, 'metadata.json')
    const metadata = JSON.parse(
      await fs.readFile(metadataPath, 'utf8')
    ) as BookMetadata
    metadata.capture = {
      complete: true,
      reason: 'end-of-book',
      lastPage: 2,
      totalContentPages: 2
    }
    await fs.writeFile(metadataPath, JSON.stringify(metadata))

    const { result, warnings } = await processFixture('export')

    expect(result.completeness).toMatchObject({
      complete: false,
      captureStoppedEarly: false,
      remedy: 'transcribe-again'
    })
    expect(result.completeness.missingPages).toEqual([{ index: 1, page: 2 }])
    expect(warnings.join('\n')).toContain('1 of 2 captured pages have no text')
    expect(bookFellShort(result, 'export')).toBe(true)
  })

  it('says nothing about missing text after a capture-only run', async () => {
    // `capture` is not supposed to leave any text behind, so complaining that
    // there is none would make every successful capture look like a failure.
    await writeTruncatedBook()
    await fs.rm(path.join(outDir, ASIN, 'content.json'))

    const { result, warnings } = await processFixture('capture')

    expect(result.completeness.captureStoppedEarly).toBe(true)
    expect(warnings.join('\n')).toContain('stopped at page 2 of 10')
    expect(warnings.join('\n')).not.toContain('have no text')
    expect(bookFellShort(result, 'capture')).toBe(true)
  })

  it('says a truncated capture is being reused only once', async () => {
    // The capture stage reports it when it decides to reuse the pages, and the
    // completeness check reports it again at the end; hearing it twice in one
    // run reads like two different problems.
    // Every captured page already has text, so the run reuses both stages and
    // never opens a browser — only the capture verdict is left to report.
    await writeTruncatedBook(2)

    const { warnings } = await processFixture('all')

    expect(
      warnings.filter((line) => line.includes('stopped at page 2 of 10'))
    ).toHaveLength(1)
  })
})
