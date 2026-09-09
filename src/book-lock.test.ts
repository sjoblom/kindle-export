import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bookLockPath,
  isBookBusyError,
  ownerLooksLive,
  withBookLock
} from './book-lock'

const execFileAsync = promisify(execFile)

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
    JSON.stringify({
      pid,
      token: 'planted',
      startedAt: new Date().toISOString(),
      command
    })
  )
}

async function readOwner(): Promise<{ pid: number; token: string }> {
  return JSON.parse(await fs.readFile(bookLockPath(bookDir), 'utf8')) as {
    pid: number
    token: string
  }
}

/** Only the lock file itself should ever be left in the book directory. */
async function leftovers(): Promise<string[]> {
  return (await fs.readdir(bookDir)).filter((name) => name !== '.lock')
}

/** Run `fn` on a leftover lock whose pid now belongs to an unrelated program. */
function takeOverStale<T>(fn: () => Promise<T>) {
  return withBookLock(bookDir, fn, {
    isAlive: () => true,
    commandLine: async () =>
      '/Applications/TextEdit.app/Contents/MacOS/TextEdit'
  })
}

describe('withBookLock', () => {
  it('holds the lock while running and releases it afterwards', async () => {
    let seenDuringRun: { pid: number; token: string } | undefined

    await withBookLock(bookDir, async () => {
      seenDuringRun = await readOwner()
    })

    expect(seenDuringRun).toMatchObject({ pid: process.pid })
    expect(seenDuringRun?.token).toBeTypeOf('string')
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
    expect(await leftovers()).toEqual([])
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
    expect(await readOwner()).toMatchObject({ pid: 4242, token: 'planted' })
    expect(await leftovers()).toEqual([])
  })

  it('refuses a second run from this same process too', async () => {
    // The web server processes books one at a time, so this only happens by
    // mistake — and a mistake that lets two runs write one book is the bug.
    await withBookLock(bookDir, async () => {
      await expect(withBookLock(bookDir, async () => 'ran')).rejects.toSatisfy(
        isBookBusyError
      )
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
    expect(await leftovers()).toEqual([])
  })

  it('takes over a lock whose pid now belongs to something else', async () => {
    // Pids get recycled; a text editor holding 4242 is not a kindle-export run.
    await plantLock(4242)

    expect(await takeOverStale(async () => 'ran')).toBe('ran')
  })

  it('takes over a lock it cannot parse', async () => {
    await fs.writeFile(bookLockPath(bookDir), 'not json')

    await expect(withBookLock(bookDir, async () => 'ran')).resolves.toBe('ran')
  })

  it('lets exactly one of many contenders take over a stale lock', async () => {
    // Every contender reads the same stale owner before any of them acts on
    // it — the interleaving that let two runs both "win" when takeover was a
    // plain overwrite. The rename that moves the stale file aside can only
    // succeed once, so one contender links its lock and the rest find it live.
    await plantLock(4242)

    const contenders = 8
    let readOwners = 0
    let allRead: () => void
    const everyoneHasRead = new Promise<void>((resolve) => {
      allRead = resolve
    })

    let inside = 0
    let mostInside = 0
    const outcomes = await Promise.all(
      Array.from({ length: contenders }, () =>
        withBookLock(
          bookDir,
          async () => {
            mostInside = Math.max(mostInside, ++inside)
            await new Promise((resolve) => setTimeout(resolve, 20))
            inside--
            return 'entered'
          },
          {
            isAlive: () => true,
            commandLine: async (pid) => {
              // The planted owner is stale; the winner's own lock is live. A
              // contender that is asked about our pid has lost the race.
              if (pid === process.pid) return 'node vitest'

              if (++readOwners === contenders) allRead!()
              await everyoneHasRead
              return '/usr/bin/vim'
            }
          }
        ).catch((err: unknown) => (isBookBusyError(err) ? 'busy' : err))
      )
    )

    expect(outcomes.filter((o) => o === 'entered')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'busy')).toHaveLength(contenders - 1)
    expect(mostInside).toBe(1)
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
    expect(await leftovers()).toEqual([])
  })

  it('never removes a lock a later run has taken over', async () => {
    // Run A's lock goes stale from B's point of view (B is told A's pid is
    // dead), B takes over, then A finishes: A must leave B's lock alone.
    let releaseA: () => void
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const runA = withBookLock(bookDir, () => aMayFinish, { command: 'ocr' })
    // Let A take the lock before B looks at it.
    await new Promise((resolve) => setTimeout(resolve, 20))

    let bOwner: { token: string } | undefined
    const runB = withBookLock(
      bookDir,
      async () => {
        bOwner = await readOwner()
        releaseA!()
        await runA
        // A has finished and released; B's lock must still be here.
        expect(await readOwner()).toMatchObject({ token: bOwner!.token })
      },
      { isAlive: () => false, command: 'export' }
    )

    await runB
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
  })

  it('creates the book directory if it does not exist yet', async () => {
    const fresh = path.join(bookDir, 'B00NEW')

    await withBookLock(fresh, async () => {
      await fs.access(fresh)
    })
  })

  it('lets only one of two real processes take over a stale lock', async () => {
    // The same race as above, across process boundaries: two Node processes
    // both read the stale owner, are both released at once, and both try to
    // take the lock over. Each writes what happened to it.
    await plantLock(4242)
    const proceed = path.join(bookDir, 'proceed')
    const script = path.join(bookDir, 'contender.mts')
    await fs.writeFile(
      script,
      `
      import fs from 'node:fs/promises'
      import { isBookBusyError, withBookLock } from ${JSON.stringify(
        path.resolve('src/book-lock.ts')
      )}

      const [bookDir, proceed, out] = process.argv.slice(2)
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

      try {
        await withBookLock(
          bookDir,
          async () => {
            await sleep(300)
            return 'entered'
          },
          {
            isAlive: () => true,
            commandLine: async (pid) => {
              if (pid !== 4242) return 'node contender'
              // The stale owner has been read; wait for the starting gun so
              // both processes act on that reading at the same moment.
              while (!(await fs.access(proceed).then(() => true, () => false))) {
                await sleep(10)
              }
              return '/usr/bin/vim'
            }
          }
        )
        await fs.writeFile(out, 'entered')
      } catch (err) {
        await fs.writeFile(out, isBookBusyError(err) ? 'busy' : String(err))
      }
      `
    )

    const outputs = ['a', 'b'].map((name) =>
      path.join(bookDir, `result-${name}`)
    )
    const children = outputs.map((out) =>
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        script,
        bookDir,
        proceed,
        out
      ])
    )

    // Both children are parked inside commandLine by now; fire the gun.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await fs.writeFile(proceed, '')
    await Promise.all(children)

    const results = await Promise.all(
      outputs.map((out) => fs.readFile(out, 'utf8'))
    )
    expect(results.toSorted()).toEqual(['busy', 'entered'])
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
  }, 30_000)
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
