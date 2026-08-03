#!/usr/bin/env node
import 'dotenv/config'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { checkbox, input } from '@inquirer/prompts'

import type { BookMetadata, ContentChunk } from './types'
import { exportBookMarkdown } from './export-book-markdown'
import { exportBookPdf } from './export-book-pdf'
import { launchBrowserContext, runExtraction } from './extract-kindle-book'
import { fetchLibrary, type LibraryBook } from './kindle-library'
import { transcribeBook } from './transcribe-book-content'
import { assert, getEnv, tryReadJsonFile } from './utils'

const VERSION = '0.3.0'

const HELP = `kindle-export — export Kindle books you own as markdown

Usage
  kindle-export                        pick books from your library, then export
  kindle-export <ASIN...>              capture, transcribe and export (resumes)
  kindle-export login                  sign in to Amazon once, storing the session
  kindle-export list                   list the books in your Kindle library
  kindle-export capture <ASIN...>      capture page images only
  kindle-export ocr <ASIN...>          transcribe captured pages only
  kindle-export export <ASIN...>       render markdown from transcribed text only

Options
  --format <md|pdf>      output format(s), comma separated (default: md)
  --json                 with 'list', print JSON instead of a table
  --limit <n>            with 'list', stop after this many books
  --out-dir <dir>        where books are written (default: ./out)
  --profile-dir <dir>    browser profile holding your session
                         (default: ~/.kindle-export/profile)
  --model <name>         vision model used for transcription
  --concurrency <n>      pages transcribed in parallel (default: 16)
  --otp <code>           2FA code, when there's no terminal to prompt on
  --force                redo every stage, ignoring existing output
  --force-capture        redo page capture
  --force-ocr            redo transcription
  --force-export         redo markdown export
  -h, --help             show this help
  -v, --version          show the version

Run 'kindle-export login' first and sign in in the browser window; the session
is stored on this machine and never leaves it. OPENAI_API_KEY is required for
transcription. AMAZON_EMAIL and AMAZON_PASSWORD are optional — set them only
if you want sign-in scripted rather than doing it yourself.

Examples
  kindle-export login
  kindle-export                        pick from a menu of your books
  kindle-export list --json
  kindle-export B01H4G2J1U
  kindle-export B01H4G2J1U B07PPW5V9C --force-ocr
  kindle-export ocr B01H4G2J1U --model gpt-5-mini`

interface Options {
  command: string
  asins: string[]
  outDir: string
  profileDir: string
  model?: string
  concurrency?: number
  otp?: string
  json: boolean
  limit?: number
  formats: Array<'md' | 'pdf'>
  forceCapture: boolean
  forceOcr: boolean
  forceExport: boolean
}

const COMMANDS = new Set(['login', 'list', 'capture', 'ocr', 'export'])

/** Above this many books, offer to filter before showing the picker. */
const FILTER_PROMPT_THRESHOLD = 30

/** Failed pages listed individually before collapsing to a count. */
const MAX_REPORTED_FAILURES = 10

/** Books that produced output but are missing pages. */
const failedBooks = new Set<string>()

function defaultProfileDir(): string {
  return path.join(os.homedir(), '.kindle-export', 'profile')
}

function parseArgs(argv: string[]): Options | undefined {
  const positional: string[] = []
  let outDir = getEnv('KINDLE_OUT_DIR') || 'out'
  let profileDir = getEnv('BROWSER_PROFILE_DIR') || defaultProfileDir()
  let model = getEnv('OCR_MODEL') || undefined
  let concurrency: number | undefined
  let otp: string | undefined
  let json = false
  let limit: number | undefined
  let formats: Array<'md' | 'pdf'> = ['md']
  let force = false
  let forceCapture = false
  let forceOcr = false
  let forceExport = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = () => {
      const value = argv[++i]
      assert(value, `${arg} requires a value`)
      return value
    }

    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP)
        return
      case '-v':
      case '--version':
        console.log(VERSION)
        return
      case '--out-dir':
        outDir = next()
        break
      case '--profile-dir':
        profileDir = next()
        break
      case '--model':
        model = next()
        break
      case '--concurrency':
        concurrency = Number.parseInt(next(), 10)
        break
      case '--otp':
        otp = next()
        break
      case '--json':
        json = true
        break
      case '--limit':
        limit = Number.parseInt(next(), 10)
        break
      case '--format': {
        const requested = next()
          .split(',')
          .map((value) => value.trim().toLowerCase())
        for (const value of requested) {
          assert(
            value === 'md' || value === 'pdf',
            `unknown format: ${value} (expected md or pdf)`
          )
        }

        formats = requested as Array<'md' | 'pdf'>
        break
      }
      case '--force':
        force = true
        break
      case '--force-capture':
      case '--force-extract':
        forceCapture = true
        break
      case '--force-ocr':
        forceOcr = true
        break
      case '--force-export':
        forceExport = true
        break
      default:
        assert(!arg.startsWith('-'), `unknown option: ${arg}`)
        positional.push(arg)
    }
  }

  const command =
    positional.length && COMMANDS.has(positional[0]!.toLowerCase())
      ? positional.shift()!.toLowerCase()
      : 'all'

  return {
    command,
    asins: positional.map((asin) => asin.trim().toUpperCase()).filter(Boolean),
    outDir,
    profileDir,
    model,
    concurrency,
    otp,
    json,
    limit,
    formats,
    forceCapture: force || forceCapture,
    forceOcr: force || forceOcr,
    forceExport: force || forceExport
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

async function readMetadata(
  outDir: string,
  asin: string
): Promise<BookMetadata | undefined> {
  return tryReadJsonFile<BookMetadata>(path.join(outDir, asin, 'metadata.json'))
}

async function readContent(
  outDir: string,
  asin: string
): Promise<ContentChunk[] | undefined> {
  return tryReadJsonFile<ContentChunk[]>(
    path.join(outDir, asin, 'content.json')
  )
}

/** Open a browser so the user can sign in once; the session persists after. */
async function login(options: Options): Promise<void> {
  await fs.mkdir(options.profileDir, { recursive: true })
  console.log(`Opening a browser using profile ${options.profileDir}`)
  console.log('Sign in to Amazon, then close the browser window to finish.\n')

  const context = await launchBrowserContext({ profileDir: options.profileDir })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto('https://read.amazon.com/kindle-library')

  await new Promise<void>((resolve) => {
    context.on('close', () => {
      resolve()
    })
  })

  console.log('Session saved. You can now run: kindle-export <ASIN>')
}

/** Read the library, always closing the browser afterwards. */
async function withLibrary(options: Options): Promise<LibraryBook[]> {
  const context = await launchBrowserContext({ profileDir: options.profileDir })

  try {
    return await fetchLibrary(context, { limit: options.limit })
  } finally {
    await context.close().catch(() => {})
    await context
      .browser()
      ?.close()
      .catch(() => {})
  }
}

function formatBookLine(book: LibraryBook): string {
  const authors = book.authors.length ? ` — ${book.authors.join(', ')}` : ''
  const progress =
    typeof book.percentageRead === 'number' && book.percentageRead > 0
      ? ` (${Math.round(book.percentageRead)}% read)`
      : ''

  return `${book.title}${authors}${progress}`
}

async function list(options: Options): Promise<void> {
  const books = await withLibrary(options)

  if (options.json) {
    console.log(JSON.stringify(books, null, 2))
    return
  }

  if (!books.length) {
    console.log('No books found in your Kindle library.')
    return
  }

  for (const book of books) {
    console.log(`${book.asin}  ${formatBookLine(book)}`)
  }

  console.log(`\n${books.length} book${books.length === 1 ? '' : 's'}`)
}

/** Let the user pick books from their library when they named none. */
async function selectFromLibrary(options: Options): Promise<string[]> {
  console.log('Reading your Kindle library…')
  const books = await withLibrary(options)

  if (!books.length) {
    console.log('No books found in your Kindle library.')
    return []
  }

  if (!process.stdin.isTTY) {
    console.error(
      'No ASINs given and no terminal to prompt on. Pass ASINs directly, or run: kindle-export list'
    )
    process.exitCode = 1
    return []
  }

  // A flat checkbox of a few hundred books is unusable, so offer to narrow it
  // down first. Empty input keeps everything.
  let shortlist = books
  if (books.length > FILTER_PROMPT_THRESHOLD) {
    const needle = (
      await input({
        message: `${books.length} books. Filter by title or author (blank for all):`
      })
    )
      .trim()
      .toLowerCase()

    if (needle) {
      shortlist = books.filter((book) =>
        `${book.title} ${book.authors.join(' ')}`.toLowerCase().includes(needle)
      )

      if (!shortlist.length) {
        console.log(`Nothing matched "${needle}".`)
        return []
      }
    }
  }

  return checkbox({
    message: `Select books to export (${shortlist.length} shown)`,
    pageSize: 15,
    choices: shortlist.map((book) => ({
      name: `${formatBookLine(book)}  [${book.asin}]`,
      value: book.asin
    }))
  })
}

async function capture(asin: string, options: Options): Promise<BookMetadata> {
  const existing = await readMetadata(options.outDir, asin)
  if (!options.forceCapture && existing?.pages?.length) {
    console.log(
      `[${asin}] capture: reusing ${existing.pages.length} existing page images`
    )
    return existing
  }

  console.log(`[${asin}] capture: opening Kindle reader`)
  // Credentials are optional: the stored session usually covers it, and if it
  // doesn't, you sign in by hand in the browser window that opens.
  await runExtraction({
    asin,
    amazonEmail: getEnv('AMAZON_EMAIL'),
    amazonPassword: getEnv('AMAZON_PASSWORD'),
    outDir: options.outDir,
    profileDir: options.profileDir,
    otp: options.otp
  })

  const metadata = await readMetadata(options.outDir, asin)
  assert(metadata?.pages?.length, `[${asin}] capture produced no page images`)
  console.log(`[${asin}] capture: ${metadata.pages.length} page images`)

  return metadata
}

async function ocr(
  asin: string,
  metadata: BookMetadata,
  options: Options
): Promise<ContentChunk[]> {
  const existing = await readContent(options.outDir, asin)
  if (
    !options.forceOcr &&
    existing?.length &&
    existing.length >= metadata.pages.length
  ) {
    console.log(`[${asin}] transcribe: reusing ${existing.length} chunks`)
    return existing
  }

  let lastReport = 0
  const { content, failedPages } = await transcribeBook({
    asin,
    outDir: options.outDir,
    model: options.model,
    concurrency: options.concurrency,
    force: options.forceOcr,
    onProgress: (done, total) => {
      // One line per 10%, so long books stay readable in a terminal.
      const step = Math.max(1, Math.floor(total / 10))
      if (done === total || done - lastReport >= step) {
        lastReport = done
        console.log(`[${asin}] transcribe: ${done}/${total} pages`)
      }
    }
  })

  assert(content.length, `[${asin}] transcription produced no text`)

  if (failedPages.length) {
    // The book is still worth exporting, but it has holes in it and the user
    // has to know which pages, and that re-running will retry just those.
    console.error(
      `[${asin}] ${failedPages.length} of ${metadata.pages.length} pages could not be read:`
    )
    for (const failure of failedPages.slice(0, MAX_REPORTED_FAILURES)) {
      console.error(`  page ${failure.page} (${failure.error})`)
    }
    if (failedPages.length > MAX_REPORTED_FAILURES) {
      console.error(
        `  ...and ${failedPages.length - MAX_REPORTED_FAILURES} more`
      )
    }
    console.error(
      `[${asin}] the export below is missing those pages — re-run to retry just them`
    )
    failedBooks.add(asin)
  }

  return content
}

async function processBook(asin: string, options: Options): Promise<string> {
  const startedAt = Date.now()

  const metadata =
    options.command === 'ocr' || options.command === 'export'
      ? await readMetadata(options.outDir, asin)
      : await capture(asin, options)
  assert(
    metadata?.pages?.length,
    `[${asin}] no captured pages — run 'kindle-export capture ${asin}' first`
  )

  if (options.command === 'capture') {
    return path.join(options.outDir, asin)
  }

  const content =
    options.command === 'export'
      ? await readContent(options.outDir, asin)
      : await ocr(asin, metadata, options)
  assert(
    content?.length,
    `[${asin}] no transcribed text — run 'kindle-export ocr ${asin}' first`
  )

  if (options.command === 'ocr') {
    return path.join(options.outDir, asin, 'content.json')
  }

  const written: string[] = []
  for (const format of options.formats) {
    written.push(
      format === 'pdf'
        ? await exportBookPdf({ asin, outDir: options.outDir })
        : await exportBookMarkdown({ asin, outDir: options.outDir })
    )
  }

  console.log(
    `[${asin}] done in ${formatDuration(Date.now() - startedAt)}: ${written
      .map((file) => path.resolve(file))
      .join(', ')}`
  )

  return written[0]!
}

async function main() {
  let options: Options | undefined
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    // Usage errors deserve a one-line message, not a stack trace.
    console.error(`kindle-export: ${(err as Error)?.message ?? err}`)
    console.error("Run 'kindle-export --help' for usage.")
    process.exitCode = 1
    return
  }

  if (!options) return

  if (options.command === 'login') {
    await login(options)
    return
  }

  if (options.command === 'list') {
    await list(options)
    return
  }

  if (!options.asins.length) {
    // Naming no book is a request to choose one, not a usage error — the whole
    // point is not having to look ASINs up by hand.
    options.asins = await selectFromLibrary(options)
    if (!options.asins.length) return
  }

  const failures: string[] = []
  for (const asin of options.asins) {
    try {
      await processBook(asin, options)
    } catch (err) {
      failures.push(asin)
      console.error(`[${asin}] failed: ${(err as Error)?.message ?? err}`)
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${options.asins.length} failed`)
  }

  if (failedBooks.size) {
    console.error(
      `${failedBooks.size} book(s) exported with missing pages: ${[...failedBooks].join(', ')}`
    )
  }

  // Incomplete output is not success, even though a file was written.
  if (failures.length || failedBooks.size) {
    process.exitCode = 1
  }
}

await main()
