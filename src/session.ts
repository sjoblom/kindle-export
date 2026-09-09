import { launchBrowserContext } from './extract-kindle-book'

/**
 * Interactive Amazon sign-in, shared by the CLI and the local web app.
 *
 * A browser window opens on the Kindle library; the person signs in by hand
 * (password, 2FA, whatever Amazon asks for) and we watch the URL until it
 * lands back on the library. That way the window can close itself on success
 * instead of asking the user to know when they're done.
 */

const LIBRARY_URL = 'https://read.amazon.com/kindle-library'

/** How long to wait for a person to complete sign-in by hand. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

const SIGN_IN_POLL_MS = 1000

/**
 * Whether a URL shows a signed-in Kindle session.
 *
 * Amazon bounces an expired session from read.amazon.com to a signin page, so
 * "on the reader domain and not on a signin path" is the working definition —
 * the same one the library fetcher uses to throw NotSignedInError.
 */
export function isSignedInUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'read.amazon.com' &&
    !/\/ap\/signin|\/gp\/signin/.test(parsed.pathname)
  )
}

export interface WaitForSignInOptions {
  timeoutMs?: number
  pollMs?: number
}

/**
 * Resolve `true` once any page in the context reaches a signed-in Kindle URL,
 * `false` when the window is closed or the timeout passes first.
 */
export async function waitForSignIn(
  context: Awaited<ReturnType<typeof launchBrowserContext>>,
  {
    timeoutMs = SIGN_IN_TIMEOUT_MS,
    pollMs = SIGN_IN_POLL_MS
  }: WaitForSignInOptions = {}
): Promise<boolean> {
  let closed = false
  context.on('close', () => {
    closed = true
  })

  const deadline = Date.now() + timeoutMs
  while (!closed && Date.now() < deadline) {
    // The sign-in flow can navigate, open and close pages; look at whatever
    // exists right now rather than holding on to one page.
    for (const page of context.pages()) {
      try {
        if (isSignedInUrl(page.url())) return true
      } catch {
        // The page closed under us mid-check; the next poll sees the rest.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  return false
}

/**
 * Open a browser window for the user to sign in to Amazon, and close it as
 * soon as the session is confirmed. Returns whether sign-in was confirmed —
 * `false` covers both "gave up" and "closed the window on us", so callers
 * should treat it as unknown rather than signed out.
 */
export async function interactiveLogin(
  profileDir: string,
  opts: WaitForSignInOptions = {}
): Promise<boolean> {
  const context = await launchBrowserContext({ profileDir })

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(LIBRARY_URL, { waitUntil: 'domcontentloaded' })

    if (isSignedInUrl(page.url())) return true

    return await waitForSignIn(context, opts)
  } catch {
    // Navigation throws when the user closes the window mid-load; that's an
    // answer ("not confirmed"), not an error.
    return false
  } finally {
    await context.close().catch(() => {})
    await context
      .browser()
      ?.close()
      .catch(() => {})
  }
}
