import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Who, if anyone, is using the shared browser profile.
 *
 * Chrome refuses to open a profile directory twice, and marks its ownership
 * with a `SingletonLock` symlink whose target ends in the owning pid. This
 * module answers one question about that lock — is it stale, or is a browser
 * really running behind it? — because the two look identical on disk and the
 * consequences of guessing differ wildly: clearing a stale lock unblocks the
 * app, while clearing a live one hands Chrome a profile another process is
 * writing to.
 *
 * The old behaviour was worse than guessing: it killed whatever pid the lock
 * named. Running `kindle-export list` while the web app was capturing a book
 * killed the capture, and a stale lock whose pid had been recycled killed an
 * unrelated process. Nothing here kills anything.
 */

/** Marker for callers that can't rely on `instanceof` across bundles. */
export const PROFILE_BUSY_CODE = 'PROFILE_BUSY'

/**
 * The profile is in use by a browser we started earlier and shouldn't disturb.
 *
 * Thrown rather than returned because every caller of `launchBrowserContext`
 * fails the same way: there is no browser to hand back.
 */
export class ProfileBusyError extends Error {
  readonly code = PROFILE_BUSY_CODE
  readonly pid: number
  readonly profileDir: string

  constructor(pid: number, profileDir: string) {
    super(
      `another kindle-export browser is using this profile (pid ${pid}); ` +
        'wait for it to finish, or close that browser window and try again'
    )
    this.name = 'ProfileBusyError'
    this.pid = pid
    this.profileDir = profileDir
  }
}

export function isProfileBusyError(err: unknown): err is ProfileBusyError {
  return (
    err instanceof ProfileBusyError ||
    (err as { code?: string } | undefined)?.code === PROFILE_BUSY_CODE
  )
}

export type ProfileLockState =
  /** No lock, or nothing behind it — the profile can be opened. */
  | { state: 'unlocked' }
  /** A lock left behind by a process that's gone; safe to remove. */
  | { state: 'stale'; pid?: number; reason: string }
  /** A live browser holds the profile. */
  | { state: 'busy'; pid: number }

/** Signal 0 checks for the process without touching it. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The full command line of a running process, or `undefined` when it can't be
 * read — which includes Windows, where there's no `ps`. Unknown is deliberately
 * not an error: the caller treats it as "assume this is the owner".
 */
export async function readProcessCommandLine(
  pid: number
): Promise<string | undefined> {
  if (process.platform === 'win32') return

  try {
    const { stdout } = await execFileAsync('ps', [
      '-o',
      'command=',
      '-p',
      `${pid}`
    ])
    const commandLine = stdout.trim()
    return commandLine || undefined
  } catch {
    // No such process, or `ps` is missing/restricted.
    return undefined
  }
}

/** The pid Chrome encodes in its SingletonLock target (`host-12345`). */
export function parseLockPid(linkTarget: string): number | undefined {
  const pidMatch = linkTarget.match(/-(\d+)$/)
  if (!pidMatch) return

  const pid = Number.parseInt(pidMatch[1]!, 10)
  return Number.isNaN(pid) || pid <= 0 ? undefined : pid
}

/**
 * Whether a process's command line shows it running against this profile.
 *
 * Chrome is launched with `--user-data-dir=<profile>`, so that argument is the
 * direct answer. When it isn't there to compare against we fall back to "does
 * the profile path appear at all", and every ambiguity resolves towards "yes,
 * this is the owner": a false positive costs the user a clear error message,
 * while a false negative deletes the lock out from under a running browser.
 */
export function commandLineOwnsProfile(
  commandLine: string,
  profileDir: string
): boolean {
  // The caller's `profileDir` may be relative ('out/.browser-profile') while
  // the command line shows an absolute path, or the other way around.
  const candidates = [profileDir, path.resolve(profileDir)]

  const userDataDir = commandLine.match(
    /--user-data-dir[= ]("[^"]*"|'[^']*'|\S+)/
  )?.[1]

  if (userDataDir) {
    const unquoted = userDataDir.replaceAll(/^["']|["']$/g, '')
    // Compared as resolved paths so a profile named `.browser-profile` isn't
    // mistaken for `.browser-profile-2`, which substring matching would do.
    return candidates.some(
      (candidate) => path.resolve(unquoted) === path.resolve(candidate)
    )
  }

  return candidates.some((candidate) => commandLine.includes(candidate))
}

export interface InspectProfileLockOptions {
  /** The profile directory the lock lives in. */
  profileDir: string
  /** The SingletonLock symlink's target, or `undefined` when there is none. */
  linkTarget?: string
  isAlive?: (pid: number) => boolean
  commandLine?: (pid: number) => Promise<string | undefined>
}

/**
 * Classify the profile's SingletonLock without touching any process.
 *
 * Injecting `isAlive` and `commandLine` keeps this decision testable — it is
 * the part with the interesting cases (dead pid, recycled pid, live owner,
 * unreadable command line), and the part whose old version killed processes.
 */
export async function inspectProfileLock({
  profileDir,
  linkTarget,
  isAlive = isProcessAlive,
  commandLine = readProcessCommandLine
}: InspectProfileLockOptions): Promise<ProfileLockState> {
  if (!linkTarget) return { state: 'unlocked' }

  const pid = parseLockPid(linkTarget)
  if (pid === undefined) {
    return {
      state: 'stale',
      reason: `lock target ${JSON.stringify(linkTarget)} names no pid`
    }
  }

  if (!isAlive(pid)) {
    return { state: 'stale', pid, reason: `pid ${pid} is gone` }
  }

  const command = await commandLine(pid).catch(() => undefined)
  if (command === undefined) {
    // We know something is alive under that pid and nothing more. Assume it's
    // the browser: refusing to launch is recoverable, stealing the profile
    // from a running capture is not.
    return { state: 'busy', pid }
  }

  if (commandLineOwnsProfile(command, profileDir)) {
    return { state: 'busy', pid }
  }

  // The pid is alive but belongs to something else entirely — pids get reused,
  // and an ordinary program has no business being killed over a Chrome lock.
  return {
    state: 'stale',
    pid,
    reason: `pid ${pid} is not a browser using this profile`
  }
}
