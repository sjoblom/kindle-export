import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { isProcessAlive, readProcessCommandLine } from './browser-profile-lock'

/**
 * One kindle-export run per book at a time.
 *
 * The CLI and the web app share one output tree, and each of them is happy to
 * run while the other does. The browser profile lock stops two captures, but
 * nothing stopped `kindle-export ocr X` from reading a metadata.json the web
 * app was still appending pages to, transcribing half a book, and having the
 * result deleted when that capture finished — or `clean` from deleting the
 * page images a transcription was reading. A small owner file in the book
 * directory makes the second run say so instead.
 *
 * Two atomic filesystem operations carry the whole protocol:
 *
 * - Taking the lock is `link()` from a fully written temp file. Either the
 *   lock name is free and the link succeeds, or it exists and the link fails
 *   with EEXIST — and a lock that exists always has its whole owner record in
 *   it, never a half-written one.
 * - Everything that looks at an existing lock and acts on what it saw —
 *   reading the owner, deciding it is stale, moving it aside, linking a
 *   replacement — happens while holding a second, short-lived lock: a
 *   directory made with `mkdir()`, which only one process can create. That
 *   is what makes "stale" a decision about the file that is there *now*. A
 *   contender that read the owner first, then paused, resumes still holding
 *   that directory; nobody else has been able to replace the file behind its
 *   back. Without it, a paused contender's rename would move a fresh owner's
 *   lock aside and two runs would both enter.
 *
 * Releasing checks the file carries this acquisition's own token, so a run
 * can never remove a lock that a later run has since taken over.
 *
 * Deciding whether an owner is stale reuses the profile lock's reasoning: a
 * dead pid is stale, a live pid whose command line clearly belongs to
 * something else is stale (pids get recycled), and anything we can't tell
 * apart is treated as a live owner, because refusing is recoverable and two
 * writers are not.
 */

const LOCK_FILE = '.lock'

/**
 * How many times to go round the take-or-take-over loop before giving up.
 *
 * Each pass either takes the lock, throws because someone live holds it, or
 * finds the lock vanished between looking and acting — which only a release
 * in that instant can cause.
 */
const ACQUIRE_ATTEMPTS = 5

/**
 * How long to keep trying for the takeover directory before reporting the
 * book busy. It is held for the length of one `ps` call, so anything past a
 * few seconds is a holder that has hung, and waiting on it further helps no
 * one.
 */
const TAKEOVER_WAIT_MS = 5000
const TAKEOVER_POLL_MS = 25

/**
 * A takeover directory older than this whose holder is gone was left behind
 * by a process that died mid-takeover. The age guard is belt and braces for
 * the case where the holder's pid could not be recorded or read.
 */
const TAKEOVER_STALE_MS = 30_000

export const BOOK_BUSY_CODE = 'BOOK_BUSY'

export class BookBusyError extends Error {
  readonly code = BOOK_BUSY_CODE
  readonly pid: number
  readonly bookDir: string

  constructor(pid: number, bookDir: string, command?: string) {
    super(
      `another kindle-export${command ? ` (${command})` : ''} is working on ` +
        `this book${pid ? ` (pid ${pid})` : ''}; wait for it to finish and try again`
    )
    this.name = 'BookBusyError'
    this.pid = pid
    this.bookDir = bookDir
  }
}

export function isBookBusyError(err: unknown): err is BookBusyError {
  return (
    err instanceof BookBusyError ||
    (err as { code?: string } | undefined)?.code === BOOK_BUSY_CODE
  )
}

interface BookLockOwner {
  pid: number
  /** Unique to one acquisition, so release can tell its own lock from a successor's. */
  token: string
  startedAt: string
  command?: string
}

export interface BookLockOptions {
  /** Which command is taking the lock, for the message the next run sees. */
  command?: string
  isAlive?: (pid: number) => boolean
  commandLine?: (pid: number) => Promise<string | undefined>
}

type Probes = Required<Pick<BookLockOptions, 'isAlive' | 'commandLine'>>

/**
 * Whether the process behind an owner file is still one of ours.
 *
 * Every run of this tool is a Node process, so a live pid running something
 * that is plainly not Node is a recycled pid. An unreadable command line stays
 * "ours": there is a live process and no evidence against it.
 */
export function ownerLooksLive(commandLine: string | undefined): boolean {
  if (commandLine === undefined) return true

  return /\b(node|kindle-export|tsx|Kindle Export)\b/i.test(commandLine)
}

export function bookLockPath(bookDir: string): string {
  return path.join(bookDir, LOCK_FILE)
}

/** The directory whose existence means "someone is inspecting the lock". */
export function takeoverPath(bookDir: string): string {
  return `${bookLockPath(bookDir)}.takeover`
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/**
 * Take the book's lock, run `fn`, and release it — including when `fn` throws.
 *
 * A stale lock is taken over; a live one raises `BookBusyError`, which callers
 * present as an ordinary "try again later".
 */
export async function withBookLock<T>(
  bookDir: string,
  fn: () => Promise<T>,
  {
    command,
    isAlive = isProcessAlive,
    commandLine = readProcessCommandLine
  }: BookLockOptions = {}
): Promise<T> {
  await fs.mkdir(bookDir, { recursive: true })
  const lockPath = bookLockPath(bookDir)
  const owner: BookLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    command
  }

  await acquire(bookDir, owner, { isAlive, commandLine })

  try {
    return await fn()
  } finally {
    await release(lockPath, owner)
  }
}

async function acquire(
  bookDir: string,
  owner: BookLockOwner,
  probes: Probes
): Promise<void> {
  const lockPath = bookLockPath(bookDir)

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    // The common case: nobody holds the book, and no inspection is needed.
    if (await tryLink(lockPath, owner)) return

    const outcome = await withTakeoverRight(bookDir, probes, async () => {
      // Read under the takeover right, so what we act on is what is there.
      const existing = await readOwner(lockPath)
      if (existing === 'missing') return 'vanished'

      if (
        existing !== 'unreadable' &&
        probes.isAlive(existing.pid) &&
        ownerLooksLive(
          await probes.commandLine(existing.pid).catch(() => undefined)
        )
      ) {
        throw new BookBusyError(existing.pid, bookDir, existing.command)
      }

      // Stale: left by a run that died, by a pid that now belongs to
      // something else, or a file that isn't ours to interpret. Nobody else
      // can have replaced it since we read it, so moving it aside and linking
      // our own record in its place is safe.
      const aside = `${lockPath}.stale.${owner.token}`
      try {
        await fs.rename(lockPath, aside)
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') throw err
        return 'vanished'
      }
      await fs.rm(aside, { force: true }).catch(() => {})

      return (await tryLink(lockPath, owner)) ? 'acquired' : 'vanished'
    })

    if (outcome === 'acquired') return
    // 'vanished': the lock went away between two of our own steps, which only
    // a release in that instant explains. Try again from the top.
  }

  throw new Error(
    `could not take the lock on ${bookDir}: other runs kept taking it first`
  )
}

/**
 * Run `fn` as the only process allowed to inspect and replace the book's lock.
 *
 * `mkdir()` either creates the directory or fails because it exists; there is
 * no third outcome, which is what makes it a mutex. A holder that died leaves
 * the directory behind, so a holder whose recorded pid is gone (or, failing a
 * readable pid, a directory older than `TAKEOVER_STALE_MS`) is cleared. A
 * holder that is alive but slow — `ps` hanging — is waited for briefly and
 * then reported as busy: nothing about a slow inspection makes it safe to
 * inspect concurrently.
 */
async function withTakeoverRight<T>(
  bookDir: string,
  { isAlive }: Probes,
  fn: () => Promise<T>
): Promise<T> {
  const dir = takeoverPath(bookDir)
  const deadline = Date.now() + TAKEOVER_WAIT_MS

  for (;;) {
    try {
      await fs.mkdir(dir)
      break
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
    }

    const holder = await readTakeoverHolder()
    if (holder === 'stale') {
      // Its owner died mid-inspection. Clearing it is itself a race between
      // contenders, but a harmless one: whoever creates the directory next
      // is the one whose inspection counts.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      continue
    }

    if (Date.now() > deadline) {
      throw new BookBusyError(holder === 'unknown' ? 0 : holder, bookDir)
    }
    await new Promise((resolve) => setTimeout(resolve, TAKEOVER_POLL_MS))
  }

  try {
    // Best effort, for the staleness check above; the directory itself is
    // the lock.
    await fs.writeFile(path.join(dir, 'pid'), `${process.pid}`).catch(() => {})
    return await fn()
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  /** The holder's pid, `'stale'` if it is gone, `'unknown'` if unreadable. */
  async function readTakeoverHolder(): Promise<number | 'stale' | 'unknown'> {
    const pidText = await fs
      .readFile(path.join(dir, 'pid'), 'utf8')
      .catch(() => undefined)
    const pid = pidText === undefined ? undefined : Number.parseInt(pidText, 10)

    if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
      return isAlive(pid) ? pid : 'stale'
    }

    // The pid file is written just after mkdir; not finding it means either
    // that instant or a holder that died in it. Age tells the two apart.
    const created = await fs
      .stat(dir)
      .then((stat) => stat.mtimeMs)
      .catch(() => undefined)
    if (created !== undefined && Date.now() - created > TAKEOVER_STALE_MS) {
      return 'stale'
    }

    return 'unknown'
  }
}

/**
 * Create the lock with the owner record already in it, or learn that the name
 * is taken. `link()` is the atomic step: unlike `writeFile` with `wx`, there is
 * no moment where the lock exists but is empty.
 */
async function tryLink(
  lockPath: string,
  owner: BookLockOwner
): Promise<boolean> {
  const temp = `${lockPath}.${owner.token}.tmp`
  await fs.writeFile(temp, JSON.stringify(owner, null, 2))

  try {
    await fs.link(temp, lockPath)
    return true
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err
    return false
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

async function release(lockPath: string, owner: BookLockOwner): Promise<void> {
  // Only this acquisition's own lock comes off. Anything else in its place —
  // a later run that took it over as stale — is that run's, and removing it
  // would reintroduce the race this exists to prevent.
  const current = await readOwner(lockPath)
  if (typeof current === 'object' && current.token === owner.token) {
    await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}

async function readOwner(
  lockPath: string
): Promise<BookLockOwner | 'missing' | 'unreadable'> {
  let raw: string
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? 'missing' : 'unreadable'
  }

  try {
    const parsed = JSON.parse(raw) as Partial<BookLockOwner> | null
    if (typeof parsed?.pid !== 'number' || parsed.pid <= 0) return 'unreadable'
    if (typeof parsed.token !== 'string') return 'unreadable'

    return parsed as BookLockOwner
  } catch {
    return 'unreadable'
  }
}
