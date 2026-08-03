#!/usr/bin/env node
import 'dotenv/config'

import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkbox, confirm, input, password } from '@inquirer/prompts'

import type { BookMetadata, ContentChunk } from './types'
import { describeIncompleteCapture } from './capture-status'
import { cleanPageImages, cleanRenderData, formatBytes } from './cleanup'
import { loadConfig, saveConfig } from './config'
import { exportBookMarkdown } from './export-book-markdown'
import { exportBookPdf } from './export-book-pdf'
import { launchBrowserContext, runExtraction } from './extract-kindle-book'
import { fetchLibrary, type LibraryBook } from './kindle-library'
import { transcribeBook } from './transcribe-book-content'
import { assert, getEnv, tryReadJsonFile } from './utils'

const VERSION = '0.3.0'

const HELP = `kindle-export — export Kindle books you own as markdown

Usage
  kindle-export setup                  store your API key and defaults
  kindle-export                        pick books from your library, then export
  kindle-export <ASIN...>              capture, transcribe and export (resumes)
  kindle-export login                  sign in to Amazon once, storing the session
  kindle-export list                   list the books in your Kindle library
  kindle-export clean [ASIN...]        delete working files, keeping the text
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
  --keep-pages           keep page images instead of deleting them once
                         every page has been transcribed
  -h, --help             show this help
  -v, --version          show the version

Run 'kindle-export setup' once to store your OpenAI key and defaults in
~/.kindle-export/config.json, then 'kindle-export login' to sign in. The
session stays on this machine. Settings can also come from flags or a .env
file, which take precedence. AMAZON_EMAIL and AMAZON_PASSWORD are optional —
set them only if you want sign-in scripted rather than doing it yourself.

Page images are deleted once a book is fully transcribed, since re-capturing
costs time rather than data. Pass --keep-pages to hold on to them.

Examples
  kindle-export setup
  kindle-export                        pick from a menu of your books
  kindle-export list --json
  kindle-export B01H4G2J1U
  kindle-export B01H4G2J1U B07PPW5V9C --force-ocr
  kindle-export ocr B01H4G2J1U --model gpt-5-mini`

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
  formats: Array<'md' | 'pdf'>
  keepPages: boolean
  forceCapture: boolean
  forceOcr: boolean
  forceExport: boolean
}

const COMMANDS = new Set([
  'setup',
  'login',
  'list',
  'clean',
  'capture',
  'ocr',
  'export'
])

/** Above this many books, offer to filter before showing the picker. */
const FILTER_PROMPT_THRESHOLD = 30

/** Failed pages listed individually before collapsing to a count. */
const MAX_REPORTED_FAILURES = 10
const ASIN_REGEX = /^[A-Z0-9]+$/

/** Books that produced output but are missing pages. */
const failedBooks = new Set<string>()

/** Shown by `setup` as the suggested transcription model. */
const DEFAULT_MODEL = 'gpt-4.1-mini'

/** Nothing supplied by hand; applyConfig fills every path in. */
const EMPTY_OPTIONS: Options = {
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

function defaultProfileDir(): string {
  return path.join(os.homedir(), '.kindle-export', 'profile')
}

export function parseArgs(argv: string[]): Options | undefined {
  const positional: string[] = []
  let outDir: string | undefined
  let profileDir: string | undefined
  let model: string | undefined
  let concurrency: number | undefined
  let keepPages = false
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
      case '--keep-pages':
        keepPages = true
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

  const asins = positional
    .map((asin) => asin.trim().toUpperCase())
    .filter(Boolean)
  for (const asin of asins) {
    // An ASIN is alphanumeric, and it's also used as a directory name — so
    // without this, a typo like `clean ..` resolves outside the book folder and
    // deletes something that has nothing to do with the export.
    assert(ASIN_REGEX.test(asin), `invalid ASIN: ${asin}`)
  }

  return {
    command,
    asins,
    outDir: outDir!,
    profileDir: profileDir!,
    model,
    concurrency,
    otp,
    json,
    limit,
    formats,
    keepPages,
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

async function setup(): Promise<void> {
  const stored = await loadConfig()

  console.log('Settings are stored in your home directory, so kindle-export')
  console.log('works from any folder. Press enter to keep a current value.\n')

  const openaiApiKey =
    (await password({
      message: stored.openaiApiKey
        ? 'OpenAI API key (enter to keep existing):'
        : 'OpenAI API key:',
      mask: '*'
    })) || stored.openaiApiKey

  const model = await input({
    message: 'Model used to read page images:',
    default: stored.model ?? DEFAULT_MODEL
  })

  const outDir = await input({
    message: 'Where should books be written?',
    default: stored.outDir ?? 'out'
  })

  const target = await saveConfig({
    ...stored,
    openaiApiKey: openaiApiKey || undefined,
    model: model.trim() || undefined,
    outDir: outDir.trim() || undefined
  })

  console.log(`\nSaved to ${target} (readable only by you).`)

  if (!openaiApiKey) {
    console.log('No API key stored — transcription will not work until one is.')
  }

  const wantsLogin = await confirm({
    message: 'Sign in to Amazon now?',
    default: true
  })
  if (wantsLogin) {
    await login(await applyConfig({ ...EMPTY_OPTIONS, command: 'login' }))
  }
}

async function clean(options: Options): Promise<void> {
  const asins = options.asins.length
    ? options.asins
    : await listBookDirs(options.outDir)

  if (!asins.length) {
    console.log(`No books found in ${options.outDir}`)
    return
  }

  let freed = 0
  for (const asin of asins) {
    const render = await cleanRenderData(options.outDir, asin)
    freed += render.freed

    // Page images only go when the text is complete, otherwise a retry
    // silently becomes a re-capture.
    let pages = { freed: 0, removed: [] as string[] }
    if (!options.keepPages) {
      const content = await readContent(options.outDir, asin)
      const metadata = await readMetadata(options.outDir, asin)
      const complete =
        !!content?.length &&
        !!metadata?.pages?.length &&
        content.length >= metadata.pages.length

      if (complete) {
        pages = await cleanPageImages(options.outDir, asin)
      } else if (content?.length) {
        console.log(
          `[${asin}] keeping page images: transcription is incomplete`
        )
      }
    }

    freed += pages.freed
    if (render.freed || pages.freed) {
      console.log(`[${asin}] freed ${formatBytes(render.freed + pages.freed)}`)
    }
  }

  console.log(`\nFreed ${formatBytes(freed)} in total.`)
}

async function listBookDirs(outDir: string): Promise<string[]> {
  const entries = await fs
    .readdir(outDir, { withFileTypes: true })
    .catch(() => [])

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .toSorted()
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

/**
 * Say so when the pages on disk are only part of a book.
 *
 * Truncated captures look identical to finished ones — a shorter book — so
 * without this a run that died at chapter 3 exports cleanly and silently.
 */
function reportIncompleteCapture(asin: string, metadata: BookMetadata): void {
  const lines = describeIncompleteCapture(metadata)
  if (!lines) return

  for (const line of lines) {
    console.error(`[${asin}] ${line}`)
  }
  failedBooks.add(asin)
}

async function capture(asin: string, options: Options): Promise<BookMetadata> {
  const existing = await readMetadata(options.outDir, asin)
  if (!options.forceCapture && existing?.pages?.length) {
    console.log(
      `[${asin}] capture: reusing ${existing.pages.length} existing page images`
    )
    reportIncompleteCapture(asin, existing)
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
  reportIncompleteCapture(asin, metadata)

  // Amazon's render payloads are only useful during the capture itself.
  const render = await cleanRenderData(options.outDir, asin)
  if (render.freed) {
    console.log(
      `[${asin}] capture: freed ${formatBytes(render.freed)} of render data`
    )
  }

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

  // Page images are only the input to this step. Once every page has text
  // they're dead weight, and re-capturing costs time rather than data.
  if (!options.keepPages && !failedPages.length) {
    const pages = await cleanPageImages(options.outDir, asin)
    if (pages.freed) {
      console.log(
        `[${asin}] transcribe: freed ${formatBytes(pages.freed)} of page images`
      )
    }
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

  if (options.command === 'setup') {
    await setup()
    return
  }

  options = await applyConfig(options)

  if (options.command === 'clean') {
    await clean(options)
    return
  }

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

/**
 * Whether this module was launched directly, rather than imported.
 *
 * npm installs `bin` entries as symlinks, so the launched path and this
 * module's own path are different files on disk until both are resolved —
 * compare them raw and a globally installed `kindle-export` does nothing at
 * all. Anything unresolvable falls through to running: a CLI that runs when it
 * shouldn't is a test artefact, one that silently exits is a broken install.
 */
function isDirectEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return true
  }
}

if (isDirectEntryPoint()) {
  await main()
}
