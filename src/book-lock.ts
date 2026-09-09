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
 * page images a transcription was reading. A lock in the book directory makes
 * the second run say so instead.
 *
 * The lock is a directory, `.lock`, holding exactly one owner file whose name
 * is unique to one acquisition: `owner-<pid>-<token>.json`. That shape is the
 * whole point. Earlier versions kept a single lock file and recovered a stale
 * one by deleting or renaming it, and every such step raced: a contender that
 * judged the lock stale, paused, and resumed would delete whatever occupied
 * that name by then — a fresh owner's lock — and two runs entered together.
 * Adding a second lock to guard the first only moved the same race onto the
 * second lock's recovery.
 *
 * Here nothing ever acts unconditionally on a shared name. Every mutation is
 * one of three operations that the filesystem itself refuses when the
 * situation has changed since we looked:
 *
 * - Taking the lock is `rename()` of a staging directory, already holding
 *   our owner file, onto `.lock`. The rename succeeds only if `.lock` is
 *   absent or an empty directory, and a held lock is never empty: owners
 *   arrive populated, by this very rename.
 * - Recovering a stale lock is `unlink()` of the owner file we read, by its
 *   unique name. If anyone recovered it before us, that name is gone and the
 *   unlink fails; we look again and find the new owner instead. A fresh
 *   owner's file has a different name, so a delayed contender cannot remove
 *   it by mistake.
 * - Then `rmdir()` of `.lock`, which fails unless the directory is empty —
 *   so it can never remove a lock that a new owner has since renamed into
 *   place.
 *
 * Releasing is the same unlink-then-rmdir on our own file, and cannot touch a
 * successor's for the same reasons.
 *
 * Deciding whether an owner is stale reuses the profile lock's reasoning: a
 * dead pid is stale, a live pid whose command line clearly belongs to
 * something else is stale (pids get recycled), and anything we can't tell
 * apart is treated as a live owner, because refusing is recoverable and two
 * writers are not.
 */

const LOCK_DIR = '.lock'

/**
 * Passes round the take-or-recover loop before giving up.
 *
 * Each pass either takes the lock, throws because someone live holds it, or
 * loses a race with another contender at one of the conditional steps — and
 * losing means that contender now holds the lock, so the next pass throws.
 * Extra passes only cover a contender that took and released the lock within
 * the same instant.
 */
const ACQUIRE_ATTEMPTS = 8

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
  /** Unique to one acquisition; also part of the owner file's name. */
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
  return path.join(bookDir, LOCK_DIR)
}

/** The owner file's name, unique to one acquisition. */
export function ownerFileName(owner: Pick<BookLockOwner, 'pid' | 'token'>) {
  return `owner-${owner.pid}-${owner.token}.json`
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/**
 * Take the book's lock, run `fn`, and release it — including when `fn` throws.
 *
 * A stale lock is recovered; a live one raises `BookBusyError`, which callers
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
    await release(bookDir, owner)
  }
}

async function acquire(
  bookDir: string,
  owner: BookLockOwner,
  probes: Probes
): Promise<void> {
  const lockDir = bookLockPath(bookDir)
  let lastSeen: BookLockOwner | undefined

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (await tryTake(bookDir, owner)) return

    // Something holds the name. Look at it, and act only through steps that
    // fail if it has changed since.
    const seen = await inspect(lockDir)

    if (seen.kind === 'missing') continue

    if (seen.kind === 'file') {
      // A lock written by an earlier version of this module, which was a
      // plain file. Its owner is judged the same way; unlink() of a plain
      // file cannot touch a directory, so a fresh owner is safe from it.
      await judge(seen.owner, bookDir, probes)
      await fs.unlink(lockDir).catch(() => {})
      continue
    }

    if (seen.kind === 'empty') {
      // An owner mid-release, or mid-recovery. rmdir() only succeeds while it
      // is still empty; if a new owner renamed into place first, it fails.
      await fs.rmdir(lockDir).catch(() => {})
      continue
    }

    await judge(seen.owner, bookDir, probes)
    lastSeen = seen.owner ?? lastSeen

    // Stale. Remove the owner file we read, by the name we read. Gone already
    // means someone else recovered it — and may be the owner now.
    try {
      await fs.unlink(path.join(lockDir, seen.name))
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err
      continue
    }
    // Only an empty directory comes off; a directory a new owner has since
    // renamed in is populated and stays.
    await fs.rmdir(lockDir).catch(() => {})
  }

  // Every pass lost a race to another contender. That is a busy book, even
  // if no single owner held it long enough to be named.
  throw new BookBusyError(lastSeen?.pid ?? 0, bookDir, lastSeen?.command)
}

/** Throw if `owner` is a live kindle-export run; return if it is stale. */
async function judge(
  owner: BookLockOwner | undefined,
  bookDir: string,
  { isAlive, commandLine }: Probes
): Promise<void> {
  if (!owner) return

  if (
    isAlive(owner.pid) &&
    ownerLooksLive(await commandLine(owner.pid).catch(() => undefined))
  ) {
    throw new BookBusyError(owner.pid, bookDir, owner.command)
  }
}

/**
 * Rename a staging directory that already holds our owner file onto `.lock`.
 *
 * `rename()` of a directory onto an existing directory succeeds only if that
 * directory is empty, and fails otherwise — which is exactly "take the lock
 * unless someone holds it", decided by the filesystem in one step.
 */
async function tryTake(
  bookDir: string,
  owner: BookLockOwner
): Promise<boolean> {
  const lockDir = bookLockPath(bookDir)
  const staging = path.join(bookDir, `${LOCK_DIR}.staging.${owner.token}`)

  await fs.mkdir(staging)
  await fs.writeFile(
    path.join(staging, ownerFileName(owner)),
    JSON.stringify(owner, null, 2)
  )

  try {
    await fs.rename(staging, lockDir)
    return true
  } catch (err) {
    // ENOTEMPTY and EEXIST: a populated lock is there. ENOTDIR: an old-style
    // lock file is there. All mean "held", and inspect() sorts them out.
    if (!['ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(errorCode(err) ?? '')) {
      throw err
    }
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

type Inspection =
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'file'; owner: BookLockOwner | undefined }
  | { kind: 'owned'; name: string; owner: BookLockOwner | undefined }

/** What occupies the lock name right now. */
async function inspect(lockDir: string): Promise<Inspection> {
  let entries: string[]
  try {
    entries = await fs.readdir(lockDir)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { kind: 'missing' }
    if (errorCode(err) === 'ENOTDIR') {
      return { kind: 'file', owner: await readOwner(lockDir) }
    }
    throw err
  }

  if (entries.length === 0) return { kind: 'empty' }

  // Exactly one owner file is the only shape this module writes. Anything
  // else is treated as that entry being the owner: an unreadable owner is
  // stale, and the recovery below still removes only the names it saw.
  const name =
    entries.find((entry) => entry.startsWith('owner-')) ?? entries[0]!

  return {
    kind: 'owned',
    name,
    owner: await readOwner(path.join(lockDir, name))
  }
}

async function release(bookDir: string, owner: BookLockOwner): Promise<void> {
  const lockDir = bookLockPath(bookDir)
  // Our own file by its unique name, then the directory only if that left it
  // empty. Neither step can touch a successor's lock.
  await fs.unlink(path.join(lockDir, ownerFileName(owner))).catch(() => {})
  await fs.rmdir(lockDir).catch(() => {})
}

/** The owner record in a file, or undefined if it is not one. */
async function readOwner(file: string): Promise<BookLockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(file, 'utf8')
    ) as Partial<BookLockOwner> | null
    if (typeof parsed?.pid !== 'number' || parsed.pid <= 0) return

    return parsed as BookLockOwner
  } catch {
    return
  }
}
