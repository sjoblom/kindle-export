import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bookLockPath,
  isBookBusyError,
  ownerLooksLive,
  withBookLock
} from './book-lock'

let bookDir: string

beforeEach(async () => {
  bookDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-lock-'))
})

afterEach(async () => {
  await fs.rm(bookDir, { recursive: true, force: true })
})

async function plantLock(pid: number, command = 'all') {
  await fs.writeFile(
    bookLockPath(bookDir),
    JSON.stringify({ pid, startedAt: new Date().toISOString(), command })
  )
}

describe('withBookLock', () => {
  it('holds the lock while running and releases it afterwards', async () => {
    let seenDuringRun: string | undefined

    await withBookLock(bookDir, async () => {
      seenDuringRun = await fs.readFile(bookLockPath(bookDir), 'utf8')
    })

    expect(JSON.parse(seenDuringRun!)).toMatchObject({ pid: process.pid })
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
  })

  it('releases the lock when the run throws', async () => {
    await expect(
      withBookLock(bookDir, async () => {
        throw new Error('capture exploded')
      })
    ).rejects.toThrow('capture exploded')

    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
  })

  it('refuses while a live kindle-export owns the book', async () => {
    await plantLock(4242, 'capture')

    const attempt = withBookLock(bookDir, async () => 'ran', {
      isAlive: () => true,
      commandLine: async () => 'node dist/cli.js capture B00X'
    })

    await expect(attempt).rejects.toSatisfy(isBookBusyError)
    await expect(attempt).rejects.toMatchObject({
      pid: 4242,
      message: expect.stringContaining('(capture)')
    })
    // The other run's lock is left exactly as it was.
    expect(
      JSON.parse(await fs.readFile(bookLockPath(bookDir), 'utf8'))
    ).toMatchObject({
      pid: 4242
    })
  })

  it('assumes a live pid is the owner when its command line is unreadable', async () => {
    await plantLock(4242)

    await expect(
      withBookLock(bookDir, async () => 'ran', {
        isAlive: () => true,
        commandLine: async () => undefined
      })
    ).rejects.toSatisfy(isBookBusyError)
  })

  it('takes over a lock whose process is gone', async () => {
    await plantLock(4242)

    const result = await withBookLock(bookDir, async () => 'ran', {
      isAlive: () => false
    })

    expect(result).toBe('ran')
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
  })

  it('takes over a lock whose pid now belongs to something else', async () => {
    // Pids get recycled; a text editor holding 4242 is not a kindle-export run.
    await plantLock(4242)

    const result = await withBookLock(bookDir, async () => 'ran', {
      isAlive: () => true,
      commandLine: async () =>
        '/Applications/TextEdit.app/Contents/MacOS/TextEdit'
    })

    expect(result).toBe('ran')
  })

  it('takes over a lock it cannot parse', async () => {
    await fs.writeFile(bookLockPath(bookDir), 'not json')

    await expect(withBookLock(bookDir, async () => 'ran')).resolves.toBe('ran')
  })

  it('creates the book directory if it does not exist yet', async () => {
    const fresh = path.join(bookDir, 'B00NEW')

    await withBookLock(fresh, async () => {
      await fs.access(fresh)
    })
  })
})

describe('ownerLooksLive', () => {
  it('recognises the ways this tool is run', () => {
    expect(
      ownerLooksLive('node /usr/local/lib/kindle-export/dist/cli.js')
    ).toBe(true)
    expect(ownerLooksLive('tsx src/cli.ts B00X')).toBe(true)
    expect(
      ownerLooksLive(
        '/Applications/Kindle Export.app/Contents/MacOS/Kindle Export'
      )
    ).toBe(true)
  })

  it('treats an unreadable command line as live', () => {
    expect(ownerLooksLive(undefined)).toBe(true)
  })

  it('treats an unrelated process as a recycled pid', () => {
    expect(ownerLooksLive('/usr/bin/vim notes.md')).toBe(false)
  })
})
