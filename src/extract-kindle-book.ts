import 'dotenv/config'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { SetRequired } from 'type-fest'
import { input } from '@inquirer/prompts'
import delay from 'delay'
import pRace from 'p-race'
// import { chromium } from 'playwright'
import { chromium } from 'patchright'
import sharp from 'sharp'

import type {
  AmazonRenderLocationMap,
  AmazonRenderToc,
  AmazonRenderTocItem,
  BookMetadata,
  CaptureStatus,
  PageNav,
  TocItem
} from './types'
import {
  inspectProfileLock,
  isProfileBusyError,
  ProfileBusyError
} from './browser-profile-lock'
import {
  chevronClickTimeoutMs,
  isOnLastNumberedPage,
  maxNavigationAttempts,
  navigationTimeoutMs,
  shouldStopBeforeCapture,
  shouldStopCapture
} from './capture-termination'
import { parsePageNav, parseTocItems } from './playwright-utils'
import {
  assert,
  extractTar,
  getEnv,
  hashObject,
  normalizeAuthors,
  normalizeBookMetadata,
  PAGE_IMAGES_DIR,
  parseJsonpResponse,
  tryReadJsonFile
} from './utils'

// Block amazon analytics requests
// (not strictly necessary, but adblockers do this by default anyway and it
// makes the script run a bit faster)
const urlRegexBlacklist = [
  /unagi-\w+\.amazon\.com/i, // 'unagi-na.amazon.com'
  /m\.media-amazon\.com.*\/showads/i,
  /fls-na\.amazon\.com.*\/remote-weblab-triggers/i
]

type RENDER_METHOD = 'screenshot' | 'blob'
const renderMethod: RENDER_METHOD = 'blob'

const deviceScaleFactor = 2
const VERBOSE_LOGGING = getEnv('KINDLE_EXPORT_VERBOSE') === '1'
const QUIET_LOGGING = getEnv('KINDLE_EXPORT_QUIET') === '1'

function logInfo(...args: any[]) {
  if (!QUIET_LOGGING) {
    console.log(...args)
  }
}

function warnInfo(...args: any[]) {
  if (!QUIET_LOGGING) {
    console.warn(...args)
  }
}

function logVerbose(...args: any[]) {
  if (VERBOSE_LOGGING) {
    console.log(...args)
  }
}

function warnVerbose(...args: any[]) {
  if (VERBOSE_LOGGING) {
    console.warn(...args)
  }
}

// Re-exported so callers that only know about `launchBrowserContext` can
// recognise its one expected failure without a second import.
export { isProfileBusyError, ProfileBusyError } from './browser-profile-lock'

export type BrowserContext = Awaited<
  ReturnType<typeof chromium.launchPersistentContext>
>

export type Page = Awaited<ReturnType<BrowserContext['newPage']>>

export interface LaunchBrowserOptions {
  profileDir?: string
  /**
   * Chrome release channel. Defaults to installed Google Chrome, falling back
   * to Playwright's bundled Chromium when Chrome isn't present — which is the
   * common case on Linux and in containers.
   */
  channel?: string
}

/** Playwright's message when the requested channel isn't installed. */
const MISSING_CHANNEL_REGEX =
  /channel .*(not (installed|found))|Executable doesn't exist|Chromium distribution/i

async function cleanupStaleSingletonLocks(profileDir: string) {
  for (const filename of [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket'
  ]) {
    await fs.unlink(path.join(profileDir, filename)).catch(() => {})
  }
}

/**
 * Make sure nothing else is using the shared browser profile.
 *
 * A stale lock is cleared; a live owner is reported. This used to kill the pid
 * named in the lock, which meant a second command — `list`, `login`, another
 * `serve` — silently killed the browser the web app was capturing with, and a
 * recycled pid meant killing a process that had nothing to do with us.
 */
async function ensureBrowserProfileAvailable(profileDir: string) {
  const lockPath = path.join(profileDir, 'SingletonLock')
  const linkTarget = await fs.readlink(lockPath).catch(() => undefined)

  const lock = await inspectProfileLock({ profileDir, linkTarget })

  if (lock.state === 'unlocked') return

  if (lock.state === 'busy') {
    throw new ProfileBusyError(lock.pid, profileDir)
  }

  warnVerbose(`clearing a stale browser profile lock (${lock.reason})`)
  await cleanupStaleSingletonLocks(profileDir)
}

/**
 * Launch a persistent browser context with the shared profile directory.
 * The caller is responsible for closing the context when done.
 */
export async function launchBrowserContext(
  opts?: LaunchBrowserOptions
): Promise<BrowserContext> {
  const profileDir =
    opts?.profileDir?.trim() ||
    getEnv('BROWSER_PROFILE_DIR')?.trim() ||
    path.join('out', '.browser-profile')
  await fs.mkdir(profileDir, { recursive: true })

  let context: BrowserContext | undefined
  let channel: string | undefined =
    opts?.channel?.trim() || getEnv('BROWSER_CHANNEL')?.trim() || 'chrome'

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureBrowserProfileAvailable(profileDir)
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        ...(channel ? { channel } : {}),
        args: [
          // hide chrome's crash restore popup
          '--hide-crash-restore-bubble',
          // disable chrome's password autosave popups
          '--disable-features=PasswordAutosave',
          // disable chrome's passkey popups
          '--disable-features=WebAuthn',
          // disable chrome creating 1GB temp directories on each run
          '--disable-features=MacAppCodeSignClone',
          // keep a minimized/covered window rendering and firing timers —
          // without these, hiding the capture window stalls page turning
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ],
        ignoreDefaultArgs: [
          // disable chrome's default automation detection flag
          '--enable-automation',
          // adding this cause chrome shows a weird admin popup without it
          '--no-sandbox',
          // adding this cause chrome shows a weird admin popup without it
          '--disable-blink-features=AutomationControlled'
        ],
        // bypass amazon's default content security policy which allows us to inject
        // our own scripts into the page
        bypassCSP: true,
        deviceScaleFactor,
        viewport: { width: 1280, height: 720 }
      })

      // Install the blob capture init script on the context so it runs on every
      // new page automatically.
      if (renderMethod === 'blob') {
        await context.addInitScript(() => {
          const origCreateObjectURL = URL.createObjectURL.bind(URL)
          URL.createObjectURL = function (blob: Blob) {
            // TODO: filter for image/png blobs? since those are the only ones we're using
            // (haven't found this to be an issue in practice)
            const type = blob.type || 'application/octet-stream'
            const url = origCreateObjectURL(blob)
            // nodeLog('createObjectURL', url, type, blob.size)

            // Snapshot blob bytes immediately because kindle's renderer revokes
            // them immediately after they're used.
            ;(async () => {
              const buf = await blob.arrayBuffer()
              // store raw base64 (not data URL) to keep payload small
              let binary = ''
              const bytes = new Uint8Array(buf)
              for (const byte of bytes) {
                // eslint-disable-next-line unicorn/prefer-code-point
                binary += String.fromCharCode(byte)
              }

              const base64 = btoa(binary)

              // @ts-expect-error captureBlob
              captureBlob(url, { type, base64 })
            })()

            return url
          }
        })
      }

      return context
    } catch (err) {
      await context?.close().catch(() => {})

      // Someone else is legitimately using the profile. Retrying can't help,
      // and the retry warning would bury the one message worth reading.
      if (isProfileBusyError(err)) {
        throw err
      }

      // Google Chrome isn't installed (usual on Linux and in containers), so
      // fall back to the Chromium that ships with Playwright.
      if (
        channel &&
        MISSING_CHANNEL_REGEX.test((err as Error)?.message ?? '')
      ) {
        console.warn(
          `Google Chrome not found; falling back to bundled Chromium. Set BROWSER_CHANNEL to override.`
        )
        channel = undefined
        continue
      }

      if (attempt >= 3) {
        throw err
      }

      console.warn(
        `browser launch attempt ${attempt} failed, retrying with shared profile...`
      )
      await delay(1000)
    }
  }

  throw new Error('failed to initialize browser context')
}

async function setWindowState(
  page: Page,
  state: 'minimized' | 'normal'
): Promise<void> {
  const session = await page.context().newCDPSession(page)
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget')
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: state }
    })
  } finally {
    await session.detach().catch(() => {})
  }
}

/**
 * Park the automation window in the Dock so it doesn't sit on top of whatever
 * the user is doing — left in front, it invites exactly the clicks and
 * closings that break a capture. Playwright drives the page over CDP rather
 * than OS events, and the launch args disable background throttling, so a
 * minimized window keeps turning pages.
 */
export async function hideBrowserWindow(page: Page): Promise<void> {
  try {
    await setWindowState(page, 'minimized')
  } catch {
    // Cosmetic — a window that stays visible is not a failure.
  }
}

/** Bring a hidden automation window back when the user is needed in it. */
export async function showBrowserWindow(page: Page): Promise<void> {
  try {
    await setWindowState(page, 'normal')
    await page.bringToFront()
  } catch {
    // The window is already visible at worst.
  }
}

export interface ExtractBookOptions {
  asin: string
  /**
   * Amazon credentials, used only if the stored session has expired. Leave
   * them unset to sign in by hand in the browser window instead — no need to
   * keep an Amazon password in a plaintext file.
   */
  amazonEmail?: string
  amazonPassword?: string
  /** Root directory holding one folder per ASIN. Defaults to `out`. */
  outDir?: string
  /** 2FA code, when the caller has one and no TTY is available to prompt on. */
  otp?: string
  /**
   * Minimize the automation window while capturing. It is brought back
   * automatically if Amazon asks for a sign-in.
   */
  hideWindow?: boolean
}

/** How long to wait for a person to complete sign-in by hand. */
const MANUAL_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Extract a single Kindle book using the given browser context.
 * Creates a new page for the extraction and closes it when done.
 */
export async function extractBook(
  context: BrowserContext,
  opts: ExtractBookOptions
): Promise<void> {
  const { asin, amazonEmail, amazonPassword, otp, hideWindow } = opts
  const asinL = asin.toLowerCase()

  const outDir = path.join(opts.outDir ?? 'out', asin)
  const bookDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, PAGE_IMAGES_DIR)
  const metadataPath = path.join(outDir, 'metadata.json')
  await fs.mkdir(bookDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  const nextPageChevronSelector = '.kr-chevron-container-right'
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  const result: SetRequired<Partial<BookMetadata>, 'pages' | 'nav'> = {
    // Stamped before the first page is written, so every image this run
    // produces is tied to it. Anything transcribed from an earlier capture of
    // the same book carries a different id and can be recognised as stale.
    captureId: randomUUID(),
    pages: [],
    // locationMap: { locations: [], navigationUnit: [] },
    nav: {
      startPosition: -1,
      endPosition: -1,
      startContentPosition: -1,
      startContentPage: -1,
      endContentPosition: -1,
      endContentPage: -1,
      totalNumPages: -1,
      totalNumContentPages: -1
    }
  }

  // Create a fresh page for this book extraction
  const page = await context.newPage()
  if (hideWindow) {
    await hideBrowserWindow(page)
  }

  try {
    // Kindle's "Most Recent Page Read" dialog appears when the book content
    // finishes loading — which races with everything else — and until it's
    // answered its overlay swallows every click, so an action just retries
    // until it times out. A locator handler is the reliable way to deal with
    // that: Playwright runs it whenever the dialog is in the way, whatever
    // else we happen to be doing. We always start from the beginning of the
    // book, so the answer is always No.
    await page.addLocatorHandler(
      page
        .locator('ion-alert, [role="dialog"], .alert-wrapper')
        .filter({ hasText: /most recent page read/i })
        .first(),
      async (dialog) => {
        warnInfo('dismissing "Most Recent Page Read" dialog')
        await dialog
          .locator('button, ion-button')
          .filter({ hasText: /^\s*no\s*$/i })
          .first()
          .click({ force: true })
          .catch(() => {})
      }
    )

    await page.route('**/*', async (route) => {
      const urlString = route.request().url()
      for (const regex of urlRegexBlacklist) {
        if (regex.test(urlString)) {
          return route.abort()
        }
      }

      return route.continue()
    })

    page.on('response', async (response) => {
      try {
        const status = response.status()
        if (status !== 200) {
          return
        }

        const url = new URL(response.url())
        if (url.pathname.endsWith('YJmetadata.jsonp')) {
          const body = await response.text()
          const metadata = parseJsonpResponse<any>(body)
          if (metadata.asin !== asin) return

          delete metadata.cpr
          if (Array.isArray(metadata.authorsList)) {
            metadata.authorsList = normalizeAuthors(metadata.authorsList)
          }

          if (!result.meta) {
            warnVerbose('book meta', metadata)
            result.meta = metadata
          }
        } else if (
          url.hostname === 'read.amazon.com' &&
          url.searchParams.get('asin')?.toLowerCase() === asinL
        ) {
          if (url.pathname === '/service/mobile/reader/startReading') {
            const body: any = await response.json()
            delete body.karamelToken
            delete body.metadataUrl
            delete body.YJFormatVersion
            if (!result.info) {
              warnVerbose('book info', body)
            }
            result.info = body
          } else if (url.pathname === '/renderer/render') {
            // TODO: these TAR files have some useful metadata that we could use...
            const params = Object.fromEntries(url.searchParams.entries())
            const hash = hashObject(params)
            const renderDir = path.join(bookDataDir, 'render', hash)
            await fs.mkdir(renderDir, { recursive: true })
            const body = await response.body()
            const tempDir = await extractTar(body, { cwd: renderDir })
            const { startingPosition, skipPageCount, numPage } = params
            logVerbose('RENDER TAR', tempDir, {
              startingPosition,
              skipPageCount,
              numPage
            })

            const locationMap = await tryReadJsonFile<
              Partial<AmazonRenderLocationMap>
            >(path.join(renderDir, 'location_map.json'))
            if (locationMap) {
              const locations = Array.isArray(locationMap.locations)
                ? locationMap.locations
                : []
              const rawNavigationUnit = Array.isArray(
                locationMap.navigationUnit
              )
                ? locationMap.navigationUnit
                : []

              const navigationUnit =
                rawNavigationUnit.length > 0
                  ? rawNavigationUnit
                  : locations.map((startPosition, index) => ({
                      startPosition,
                      label: `${index + 1}`,
                      page: index + 1
                    }))

              for (const [index, navUnit] of navigationUnit.entries()) {
                const parsedPage = Number.parseInt(
                  `${navUnit.page ?? navUnit.label ?? ''}`,
                  10
                )
                navUnit.page = Number.isNaN(parsedPage) ? index + 1 : parsedPage
              }

              result.locationMap = {
                locations,
                navigationUnit
              }
            }

            const metadata = await tryReadJsonFile<any>(
              path.join(renderDir, 'metadata.json')
            )
            if (metadata) {
              result.nav.startPosition = metadata.firstPositionId
              result.nav.endPosition = metadata.lastPositionId

              // Fallback for books opened in "resume" mode: when the account
              // has existing reading progress, the web reader skips the
              // cold-open `startReading` and `YJmetadata.jsonp` requests, so
              // `result.info` / `result.meta` never arrive over the network.
              // The render metadata carries the whole-book range plus
              // title/author, so synthesize the minimal fields we depend on.
              if (!result.meta) {
                result.meta = {
                  asin,
                  title: metadata.bookTitle,
                  authorList: Array.isArray(metadata.authors)
                    ? normalizeAuthors(metadata.authors)
                    : [],
                  language: metadata.lang ?? '',
                  positions: {
                    cover: metadata.coverPosistion ?? 0,
                    srl: metadata.srl ?? 0,
                    toc: 0
                  },
                  sample: false,
                  startPosition: metadata.firstPositionId,
                  endPosition: metadata.lastPositionId
                } as any
              }
              if (!result.info) {
                result.info = {
                  requestedAsin: asin,
                  deliveredAsin: asin,
                  isOwned: true,
                  isSample: false,
                  srl: metadata.srl ?? 0
                } as any
              }
            }

            const rawToc = await tryReadJsonFile<AmazonRenderToc>(
              path.join(renderDir, 'toc.json')
            )
            if (rawToc && result.locationMap && !result.toc) {
              const toc: TocItem[] = []

              for (const rawTocItem of rawToc) {
                toc.push(...getTocItems(rawTocItem, { depth: 0 }))
              }

              result.toc = toc
            }

            // TODO: `page_data_0_5.json` has start/end/words for each page in this render batch
            // const toc = JSON.parse(
            //   await fs.readFile(path.join(tempDir, 'toc.json'), 'utf8')
            // )
            // console.warn('toc', toc)
          }
        }
      } catch {}
    })

    // Only used for the 'blob' render method
    const capturedBlobs = new Map<
      string,
      {
        type: string
        base64: string
      }
    >()

    if (renderMethod === 'blob') {
      await page.exposeFunction('nodeLog', (...args: any[]) => {
        if (!QUIET_LOGGING) {
          console.error('[page]', ...args)
        }
      })

      await page.exposeBinding('captureBlob', (_source, url, payload) => {
        capturedBlobs.set(url, payload)
      })
    }

    // Try going directly to the book reader page if we're already authenticated.
    // Otherwise wait for the signin page to load.
    await Promise.any([
      page.goto(bookReaderUrl, { timeout: 30_000 }),
      page.waitForURL('**/ap/signin', { timeout: 30_000 })
    ])

    // If we're on the signin page, start the authentication flow.
    if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
      if (!amazonEmail || !amazonPassword) {
        // No stored credentials, so let the person sign in themselves in the
        // browser window that's already open. This is the default path: it
        // keeps Amazon passwords out of config files entirely, and handles
        // whatever challenge Amazon throws up without us having to script it.
        logInfo(
          'Amazon needs you to sign in. Complete sign-in in the browser window...'
        )

        // A hidden window has to come back for this — the user can't sign in
        // to a window they can't see.
        await showBrowserWindow(page)

        await page.waitForURL(
          (url) => !/\/ap\/signin/.test(new URL(url).pathname),
          { timeout: MANUAL_SIGN_IN_TIMEOUT_MS }
        )

        logInfo('Signed in.')
        if (hideWindow) {
          await hideBrowserWindow(page)
        }
      } else {
        await page.locator('input[type="email"]').fill(amazonEmail)
        await page.locator('input[type="submit"]').click()

        await page.locator('input[type="password"]').fill(amazonPassword)
        // await page.locator('input[type="checkbox"]').click()
        await page.locator('input[type="submit"]').click()

        // Only relevant to the scripted path — when signing in by hand, 2FA is
        // dealt with in the browser rather than at the terminal.
        if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
          const envOtpCode = otp?.trim() || getEnv('AMAZON_OTP')?.trim()
          const code =
            envOtpCode ||
            (process.stdin.isTTY
              ? await input({
                  message: '2-factor auth code?'
                })
              : '')

          // Only enter 2-factor auth code if needed
          if (code) {
            await page.locator('input[type="tel"]').fill(code)
            await page
              .locator(
                'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
              )
              .click()
          }
        }
      }

      if (!page.url().includes(bookReaderUrl)) {
        await page.goto(bookReaderUrl)
      }
    }

    async function updateSettings() {
      await dismissReaderPopoverMenu()
      logInfo('Looking for Reader settings button')
      const settingsButton = page
        .locator(
          'ion-button[aria-label="Reader settings"], ' +
            'button[aria-label="Reader settings"]'
        )
        .first()
      await settingsButton.waitFor({ timeout: 30_000 })
      logInfo('Clicking Reader settings')
      await settingsButton.click()
      await delay(500)

      // Change font to Amazon Ember
      // My hypothesis is that this font will be easier for OCR to transcribe...
      // TODO: evaluate different fonts & settings
      logInfo('Changing font to Amazon Ember')
      await page.locator('#AmazonEmber').click()
      await delay(200)

      // Change layout to single column
      logInfo('Changing to single column layout')
      await page
        .locator('[role="radiogroup"][aria-label$=" columns"]', {
          hasText: 'Single Column'
        })
        .click()
      await delay(200)

      logInfo('Closing settings')
      // The sync dialog can surface while the settings panel is open, and it
      // swallows this click — leaving the panel covering the page image.
      await dismissPossibleAlert()
      await settingsButton.click()
      await delay(500)
      await dismissReaderPopoverMenu()
    }

    /**
     * Open the reader menu and click "Go to Page"/"Go to Location".
     *
     * The popover animates open and can be closed from under us by the "Most
     * Recent Page Read" dialog handler, so a single instant `isVisible` read
     * is a coin toss — it has to be awaited, and the whole open retried.
     */
    async function openGoToModal(): Promise<boolean> {
      await dismissPossibleAlert()
      await dismissReaderPopoverMenu()
      await page.locator('#reader-header').hover({ force: true })
      await delay(200)
      await page.locator('ion-button[aria-label="Reader menu"]').click()

      const goToPageItem = page.locator('ion-item[role="listitem"]', {
        hasText: 'Go to Page'
      })
      const goToLocationItem = page.locator('ion-item[role="listitem"]', {
        hasText: 'Go to Location'
      })

      await goToPageItem
        .or(goToLocationItem)
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})

      if (await goToPageItem.isVisible()) {
        await goToPageItem.click()
      } else if (await goToLocationItem.isVisible()) {
        await goToLocationItem.click()
      } else {
        await dismissReaderPopoverMenu()
        return false
      }

      return true
    }

    async function goToPage(pageNumber: number) {
      let opened = false
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        opened = await openGoToModal()
      }
      if (!opened) {
        throw new Error(
          'Unable to find "Go to Page" or "Go to Location" menu item'
        )
      }

      const modalInput = page
        .locator(
          'ion-modal.go-to-modal.show-modal input[placeholder="page number"], ion-modal.go-to-modal.show-modal input[placeholder*="location" i], ion-modal input[placeholder="page number"], ion-modal input[placeholder*="location" i]'
        )
        .first()
      await modalInput.fill(`${pageNumber}`)
      // await page.locator('ion-modal button', { hasText: 'Go' }).click()
      const goButton = page
        .locator(
          'ion-modal.go-to-modal.show-modal ion-button[item-i-d="go-to-modal-go-button"], ion-modal ion-button[item-i-d="go-to-modal-go-button"], ion-modal button, ion-modal ion-button',
          { hasText: 'Go' }
        )
        .first()
      await goButton.click({ force: true }).catch(async () => {
        await page.keyboard.press('Enter')
      })
      await delay(1000)
      await dismissReaderPopoverMenu()

      // Same retry as the walk itself: reading the footer straight after the
      // modal closes can catch it mid-render, and a blank read here used to be
      // taken as "we arrived".
      const nextPageNav = await readPageNav()
      if (nextPageNav?.page !== pageNumber) {
        console.warn(
          `Go to page ${pageNumber} failed; footer reports ${JSON.stringify(nextPageNav)}; walking with chevrons...`
        )
        await dismissGoToModal()
        await walkToPage(pageNumber)
      }
    }

    async function dismissGoToModal() {
      const goToModal = page.locator('ion-modal.go-to-modal.show-modal')
      const maybeOpen = await goToModal.isVisible().catch(() => false)
      if (!maybeOpen) return

      await goToModal
        .locator('ion-button[item-i-d="go-to-modal-cancel-button"]')
        .click({ force: true })
        .catch(async () => {
          await page.keyboard.press('Escape').catch(() => {})
        })
      await delay(300)
    }

    /**
     * Read the footer nav, tolerating the moment after a page turn or a modal
     * close where it hasn't re-rendered yet. A single blank read used to be
     * fatal.
     */
    async function readPageNav(): Promise<PageNav | undefined> {
      for (let attempt = 0; attempt < 10; attempt++) {
        const pageNav = await getPageNav().catch(() => undefined)
        if (pageNav) return pageNav

        await delay(200)
      }
    }

    async function walkToPage(pageNumber: number) {
      let previousPage: number | undefined
      let stuck = 0

      for (let attempts = 0; attempts < 500; attempts++) {
        const pageNav = await readPageNav()
        if (!pageNav) {
          const footerText = await page
            .locator('ion-footer ion-title')
            .first()
            .textContent()
            .catch(() => undefined)

          throw new Error(
            `Unable to read current page while walking to ${pageNumber} ` +
              `(footer reads: ${JSON.stringify(footerText)})`
          )
        }

        // The footer reports a location rather than a page in front and back
        // matter, and for roman-numbered pages. Derive a page from it where the
        // location map allows, so walking can still tell which way to go.
        const currentPage =
          pageNav.page ??
          (pageNav.location === undefined
            ? undefined
            : getPageForPosition(pageNav.location))

        if (currentPage === pageNumber) return
        if (pageNumber === 1 && currentPage !== undefined && currentPage <= 1) {
          return
        }

        // With no page to compare against, assume we're ahead of the content
        // and walk forward — goToPage is only ever aimed at the start of the
        // book or back at where the reader began.
        const direction =
          currentPage !== undefined && currentPage > pageNumber
            ? 'left'
            : 'right'
        const chevronSelector =
          direction === 'left'
            ? '.kr-chevron-container-left'
            : '.kr-chevron-container-right'
        const arrowKey = direction === 'left' ? 'ArrowLeft' : 'ArrowRight'

        // A walk that stops moving has hit something. If the chevron in our
        // direction is gone, that something is the edge of the book — the
        // footer never reports the final spread of some books (it reads
        // "page 144 of 145" on the last screen), so a target one past the
        // last reported page is as reached as it will ever be. Kindle removes
        // the chevron mid-render sometimes, so require it missing on repeated
        // stalled reads before believing it.
        if (currentPage !== undefined && currentPage === previousPage) {
          stuck++
          const chevronMissing =
            (await page
              .locator(chevronSelector)
              .count()
              .catch(() => 1)) === 0
          if (chevronMissing && stuck >= 2) {
            warnInfo(
              `stopping walk at page ${currentPage}: no ${direction} chevron, ` +
                `so page ${pageNumber} is past the edge of the book`
            )
            return
          }

          if (stuck >= 5) {
            throw new Error(
              `Unable to walk to page ${pageNumber}; stuck at page ${currentPage}`
            )
          }
        } else {
          stuck = 0
        }
        previousPage = currentPage
        const src = await page
          .locator(krRendererMainImageSelector)
          .getAttribute('src')
          .catch(() => undefined)

        await page
          .locator(chevronSelector)
          .click({ timeout: 5000 })
          .catch(async () => {
            await page.keyboard.press(arrowKey)
          })

        await pRace<boolean | undefined>((signal) => [
          (async () => {
            while (!signal.aborted) {
              const nextPageNav = await getPageNav().catch(() => undefined)
              if (nextPageNav?.page && nextPageNav.page !== pageNav.page) {
                return true
              }

              const newSrc = await page
                .locator(krRendererMainImageSelector)
                .getAttribute('src')
                .catch(() => undefined)
              if (src && newSrc && newSrc !== src) {
                return true
              }

              await delay(50)
            }
          })(),
          delay(5000, { signal })
        ])
      }

      const pageNav = await getPageNav().catch(() => undefined)
      throw new Error(
        `Unable to walk to page ${pageNumber}; last page was ${pageNav?.page ?? 'unknown'}`
      )
    }

    /**
     * Whether the reader is still offering a next page.
     *
     * Kindle takes the right-hand chevron away at the end of the book, and can
     * leave it in place but disabled instead. Only ever consulted after a page
     * turn produced nothing, and anything unreadable counts as "still there":
     * a missing chevron is what declares a book finished, and being wrong that
     * way round truncates it silently.
     */
    async function hasUsableNextPageChevron(): Promise<boolean> {
      try {
        const chevron = page.locator(nextPageChevronSelector).first()
        if ((await chevron.count()) === 0) return false
        if (!(await chevron.isVisible())) return false

        const disabled = await chevron.evaluate(
          (el) =>
            el.hasAttribute('disabled') ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.classList.contains('disabled') ||
            !!el.querySelector('[disabled], [aria-disabled="true"], .disabled')
        )

        return !disabled
      } catch {
        return true
      }
    }

    async function getPageNav() {
      const footerText = await page
        .locator('ion-footer ion-title')
        .first()
        .textContent()
      return parsePageNav(footerText)
    }

    function normalizePageNumberFromNav(
      pageNav: PageNav | undefined,
      { fallbackPage }: { fallbackPage: number }
    ): number {
      if (!pageNav) return fallbackPage
      if (pageNav.page !== undefined) return pageNav.page
      if (pageNav.location !== undefined) {
        return getPageForPosition(pageNav.location)
      }

      return fallbackPage
    }

    async function ensureFixedHeaderUI() {
      await page.locator('.top-chrome').evaluate((el) => {
        el.style.transition = 'none'
        el.style.transform = 'none'
      })
    }

    /**
     * Answer the "Most Recent Page Read" dialog.
     *
     * Kindle offers to jump to wherever you last read; we always want to start
     * from the beginning, so the answer is No. It appears once the book content
     * loads — not when the page first opens — and until it's gone every click
     * lands on its overlay, so this has to run after the reader is ready and
     * again before anything that navigates.
     */
    async function dismissPossibleAlert(): Promise<boolean> {
      const syncDialog = page
        .locator('ion-alert, [role="dialog"], .alert-wrapper')
        .filter({ hasText: /most recent page read/i })
        .first()

      if (await syncDialog.isVisible().catch(() => false)) {
        const $no = syncDialog
          .locator('button, ion-button')
          .filter({ hasText: /^\s*no\s*$/i })
          .first()

        if (await $no.isVisible().catch(() => false)) {
          warnInfo('dismissing "Most Recent Page Read" dialog')
          await $no.click({ force: true }).catch(() => {})
          await delay(300)
          return true
        }
      }

      // Any other yes/no alert sitting in the way.
      const $alertNo = page
        .locator('ion-alert button', { hasText: 'No' })
        .first()
      if (await $alertNo.isVisible().catch(() => false)) {
        await $alertNo.click({ force: true }).catch(() => {})
        await delay(300)
        return true
      }

      return false
    }

    async function dismissReaderPopoverMenu() {
      const readerPopover = page.locator('ion-popover')
      const maybeOpen = await readerPopover.isVisible().catch(() => false)
      if (!maybeOpen) {
        return
      }

      // Some Kindle popovers can get "stuck" and block all following clicks.
      // Try a few close strategies in order of lowest disruption.
      await page.keyboard.press('Escape').catch(() => {})
      await delay(150)
      await page.mouse.click(10, 10).catch(() => {})
      await delay(150)

      if (await readerPopover.isVisible().catch(() => false)) {
        await page
          .locator('ion-backdrop')
          .first()
          .click({ force: true })
          .catch(() => {})
        await delay(150)
      }
    }

    async function writeResultMetadata() {
      return fs.writeFile(
        metadataPath,
        JSON.stringify(normalizeBookMetadata(result), null, 2)
      )
    }

    function getTocItems(
      rawTocItem: AmazonRenderTocItem,
      { depth = 0 }: { depth?: number } = {}
    ): TocItem[] {
      const positionId = rawTocItem.tocPositionId
      const page = getPageForPosition(positionId)

      const tocItem: TocItem = {
        label: rawTocItem.label,
        positionId,
        page,
        depth
      }

      const tocItems: TocItem[] = [tocItem]

      if (rawTocItem.entries) {
        for (const rawTocItemEntry of rawTocItem.entries) {
          tocItems.push(...getTocItems(rawTocItemEntry, { depth: depth + 1 }))
        }
      }

      return tocItems
    }

    function getPageForPosition(position: number): number {
      if (!result.locationMap) return -1

      let resultPage = 1

      // TODO: this is O(n) but we can do better
      for (const { startPosition, page } of result.locationMap.navigationUnit) {
        if (startPosition > position) break

        resultPage = page
      }

      return resultPage
    }

    // Wait for the book to render before touching the reader UI. The settings
    // panel used to be driven while the content was still loading, so the sync
    // dialog would appear mid-click and Playwright would retry against its
    // overlay until the action timed out.
    logInfo('Waiting for book reader to load...')
    await page
      .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
      .catch(() => {
        console.warn(
          'Main reader content may not have loaded, continuing anyway...'
        )
      })

    await dismissPossibleAlert()
    await ensureFixedHeaderUI()
    await updateSettings()

    // Record the initial page navigation so we can reset back to it later
    const initialPageNav = await getPageNav()

    // At this point, we should have recorded all the base book metadata from the
    // initial network requests.
    assert(result.info, 'expected book info to be initialized')
    assert(result.meta, 'expected book meta to be initialized')
    assert(result.locationMap, 'expected book location map to be initialized')

    if (!result.toc?.length) {
      console.warn(
        'book toc was not initialized from render responses; synthesizing fallback toc item'
      )
      result.toc = [
        {
          label: 'Start',
          positionId: result.meta.startPosition,
          page: getPageForPosition(result.meta.startPosition),
          depth: 0
        }
      ]
    }

    result.nav.startContentPosition = result.meta.startPosition
    result.nav.totalNumPages = result.locationMap.navigationUnit.reduce(
      (acc, navUnit) => {
        return Math.max(acc, navUnit.page ?? -1)
      },
      -1
    )
    assert(result.nav.totalNumPages > 0, 'parsed book nav has no pages')
    result.nav.startContentPage = getPageForPosition(
      result.nav.startContentPosition
    )

    const parsedToc = parseTocItems(result.toc, {
      totalNumPages: result.nav.totalNumPages
    })
    result.nav.endContentPage =
      parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages
    result.nav.endContentPosition =
      parsedToc.firstPostContentPageTocItem?.positionId ??
      result.nav.endPosition

    result.nav.totalNumContentPages = Math.min(
      parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages,
      result.nav.totalNumPages
    )
    assert(result.nav.totalNumContentPages > 0, 'No content pages found')
    const pageNumberPaddingAmount = `${result.nav.totalNumContentPages * 2}`
      .length

    // Recorded before the first page is captured and mutated in place, so the
    // metadata written after every page says "incomplete" until the loop
    // reaches an actual end. A run killed halfway through then reads as what it
    // is, rather than as a short book.
    const capture: CaptureStatus = {
      complete: false,
      reason: 'interrupted',
      lastPage: 0,
      totalContentPages: result.nav.totalNumContentPages
    }
    result.capture = capture
    await writeResultMetadata()

    // Navigate to the first content page of the book
    await goToPage(result.nav.startContentPage)

    let done = false
    warnInfo(
      `\nreading ${result.nav.totalNumContentPages} content pages out of ${result.nav.totalNumPages} total pages...\n`
    )

    // Loop through each page of the book
    do {
      const pageNav = await getPageNav()
      const index = result.pages.length
      const currentNavPage = normalizePageNumberFromNav(pageNav, {
        fallbackPage: index + 1
      })
      const footerCurrentValue = pageNav?.page ?? pageNav?.location

      const stopBeforeCapture = shouldStopBeforeCapture({
        hasPageNav: !!pageNav,
        currentPage: currentNavPage,
        totalContentPages: result.nav.totalNumContentPages
      })

      if (stopBeforeCapture) {
        if (stopBeforeCapture.reason === 'no-page-nav') {
          console.warn('lost track of the page position; stopping', { index })
        }

        capture.complete = stopBeforeCapture.complete
        capture.reason = stopBeforeCapture.reason
        break
      }

      assert(pageNav, 'expected a page nav after the pre-capture check')

      const src = (await page
        .locator(krRendererMainImageSelector)
        .getAttribute('src'))!

      let renderedPageImageBuffer: Buffer | undefined

      if (renderMethod === 'blob') {
        const blob = await pRace<{ type: string; base64: string } | undefined>(
          (signal) => [
            (async () => {
              while (!signal.aborted) {
                const blob = capturedBlobs.get(src)

                if (blob) {
                  capturedBlobs.delete(src)
                  return blob
                }

                await delay(1)
              }
            })(),

            delay(10_000, { signal })
          ]
        )

        assert(
          blob,
          `no blob found for src: ${src} (index ${index}; page ${currentNavPage})`
        )

        const rawRenderedImage = Buffer.from(blob.base64, 'base64')
        const c = sharp(rawRenderedImage)
        const m = await c.metadata()
        renderedPageImageBuffer = await c
          .resize({
            width: Math.floor(m.width! / deviceScaleFactor),
            height: Math.floor(m.height! / deviceScaleFactor)
          })
          .png({ quality: 90 })
          .toBuffer()
      } else {
        renderedPageImageBuffer = await page
          .locator(krRendererMainImageSelector)
          .screenshot({ type: 'png', scale: 'css' })
      }

      assert(
        renderedPageImageBuffer,
        `no buffer found for src: ${src} (index ${index}; page ${currentNavPage})`
      )

      // Recorded relative to the book directory rather than as the path this
      // process happens to write to: the tree can then be moved, and a later
      // stage run from a different working directory still finds the image.
      const screenshot = path.join(
        PAGE_IMAGES_DIR,
        `${index}`.padStart(pageNumberPaddingAmount, '0') +
          '-' +
          `${currentNavPage}`.padStart(pageNumberPaddingAmount, '0') +
          '.png'
      )

      await fs.writeFile(path.join(outDir, screenshot), renderedPageImageBuffer)
      const pageChunk = {
        index,
        page: currentNavPage,
        screenshot
      }
      result.pages.push(pageChunk)
      capture.lastPage = currentNavPage
      if (VERBOSE_LOGGING) {
        console.warn(pageChunk)
      } else if (!QUIET_LOGGING && (index === 0 || (index + 1) % 100 === 0)) {
        console.warn(
          `captured ${index + 1} page images; current page/location ${currentNavPage}`
        )
      }
      await writeResultMetadata()

      // The footer reaching the last page means "this is probably the last
      // screen", not "stop now": Kindle's page numbers are coarse, so the last
      // numbered page can span several rendered screens and the first of them
      // reads exactly like the last. Turning the page is the only thing that
      // tells them apart, so we always try — the footer only decides how long
      // to spend on the attempt.
      const onLastNumberedPage = isOnLastNumberedPage({
        value: footerCurrentValue,
        total: pageNav.total
      })
      const maxAttempts = maxNavigationAttempts(onLastNumberedPage)

      for (let attempt = 1; ; attempt++) {
        // This delay seems to help speed up the navigation process, possibly due
        // to the navigation chevron needing time to settle.
        await delay(100)

        let clickFailed = false
        try {
          // await page.keyboard.press('ArrowRight')
          await page
            .locator(nextPageChevronSelector)
            .click({ timeout: chevronClickTimeoutMs(onLastNumberedPage) })
        } catch (err: any) {
          // Expected at the end of the book, where there's no chevron to click.
          if (onLastNumberedPage) {
            logVerbose('no next page button on the final page', err.message)
          } else {
            console.warn(
              'unable to click next page button',
              err.message,
              pageNav
            )
          }

          clickFailed = true
        }

        const navigatedToNextPage = await pRace<boolean | undefined>(
          (signal) => [
            (async () => {
              while (!signal.aborted) {
                const newSrc = await page
                  .locator(krRendererMainImageSelector)
                  .getAttribute('src')

                if (newSrc && newSrc !== src) {
                  // src changes are the most reliable indicator that Kindle moved
                  // to another rendered page image.
                  return true
                }

                await delay(10)
              }

              return false
            })(),

            delay(navigationTimeoutMs({ onLastNumberedPage, clickFailed }), {
              signal
            })
          ]
        )

        const action = shouldStopCapture({
          navigation: navigatedToNextPage
            ? 'navigated'
            : (await hasUsableNextPageChevron())
              ? 'stalled'
              : 'no-next-page',
          onLastNumberedPage,
          attempt,
          maxAttempts
        })

        if (action.type === 'capture-next-screen') break
        if (action.type === 'retry-navigation') continue

        if (action.reason === 'end-of-book') {
          warnInfo('reached the end of the book', pageNav)
        } else {
          console.warn('unable to navigate to next page; breaking...', pageNav)
        }

        capture.complete = action.complete
        capture.reason = action.reason
        done = true
        break
      }
    } while (!done)

    await writeResultMetadata()
    if (!capture.complete) {
      console.warn(
        `capture stopped early at page ${capture.lastPage} of ${capture.totalContentPages} (${capture.reason})`
      )
    }
    logInfo()
    logInfo(metadataPath)

    if (initialPageNav?.page !== undefined) {
      warnInfo(`resetting back to initial page ${initialPageNav.page}...`)
      // Restoring the reading position is a courtesy: the capture is already
      // complete and on disk, so nothing that goes wrong here is allowed to
      // fail the run.
      await goToPage(initialPageNav.page).catch((err: Error) => {
        warnInfo(`could not restore the reading position: ${err.message}`)
      })
    }
  } finally {
    // Close only this page, not the whole browser context
    await page.close()
  }
}

export interface RunExtractionOptions extends ExtractBookOptions {
  /** Persistent browser profile holding the signed-in Amazon session. */
  profileDir?: string
}

/**
 * Capture a book's pages, owning the browser lifecycle.
 *
 * The stage functions take a context so several books can share one browser;
 * this wrapper is for callers extracting a single book.
 */
export async function runExtraction({
  profileDir,
  ...options
}: RunExtractionOptions): Promise<void> {
  const context = await launchBrowserContext({ profileDir })

  // Close the default blank page that comes with the persistent context
  for (const p of context.pages()) {
    await p.close()
  }

  try {
    await extractBook(context, options)
  } finally {
    await context.close()
    await context.browser()?.close()
  }
}
