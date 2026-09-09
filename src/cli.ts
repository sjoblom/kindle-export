#!/usr/bin/env node
import 'dotenv/config'

import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkbox, confirm, input, password } from '@inquirer/prompts'

import { isBookBusyError, withBookLock } from './book-lock'
import { bookCompleteness } from './capture-status'
import { cleanPageImages, cleanRenderData, formatBytes } from './cleanup'
import { loadConfig, saveConfig } from './config'
import { readContentStore } from './content-store'
import { isProfileBusyError, launchBrowserContext } from './extract-kindle-book'
import { fetchLibrary, type LibraryBook } from './kindle-library'
import {
  applyConfig,
  bookFellShort,
  EMPTY_OPTIONS,
  type Options,
  type PipelineEvent,
  processBook,
  readMetadata
} from './pipeline'
import { startServer } from './serve'
import { interactiveLogin } from './session'
import { assert } from './utils'
import { isVisionOcrAvailable } from './vision-ocr'

export { applyConfig, type Options } from './pipeline'

const VERSION = '0.3.0'

const HELP = `kindle-export — export Kindle books you own as markdown

Usage
  kindle-export setup                  store your API key and defaults
  kindle-export serve                  open the web app in your browser
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
  --model <name>         read pages with an OpenAI model instead of locally
                         (needs an API key; macOS reads them for free)
  --concurrency <n>      pages transcribed in parallel (default: 16)
  --port <n>             with 'serve', the port to listen on (default: 8484)
  --otp <code>           2FA code, when there's no terminal to prompt on
  --force                redo every stage, ignoring existing output
  --force-capture        redo page capture
  --force-ocr            redo transcription
  --force-export         redo markdown export
  --keep-pages           keep page images instead of deleting them once
                         every page has been transcribed
  -h, --help             show this help
  -v, --version          show the version

The web app ('kindle-export serve') walks through the same steps in a browser:
store the API key, sign in to Amazon, tick the books, download the results.

On macOS, pages are read on this machine for free using Apple's Vision
framework — no API key, no network, no per-page cost. Pass --model to use an
OpenAI model instead, which needs a key; that is also the fallback elsewhere.

Run 'kindle-export login' to sign in to Amazon; the session stays on this
machine. 'kindle-export setup' stores defaults (and a key, if you want one) in
~/.kindle-export/config.json. Settings can also come from flags or a .env
file, which take precedence. AMAZON_EMAIL and AMAZON_PASSWORD are optional —
set them only if you want sign-in scripted rather than doing it yourself.

Page images are deleted once a book is fully transcribed, since re-capturing
costs time rather than data. Pass --keep-pages to hold on to them.

Examples
  kindle-export setup
  kindle-export serve
  kindle-export                        pick from a menu of your books
  kindle-export list --json
  kindle-export B01H4G2J1U
  kindle-export B01H4G2J1U B07PPW5V9C --force-ocr
  kindle-export ocr B01H4G2J1U --model gpt-5-mini`

const COMMANDS = new Set([
  'setup',
  'serve',
  'login',
  'list',
  'clean',
  'capture',
  'ocr',
  'export'
])

/** Above this many books, offer to filter before showing the picker. */
const FILTER_PROMPT_THRESHOLD = 30

const ASIN_REGEX = /^[A-Z0-9]+$/

/** Books that produced output but are missing part of the book. */
const incompleteBooks = new Set<string>()

/** Shown by `setup` as the suggested transcription model. */
const DEFAULT_MODEL = 'gpt-4.1-mini'

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
  let port: number | undefined
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
      case '--port':
        port = Number.parseInt(next(), 10)
        assert(
          Number.isInteger(port) && port > 0 && port < 65_536,
          `--port requires a number between 1 and 65535`
        )
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
    port,
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

/**
 * Render pipeline events the way this CLI always has: prefixed lines, errors
 * on stderr, transcription progress throttled to one line per 10%.
 */
function renderEvents(asin: string): (event: PipelineEvent) => void {
  let lastReport = 0

  return (event) => {
    switch (event.kind) {
      case 'info':
        console.log(`[${asin}] ${event.message}`)
        break
      case 'warn':
        console.error(`[${asin}] ${event.message}`)
        break
      case 'transcribe-progress': {
        const { done, total } = event
        const step = Math.max(1, Math.floor(total / 10))
        if (done === total || done - lastReport >= step) {
          lastReport = done
          console.log(`[${asin}] transcribe: ${done}/${total} pages`)
        }

        break
      }

      // The extractor narrates capture in the terminal already, and stage
      // transitions are implied by the lines around them.
      case 'capture-progress':
      case 'stage':
        break
    }
  }
}

async function setup(): Promise<void> {
  const stored = await loadConfig()
  const localOcr = await isVisionOcrAvailable()

  console.log('Settings are stored in your home directory, so kindle-export')
  console.log('works from any folder. Press enter to keep a current value.\n')

  if (localOcr) {
    console.log('This Mac can read page images by itself, free and offline,')
    console.log('so there is nothing you have to set up here.\n')
  }

  const openaiApiKey =
    (await password({
      message: localOcr
        ? 'OpenAI API key (optional — enter to skip):'
        : stored.openaiApiKey
          ? 'OpenAI API key (enter to keep existing):'
          : 'OpenAI API key:',
      mask: '*'
    })) || stored.openaiApiKey

  // Blank means local OCR where it exists, so don't prefill a model name that
  // would silently switch reading to a paid API.
  const model = await input({
    message: localOcr
      ? 'Model used to read page images (blank = this Mac):'
      : 'Model used to read page images:',
    default: stored.model ?? (localOcr ? '' : DEFAULT_MODEL)
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

  if (model.trim() && !openaiApiKey) {
    console.log(
      `No API key stored, but '${model.trim()}' needs one — leave the model ` +
        'blank to read pages on this Mac instead.'
    )
  } else if (!openaiApiKey && !localOcr) {
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
    // Under the same per-book lock as a run, because what this deletes is a
    // run's input: a transcription in progress still needs its page images,
    // and a capture in progress is still reading its render data.
    try {
      freed += await withBookLock(
        path.join(options.outDir, asin),
        () => cleanBook(asin, options),
        { command: 'clean' }
      )
    } catch (err) {
      if (!isBookBusyError(err)) throw err

      console.log(`[${asin}] skipped: ${err.message}`)
    }
  }

  console.log(`\nFreed ${formatBytes(freed)} in total.`)
}

/** Free what one book no longer needs; returns the bytes freed. */
async function cleanBook(asin: string, options: Options): Promise<number> {
  const render = await cleanRenderData(options.outDir, asin)

  // Page images only go when every captured page has text, otherwise a retry
  // silently becomes a re-capture. This is the same question the transcribe
  // stage asks before deleting them, asked the same way.
  let pages = { freed: 0, removed: [] as string[] }
  if (!options.keepPages) {
    const metadata = await readMetadata(options.outDir, asin)
    const completeness = bookCompleteness({
      metadata,
      content: await readContentStore(path.join(options.outDir, asin)),
      asin
    })

    if (completeness.capturedPages && !completeness.missingPages.length) {
      pages = await cleanPageImages(options.outDir, asin)
    } else if (completeness.transcribedPages) {
      console.log(`[${asin}] keeping page images: transcription is incomplete`)
    }
  }

  if (render.freed || pages.freed) {
    console.log(`[${asin}] freed ${formatBytes(render.freed + pages.freed)}`)
  }

  return render.freed + pages.freed
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
  console.log(
    'Sign in to Amazon in the window that opens — it closes by itself once'
  )
  console.log("you're signed in.\n")

  const confirmed = await interactiveLogin(options.profileDir)

  if (confirmed) {
    console.log('Session saved. You can now run: kindle-export')
  } else {
    console.log(
      'Could not confirm the sign-in (the window was closed, or it timed out).'
    )
    console.log("If you did sign in, you're fine — try: kindle-export list")
  }
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

  if (options.command === 'serve') {
    await startServer(options)
    return
  }

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
      const result = await processBook(asin, options, renderEvents(asin))

      // A book can be short of what was asked for without anything throwing:
      // a capture that stopped early, or pages with no text. Every command
      // decides that the same way, so `ocr` and `export` on their own report
      // it too instead of exiting 0 in silence.
      if (bookFellShort(result, options.command)) {
        incompleteBooks.add(asin)
      }

      if (options.command === 'all' || options.command === 'export') {
        console.log(
          `[${asin}] done in ${formatDuration(result.durationMs)}: ${result.outputs
            .map((file) => path.resolve(file))
            .join(', ')}`
        )
      }
    } catch (err) {
      failures.push(asin)
      console.error(`[${asin}] failed: ${(err as Error)?.message ?? err}`)
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${options.asins.length} failed`)
  }

  if (incompleteBooks.size) {
    console.error(
      `${incompleteBooks.size} book(s) are missing part of the book: ${[...incompleteBooks].join(', ')}`
    )
  }

  // Incomplete output is not success, even though a file was written.
  if (failures.length || incompleteBooks.size) {
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
  try {
    await main()
  } catch (err) {
    // A profile that's already in use is an everyday situation — the web app is
    // mid-capture in another window — not a crash. Say what to do about it
    // instead of printing a stack trace; everything else keeps its stack.
    if (!isProfileBusyError(err)) throw err

    console.error(`kindle-export: ${err.message}`)
    process.exitCode = 1
  }
}
