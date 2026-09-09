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
 * result deleted when that capture finished. A small owner file in the book
 * directory makes the second run say so instead.
 *
 * Deciding whether an owner file is stale reuses the profile lock's reasoning:
 * a dead pid is stale, a live pid whose command line clearly belongs to
 * something else is stale (pids get recycled), and anything we can't tell
 * apart is treated as a live owner, because refusing is recoverable and two
 * writers are not.
 */

const LOCK_FILE = '.lock'

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

/**
 * Take the book's lock, run `fn`, and release it — including when `fn` throws.
 *
 * The lock is a small JSON file created exclusively, so two runs racing for
 * it can't both win. A stale file is replaced; a live one raises
 * `BookBusyError`, which callers present as an ordinary "try again later".
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
    startedAt: new Date().toISOString(),
    command
  }
  const body = JSON.stringify(owner, null, 2)

  try {
    await fs.writeFile(lockPath, body, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err

    const existing = await readOwner(lockPath)
    if (
      existing &&
      existing.pid !== process.pid &&
      isAlive(existing.pid) &&
      ownerLooksLive(await commandLine(existing.pid).catch(() => undefined))
    ) {
      throw new BookBusyError(existing.pid, bookDir, existing.command)
    }

    // Left behind by a run that died, or by a pid that now belongs to
    // something else. Take it over.
    await fs.writeFile(lockPath, body)
  }

  try {
    return await fn()
  } finally {
    // Only our own lock comes off: a crash-and-restart of this same pid is
    // not something we can distinguish, and removing someone else's file
    // would reintroduce exactly the race this exists to prevent.
    const current = await readOwner(lockPath)
    if (current?.pid === process.pid) {
      await fs.rm(lockPath, { force: true }).catch(() => {})
    }
  }
}

async function readOwner(lockPath: string): Promise<BookLockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(lockPath, 'utf8')
    ) as Partial<BookLockOwner> | null
    if (typeof parsed?.pid !== 'number' || parsed.pid <= 0) return

    return parsed as BookLockOwner
  } catch {
    // Unreadable or malformed: nothing we can respect, so treat it as stale.
    return
  }
}
