import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import { type BookStatus, scanBooks } from './book-status'
import { loadConfig, saveConfig } from './config'
import {
  hideBrowserWindow,
  isProfileBusyError,
  launchBrowserContext
} from './extract-kindle-book'
import {
  fetchLibrary,
  type LibraryBook,
  NotSignedInError
} from './kindle-library'
import {
  bookFellShort,
  type Options,
  type PipelineEvent,
  processBook
} from './pipeline'
import { renderPage } from './serve-page'
import { interactiveLogin } from './session'
import { getEnv } from './utils'
import { isVisionOcrAvailable } from './vision-ocr'

/**
 * The local web app: the same pipeline as the CLI, driven from a browser.
 *
 * One process, two browser surfaces. The UI runs in the user's own browser at
 * a localhost URL; Amazon sign-in and page capture happen in a separate
 * automated Chrome window that opens only when needed. The server only ever
 * binds 127.0.0.1 — nothing here is reachable from the network — and browser
 * requests are checked against DNS-rebinding (Host header) and cross-site
 * (custom header) tricks, because a signed-in Amazon session and an OpenAI
 * key sit behind it.
 */

export const DEFAULT_PORT = 8484

/** Matches the transcriber's default; shown as a placeholder in settings. */
const DEFAULT_MODEL = 'gpt-4.1-mini'

const ASIN_REGEX = /^[A-Z0-9]+$/

/** One export request is capped here; nobody exports 500 books attended. */
const MAX_BOOKS_PER_JOB = 50

const MAX_BODY_BYTES = 64 * 1024
const MAX_LOG_ENTRIES = 250
const BROADCAST_DEBOUNCE_MS = 150
const SSE_HEARTBEAT_MS = 30_000

type AmazonState = 'unknown' | 'signing-in' | 'signed-in' | 'signed-out'
type Busy = null | 'login' | 'library' | 'export'

export type BookJobStatus =
  | 'queued'
  | 'working'
  | 'capturing'
  | 'transcribing'
  | 'exporting'
  | 'done'
  | 'warning'
  | 'failed'

export interface BookJobState {
  asin: string
  title: string
  status: BookJobStatus
  captured?: number
  capturedTotal?: number
  transcribed?: number
  transcribedTotal?: number
  warnings: string[]
  outputs: string[]
  error?: string
}

export interface JobState {
  state: 'running' | 'done' | 'stopped'
  stopRequested: boolean
  /** This run is re-capturing from scratch rather than resuming. */
  forceCapture: boolean
  startedAt: number
  finishedAt?: number
  books: BookJobState[]
  log: Array<{ time: number; level: 'info' | 'warn'; message: string }>
}

interface AppState {
  platform: NodeJS.Platform
  outDir: string
  hasApiKey: boolean
  /**
   * Pages can be read on this machine for free, so no API key is needed. The
   * whole Settings step collapses to an optional detail when this is true.
   */
  localOcr: boolean
  model?: string
  defaultModel: string
  amazon: AmazonState
  busy: Busy
  library?: { books: LibraryBook[]; fetchedAt: number }
  libraryError?: string
  /** Why the last sign-in attempt could not open a browser at all. */
  amazonError?: string
  diskBooks: BookStatus[]
  job?: JobState
}

export interface ServeHandle {
  server: http.Server
  url: string
  close: () => Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ExportRequest {
  asins: string[]
  formats: Array<'md' | 'pdf'>
  /**
   * Throw the existing page images away and read the book again.
   *
   * The web app's only remedy for a capture that stopped part-way: reusing
   * those pages produces the same truncated book however many times it is
   * asked. Off for an ordinary export, which resumes page by page.
   */
  forceCapture: boolean
}

/**
 * Validate an export request from the page.
 *
 * Separate from starting the job so it can be tested without a browser, and so
 * every rejection happens before anything is launched.
 */
export function parseExportRequest(body: any): ExportRequest {
  const asins: unknown = body?.asins
  if (!Array.isArray(asins) || !asins.length) {
    throw new HttpError(400, 'select at least one book')
  }
  if (asins.length > MAX_BOOKS_PER_JOB) {
    throw new HttpError(400, `at most ${MAX_BOOKS_PER_JOB} books per export`)
  }
  for (const asin of asins) {
    if (typeof asin !== 'string' || !ASIN_REGEX.test(asin)) {
      throw new HttpError(400, `invalid ASIN: ${String(asin)}`)
    }
  }

  const formats: Array<'md' | 'pdf'> = Array.isArray(body.formats)
    ? body.formats.filter((f: unknown) => f === 'md' || f === 'pdf')
    : ['md']
  if (!formats.length) formats.push('md')

  // Re-capturing a book costs an hour of browser time, so it happens only when
  // the page asked for it in so many words — anything else is an ordinary
  // resuming export.
  const forceCapture = body.forceCapture === true
  if (forceCapture && asins.length > 1) {
    throw new HttpError(400, 'capture one book again at a time')
  }

  return { asins: asins as string[], formats, forceCapture }
}

export async function createServeHandle(
  options: Options,
  { openBrowser = false }: { openBrowser?: boolean } = {}
): Promise<ServeHandle> {
  const app = new App(options)
  await app.init()

  const server = http.createServer((req, res) => {
    void app.handle(req, res)
  })

  const port = options.port ?? DEFAULT_PORT
  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const boundPort =
        address && typeof address === 'object' ? address.port : port
      resolve(`http://localhost:${boundPort}`)
    })
  })

  // The .app launcher opens the page itself once the port answers, so it asks
  // the server to stay out of the way rather than opening a second tab.
  if (openBrowser && getEnv('KINDLE_EXPORT_NO_OPEN') !== '1') {
    openInBrowser(url)
  }

  return {
    server,
    url,
    close: async () => {
      app.closeSseClients()
      // Keep-alive sockets from the browser would otherwise hold the server
      // open long after the last request.
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }
}

/** `kindle-export serve`: start the app, open it, and stay up. */
export async function startServer(options: Options): Promise<void> {
  let handle: ServeHandle
  try {
    handle = await createServeHandle(options, { openBrowser: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      const port = options.port ?? DEFAULT_PORT
      console.error(
        `Port ${port} is already in use — is kindle-export serve already running?`
      )
      console.error(
        `If so, open http://localhost:${port} — otherwise pass --port to pick another.`
      )
      process.exitCode = 1
      return
    }

    throw err
  }

  console.log(`kindle-export is running at ${handle.url}`)
  console.log(
    'Opening it in your browser. Keep this window open while it runs;'
  )
  console.log('press Ctrl+C to stop.')

  // Stay alive until the process is killed.
  await new Promise<void>(() => {})
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  try {
    spawn(cmd as string, args as string[], {
      stdio: 'ignore',
      detached: true
    }).unref()
  } catch {
    // The printed URL is the fallback.
  }
}

class App {
  private readonly options: Options
  private amazon: AmazonState = 'unknown'
  private busy: Busy = null
  private library?: { books: LibraryBook[]; fetchedAt: number }
  private libraryError?: string
  private amazonError?: string
  private diskBooks: BookStatus[] = []
  private job?: JobState
  private model?: string
  private localOcr = false

  private readonly sseClients = new Set<http.ServerResponse>()
  private broadcastTimer?: NodeJS.Timeout

  constructor(options: Options) {
    this.options = options
    this.model = options.model
  }

  async init(): Promise<void> {
    this.localOcr = await isVisionOcrAvailable()
    await this.refreshDiskBooks()
  }

  /**
   * Naming a model means OpenAI reads the pages, which needs a key. Otherwise
   * local OCR covers it, and the key is beside the point.
   */
  private needsApiKey(): boolean {
    return !this.localOcr || !!this.model
  }

  // ---------------------------------------------------------------- state

  private uiState(): AppState {
    return {
      platform: process.platform,
      outDir: path.resolve(this.options.outDir),
      hasApiKey: !!getEnv('OPENAI_API_KEY'),
      localOcr: this.localOcr,
      model: this.model,
      defaultModel: DEFAULT_MODEL,
      amazon: this.amazon,
      busy: this.busy,
      library: this.library,
      libraryError: this.libraryError,
      amazonError: this.amazonError,
      diskBooks: this.diskBooks,
      job: this.job
    }
  }

  private async refreshDiskBooks(): Promise<void> {
    this.diskBooks = await scanBooks(this.options.outDir)
  }

  private broadcast(): void {
    if (this.broadcastTimer) return

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined
      const frame = `data: ${JSON.stringify(this.uiState())}\n\n`
      for (const client of this.sseClients) {
        client.write(frame)
      }
    }, BROADCAST_DEBOUNCE_MS)
    this.broadcastTimer.unref?.()
  }

  closeSseClients(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer)
    for (const client of this.sseClients) {
      client.end()
    }
    this.sseClients.clear()
  }

  private jobLog(level: 'info' | 'warn', asin: string, message: string): void {
    if (!this.job) return

    this.job.log.push({
      time: Date.now(),
      level,
      message: `[${asin}] ${message}`
    })
    if (this.job.log.length > MAX_LOG_ENTRIES) {
      this.job.log.splice(0, this.job.log.length - MAX_LOG_ENTRIES)
    }
  }

  // ------------------------------------------------------------- security

  /**
   * Reject requests that didn't come from this machine's own browser hitting
   * the localhost origin. The Host check stops DNS rebinding (a public
   * hostname resolving to 127.0.0.1); the custom-header check on writes stops
   * cross-site requests, since no other origin can attach it without passing
   * a CORS preflight we never grant.
   */
  private checkRequest(req: http.IncomingMessage): void {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
      throw new HttpError(403, 'forbidden host')
    }

    if (req.method === 'POST' && req.headers['x-kindle-export'] !== '1') {
      throw new HttpError(403, 'missing app header')
    }
  }

  private async readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large')
      chunks.push(chunk as Buffer)
    }

    if (!size) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new HttpError(400, 'invalid JSON body')
    }
  }

  // -------------------------------------------------------------- routing

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      this.checkRequest(req)

      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = `${req.method} ${url.pathname}`

      if (route === 'GET /') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        })
        res.end(renderPage())
        return
      }

      if (route === 'GET /api/state') {
        if (url.searchParams.has('scan')) await this.refreshDiskBooks()
        this.json(res, 200, this.uiState())
        return
      }

      if (route === 'GET /api/events') {
        this.handleSse(req, res)
        return
      }

      if (route === 'POST /api/config') {
        await this.handleConfig(await this.readBody(req))
        this.json(res, 200, this.uiState())
        return
      }

      if (route === 'POST /api/login') {
        this.startLogin()
        this.json(res, 202, this.uiState())
        return
      }

      if (route === 'POST /api/library') {
        this.startLibraryRefresh()
        this.json(res, 202, this.uiState())
        return
      }

      if (route === 'POST /api/export') {
        this.startJob(await this.readBody(req))
        this.json(res, 202, this.uiState())
        return
      }

      if (route === 'POST /api/job/stop') {
        if (this.job?.state === 'running') {
          this.job.stopRequested = true
          this.broadcast()
        }
        this.json(res, 200, this.uiState())
        return
      }

      if (route === 'POST /api/reveal') {
        await this.handleReveal(await this.readBody(req))
        this.json(res, 200, {})
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
        await this.handleDownload(url.pathname, res)
        return
      }

      throw new HttpError(404, 'not found')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const message =
        err instanceof HttpError
          ? err.message
          : ((err as Error)?.message ?? 'internal error')
      if (!res.headersSent) {
        this.json(res, status, { error: message })
      } else {
        res.end()
      }
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(body))
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    })
    res.write(`retry: 1000\n\n`)
    res.write(`data: ${JSON.stringify(this.uiState())}\n\n`)

    this.sseClients.add(res)
    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`)
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()

    req.on('close', () => {
      clearInterval(heartbeat)
      this.sseClients.delete(res)
    })
  }

  // ------------------------------------------------------------- handlers

  private async handleConfig(body: any): Promise<void> {
    const apiKey =
      typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined
    const model = typeof body.model === 'string' ? body.model.trim() : undefined

    const stored = await loadConfig()
    await saveConfig({
      ...stored,
      openaiApiKey: apiKey || stored.openaiApiKey,
      model: model === undefined ? stored.model : model || undefined
    })

    // The transcriber reads the key from the environment at run time, so a
    // key saved here must work without restarting the server.
    if (apiKey) {
      // eslint-disable-next-line no-process-env
      process.env.OPENAI_API_KEY = apiKey
    }
    if (model !== undefined) this.model = model || undefined

    this.broadcast()
  }

  private requireIdle(): void {
    if (this.busy === 'export') {
      throw new HttpError(409, 'an export is running — wait for it to finish')
    }
    if (this.busy) {
      throw new HttpError(409, 'the browser window is busy — close it or wait')
    }
  }

  private startLogin(): void {
    this.requireIdle()
    this.busy = 'login'
    this.amazon = 'signing-in'
    this.amazonError = undefined
    this.broadcast()

    void (async () => {
      try {
        const confirmed = await interactiveLogin(this.options.profileDir)
        this.amazon = confirmed ? 'signed-in' : 'unknown'
      } catch (err) {
        this.amazon = 'unknown'
        // The one failure that isn't the user closing the window: a terminal
        // command is holding the browser profile. Nothing was tried against
        // Amazon, so say what to do rather than showing "not checked yet".
        if (isProfileBusyError(err)) this.amazonError = describeBusyProfile()
      } finally {
        this.busy = null
        this.broadcast()
      }

      // Loading the library right after sign-in both fills the picker and
      // settles an 'unknown' outcome — it's the real test of the session.
      try {
        this.startLibraryRefresh()
      } catch {
        // Something else grabbed the browser in the meantime; the user can
        // load the library by hand.
      }
    })()
  }

  private startLibraryRefresh(): void {
    this.requireIdle()
    this.busy = 'library'
    this.libraryError = undefined
    this.broadcast()

    void (async () => {
      const context = await launchBrowserContext({
        profileDir: this.options.profileDir
      }).catch((err: Error) => {
        this.libraryError = isProfileBusyError(err)
          ? describeBusyProfile()
          : err.message
        return undefined
      })

      try {
        if (!context) return

        // The library fetch needs no interaction, so keep its window out of
        // the way too. fetchLibrary reuses this same page.
        const page = context.pages()[0] ?? (await context.newPage())
        await hideBrowserWindow(page)

        const books = await fetchLibrary(context)
        this.library = { books, fetchedAt: Date.now() }
        this.amazon = 'signed-in'
      } catch (err) {
        if (err instanceof NotSignedInError) {
          this.amazon = 'signed-out'
        } else {
          this.libraryError = (err as Error)?.message ?? String(err)
        }
      } finally {
        await context?.close().catch(() => {})
        await context
          ?.browser()
          ?.close()
          .catch(() => {})
        this.busy = null
        this.broadcast()
      }
    })()
  }

  private startJob(body: any): void {
    this.requireIdle()

    if (this.needsApiKey() && !getEnv('OPENAI_API_KEY')) {
      throw new HttpError(400, 'store an OpenAI API key in Settings first')
    }

    const request = parseExportRequest(body)

    this.busy = 'export'
    this.job = {
      state: 'running',
      stopRequested: false,
      startedAt: Date.now(),
      forceCapture: request.forceCapture,
      books: request.asins.map((asin) => ({
        asin,
        title: this.titleFor(asin),
        status: 'queued',
        warnings: [],
        outputs: []
      })),
      log: []
    }
    this.broadcast()

    void this.runJob(request)
  }

  private titleFor(asin: string): string {
    return (
      this.library?.books.find((book) => book.asin === asin)?.title ??
      this.diskBooks.find((book) => book.asin === asin)?.title ??
      asin
    )
  }

  private async runJob({
    formats,
    forceCapture
  }: ExportRequest): Promise<void> {
    const job = this.job!

    // Settings may have changed since the server started; the stored config
    // is what the settings screen writes, so read it fresh per job.
    const stored = await loadConfig()
    const jobOptions: Options = {
      ...this.options,
      command: 'all',
      asins: job.books.map((book) => book.asin),
      formats,
      model: this.model ?? stored.model,
      concurrency: this.options.concurrency ?? stored.concurrency,
      // A re-capture throws the pages away and reads the book from the start,
      // which is the only way out of a capture that stopped early. It also
      // drops the old transcription, so nothing from the truncated book
      // survives into the new export.
      forceCapture,
      forceOcr: false,
      forceExport: false,
      // Keep the capture window minimized: from the web app's point of view a
      // self-driving browser on top of the page is an invitation to close it.
      hideBrowser: true
    }

    for (const book of job.books) {
      if (job.stopRequested) break

      book.status = 'working'
      this.broadcast()

      try {
        const result = await processBook(book.asin, jobOptions, (event) => {
          this.onBookEvent(book, event)
        })

        book.outputs = result.outputs.map((file) => path.basename(file))
        // The same verdict the CLI's exit status uses, so a book badged
        // "done" here is a book the terminal would have called finished.
        book.status = bookFellShort(result, jobOptions.command)
          ? 'warning'
          : 'done'
      } catch (err) {
        book.status = 'failed'
        book.error = (err as Error)?.message ?? String(err)
        this.jobLog('warn', book.asin, `failed: ${book.error}`)
      }

      await this.refreshDiskBooks()
      this.broadcast()
    }

    job.state = job.stopRequested ? 'stopped' : 'done'
    job.finishedAt = Date.now()
    this.busy = null
    this.broadcast()
  }

  private onBookEvent(book: BookJobState, event: PipelineEvent): void {
    switch (event.kind) {
      case 'stage':
        book.status =
          event.stage === 'capture'
            ? 'capturing'
            : event.stage === 'transcribe'
              ? 'transcribing'
              : 'exporting'
        break
      case 'capture-progress':
        book.captured = event.captured
        book.capturedTotal = event.total
        break
      case 'transcribe-progress':
        book.transcribed = event.done
        book.transcribedTotal = event.total
        break
      case 'info':
        this.jobLog('info', book.asin, event.message)
        break
      case 'warn':
        book.warnings.push(event.message)
        this.jobLog('warn', book.asin, event.message)
        break
    }

    this.broadcast()
  }

  private async handleReveal(body: any): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new HttpError(400, 'only available on macOS')
    }

    const asin = typeof body.asin === 'string' ? body.asin : ''
    if (asin && !ASIN_REGEX.test(asin)) {
      throw new HttpError(400, 'invalid ASIN')
    }

    const dir = asin
      ? path.join(this.options.outDir, asin)
      : this.options.outDir
    await fs.access(dir).catch(() => {
      throw new HttpError(404, 'no such folder')
    })

    spawn('open', [dir], { stdio: 'ignore', detached: true }).unref()
  }

  private async handleDownload(
    pathname: string,
    res: http.ServerResponse
  ): Promise<void> {
    const parts = pathname.split('/').slice(3) // ['', 'api', 'download', ...]
    if (parts.length !== 2) throw new HttpError(400, 'bad download path')

    const asin = decodeURIComponent(parts[0]!)
    const name = decodeURIComponent(parts[1]!)

    if (!ASIN_REGEX.test(asin)) throw new HttpError(400, 'invalid ASIN')
    // The filename comes back from the browser, so treat it as hostile: no
    // separators, no traversal, only the two formats we ever write.
    if (
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('..') ||
      !/\.(md|pdf)$/.test(name)
    ) {
      throw new HttpError(400, 'invalid file name')
    }

    const bookDir = path.resolve(this.options.outDir, asin)
    const filePath = path.resolve(bookDir, name)
    if (path.dirname(filePath) !== bookDir) {
      throw new HttpError(400, 'invalid file name')
    }

    const stat = await fs.stat(filePath).catch(() => {
      throw new HttpError(404, 'file not found')
    })

    const headers: http.OutgoingHttpHeaders = {
      'content-type': name.endsWith('.pdf')
        ? 'application/pdf'
        : 'text/markdown; charset=utf-8',
      'content-length': stat.size,
      'content-disposition': contentDisposition(name),
      'cache-control': 'no-store'
    }

    // Node validates header values here, not when the object is built. A
    // refusal must surface as an ordinary error response: the file's
    // content-length has not been promised yet, so the body isn't truncated.
    try {
      res.writeHead(200, headers)
    } catch (err) {
      throw new HttpError(
        500,
        `invalid download headers: ${(err as Error).message}`
      )
    }
    createReadStream(filePath).pipe(res)
  }
}

/**
 * The browser profile is held by a kindle-export run outside this app — the
 * server's own jobs are excluded by `requireIdle`, so this is a terminal
 * command. A pid means nothing to the person reading the page; what they can
 * act on is the other window.
 */
function describeBusyProfile(): string {
  return (
    'Another kindle-export is using the browser right now. ' +
    'Wait for it to finish, or close its Chrome window, then try again.'
  )
}

/**
 * A `Content-Disposition` a browser and Node both accept.
 *
 * Node rejects header values holding anything outside Latin-1, and an export
 * can be renamed to anything at all — so the plain `filename` parameter carries
 * an ASCII-only stand-in and the real name travels percent-encoded in
 * `filename*`, which every current browser prefers anyway.
 */
function contentDisposition(name: string): string {
  return `attachment; filename="${asciiFallbackName(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

/** `name` reduced to printable ASCII, never empty, keeping its extension. */
function asciiFallbackName(name: string): string {
  const ext = name.toLowerCase().endsWith('.pdf') ? '.pdf' : '.md'
  const stem = name
    .slice(0, Math.max(0, name.length - ext.length))
    // Control characters, quotes and separators would all break the quoted
    // string; a name of nothing but those leaves the generic fallback.
    .replaceAll(/[^\u0020-\u007E]/g, '')
    .replaceAll(/["\\;]/g, '')
    .trim()

  return `${stem || 'book'}${ext}`
}

/** Percent-encoding for the `filename*` ext-value of RFC 5987. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replaceAll(
    /['()*!]/g,
    (c) => `%${c.codePointAt(0)!.toString(16).toUpperCase()}`
  )
}
