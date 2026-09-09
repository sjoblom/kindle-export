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
 * Every step that decides ownership is an atomic filesystem operation, so two
 * runs racing for the same lock can't both win:
 *
 * - Taking the lock is `link()` from a fully written temp file. Either the
 *   lock name is free and the link succeeds, or it exists and the link fails
 *   with EEXIST — and a lock that exists always has its whole owner record in
 *   it, never a half-written one.
 * - Taking over a stale lock is `rename()` of the stale file out of the way.
 *   Only one contender's rename succeeds; the rest see ENOENT and go back to
 *   trying `link()`, where they find the winner's fresh lock and stop.
 * - Releasing checks the file carries this acquisition's own token, so a run
 *   can never remove a lock that a later run has since taken over.
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
 * loses a race to another contender — and losing means that contender now
 * holds a live lock, so the next pass throws. Extra passes only cover a
 * contender that took over and released within the same instant.
 */
const ACQUIRE_ATTEMPTS = 5

export const BOOK_BUSY_CODE = 'BOOK_BUSY'

export class BookBusyError extends Error {
  readonly code = BOOK_BUSY_CODE
  readonly pid: number
  readonly bookDir: string

  constructor(pid: number, bookDir: string, command?: string) {
    super(
      `another kindle-export${command ? ` (${command})` : ''} is working on ` +
        `this book (pid ${pid}); wait for it to finish and try again`
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

  await acquire(lockPath, owner, { isAlive, commandLine })

  try {
    return await fn()
  } finally {
    await release(lockPath, owner)
  }
}

async function acquire(
  lockPath: string,
  owner: BookLockOwner,
  {
    isAlive,
    commandLine
  }: Required<Pick<BookLockOptions, 'isAlive' | 'commandLine'>>
): Promise<void> {
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (await tryLink(lockPath, owner)) return

    // Something holds the name. Read it; a record that exists is complete,
    // because it was linked into place already written.
    const existing = await readOwner(lockPath)

    if (existing === 'missing') {
      // Released (or taken over and released) between our link and our read.
      continue
    }

    if (
      existing !== 'unreadable' &&
      isAlive(existing.pid) &&
      ownerLooksLive(await commandLine(existing.pid).catch(() => undefined))
    ) {
      throw new BookBusyError(
        existing.pid,
        path.dirname(lockPath),
        existing.command
      )
    }

    // Stale: left by a run that died, by a pid that now belongs to something
    // else, or a file that isn't ours to interpret. Move it out of the way —
    // atomically, so only one contender gets to — then go round again and
    // link. A contender that loses this rename finds our lock on its next
    // pass and reports us as the live owner.
    const aside = `${lockPath}.stale.${owner.token}`
    try {
      await fs.rename(lockPath, aside)
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err
      continue
    }
    await fs.rm(aside, { force: true }).catch(() => {})
  }

  throw new Error(
    `could not take the lock on ${path.dirname(lockPath)}: ` +
      'other runs kept taking it first'
  )
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
