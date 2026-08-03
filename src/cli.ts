#!/usr/bin/env node
import 'dotenv/config'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { exportBookMarkdown } from './export-book-markdown'
import { launchBrowserContext, runExtraction } from './extract-kindle-book'
import { transcribeBook } from './transcribe-book-content'
import { assert, getEnv, tryReadJsonFile } from './utils'

const VERSION = '0.3.0'

const HELP = `kindle-export — export Kindle books you own as markdown

Usage
  kindle-export <ASIN...>              capture, transcribe and export (resumes)
  kindle-export login                  sign in to Amazon once, storing the session
  kindle-export capture <ASIN...>      capture page images only
  kindle-export ocr <ASIN...>          transcribe captured pages only
  kindle-export export <ASIN...>       render markdown from transcribed text only

Options
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

Credentials come from AMAZON_EMAIL, AMAZON_PASSWORD and OPENAI_API_KEY, read
from the environment or a .env file. Run 'kindle-export login' first — the
session is stored on this machine and never leaves it.

Examples
  kindle-export login
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
  forceCapture: boolean
  forceOcr: boolean
  forceExport: boolean
}

const COMMANDS = new Set(['login', 'capture', 'ocr', 'export'])

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

async function capture(asin: string, options: Options): Promise<BookMetadata> {
  const existing = await readMetadata(options.outDir, asin)
  if (!options.forceCapture && existing?.pages?.length) {
    console.log(
      `[${asin}] capture: reusing ${existing.pages.length} existing page images`
    )
    return existing
  }

  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(amazonEmail, 'AMAZON_EMAIL is required (set it in your environment)')
  assert(
    amazonPassword,
    'AMAZON_PASSWORD is required (set it in your environment)'
  )

  console.log(`[${asin}] capture: opening Kindle reader`)
  await runExtraction({
    asin,
    amazonEmail,
    amazonPassword,
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
  const content = await transcribeBook({
    asin,
    outDir: options.outDir,
    model: options.model,
    concurrency: options.concurrency,
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
  if (content.length < metadata.pages.length) {
    console.warn(
      `[${asin}] warning: ${content.length} chunks for ${metadata.pages.length} page images`
    )
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

  const markdown = await exportBookMarkdown({ asin, outDir: options.outDir })
  console.log(
    `[${asin}] done in ${formatDuration(Date.now() - startedAt)}: ${path.resolve(markdown)}`
  )

  return markdown
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

  if (!options.asins.length) {
    console.log(HELP)
    process.exitCode = 1
    return
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
    process.exitCode = 1
  }
}

await main()
