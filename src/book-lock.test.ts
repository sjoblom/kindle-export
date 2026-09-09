import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bookLockPath,
  isBookBusyError,
  ownerFileName,
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

interface Owner {
  pid: number
  token: string
  command?: string
}

/** A lock as this module writes it: a directory holding one owner file. */
async function plantLock(pid: number, command = 'all', token = 'planted') {
  const lockDir = bookLockPath(bookDir)
  await fs.mkdir(lockDir)
  await fs.writeFile(
    path.join(lockDir, ownerFileName({ pid, token })),
    JSON.stringify({ pid, token, startedAt: new Date().toISOString(), command })
  )
}

async function readOwner(): Promise<Owner> {
  const lockDir = bookLockPath(bookDir)
  const [name] = await fs.readdir(lockDir)
  return JSON.parse(
    await fs.readFile(path.join(lockDir, name!), 'utf8')
  ) as Owner
}

async function lockExists(): Promise<boolean> {
  return fs.access(bookLockPath(bookDir)).then(
    () => true,
    () => false
  )
}

/** Only the lock itself should ever be left in the book directory. */
async function leftovers(): Promise<string[]> {
  return (await fs.readdir(bookDir)).filter((name) => name !== '.lock')
}

/**
 * Run `fn` on a leftover lock whose pid now belongs to an unrelated program.
 * Locks taken by this process meanwhile are, correctly, reported as ours.
 */
function takeOverStale<T>(fn: () => Promise<T>) {
  return withBookLock(bookDir, fn, {
    isAlive: () => true,
    commandLine: async (pid) =>
      pid === process.pid
        ? 'node vitest'
        : '/Applications/TextEdit.app/Contents/MacOS/TextEdit'
  })
}

const busyOr = (err: unknown) => (isBookBusyError(err) ? 'busy' : err)

describe('withBookLock', () => {
  it('holds the lock while running and releases it afterwards', async () => {
    let seenDuringRun: Owner | undefined

    await withBookLock(bookDir, async () => {
      seenDuringRun = await readOwner()
    })

    expect(seenDuringRun).toMatchObject({ pid: process.pid })
    expect(seenDuringRun?.token).toBeTypeOf('string')
    expect(await lockExists()).toBe(false)
    expect(await leftovers()).toEqual([])
  })

  it('releases the lock when the run throws', async () => {
    await expect(
      withBookLock(bookDir, async () => {
        throw new Error('capture exploded')
      })
    ).rejects.toThrow('capture exploded')

    expect(await lockExists()).toBe(false)
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
    expect(await lockExists()).toBe(false)
    expect(await leftovers()).toEqual([])
  })

  it('takes over a lock whose pid now belongs to something else', async () => {
    // Pids get recycled; a text editor holding 4242 is not a kindle-export run.
    await plantLock(4242)

    expect(await takeOverStale(async () => 'ran')).toBe('ran')
  })

  it('takes over a lock whose owner file it cannot parse', async () => {
    await fs.mkdir(bookLockPath(bookDir))
    await fs.writeFile(path.join(bookLockPath(bookDir), 'owner-x.json'), '???')

    await expect(withBookLock(bookDir, async () => 'ran')).resolves.toBe('ran')
    expect(await lockExists()).toBe(false)
  })

  it('takes over an empty lock directory left mid-release', async () => {
    await fs.mkdir(bookLockPath(bookDir))

    await expect(withBookLock(bookDir, async () => 'ran')).resolves.toBe('ran')
    expect(await lockExists()).toBe(false)
  })

  it('judges and replaces a lock file from the previous format', async () => {
    await fs.writeFile(
      bookLockPath(bookDir),
      JSON.stringify({ pid: 4242, token: 'old', command: 'ocr' })
    )

    await expect(
      withBookLock(bookDir, async () => 'ran', {
        isAlive: () => true,
        commandLine: async () => 'node dist/cli.js ocr B00X'
      })
    ).rejects.toSatisfy(isBookBusyError)

    const result = await withBookLock(bookDir, async () => 'ran', {
      isAlive: () => false
    })
    expect(result).toBe('ran')
    expect(await lockExists()).toBe(false)
  })

  it('does not let a delayed contender act on a stale verdict', async () => {
    // The schedule that beat the file-based versions: A and B both read the
    // same stale owner; B pauses inside its liveness check; A recovers the
    // lock and enters; B resumes with its stale verdict. B's recovery is an
    // unlink of the owner file it read, by name — and that name is gone, so
    // B looks again and finds A alive.
    await plantLock(4242)

    let releaseB: () => void
    const bMayResume = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let bIsInspecting: () => void
    const bStartedInspecting = new Promise<void>((resolve) => {
      bIsInspecting = resolve
    })

    let inside = 0
    let mostInside = 0
    let aFinished = false
    const enter = async () => {
      mostInside = Math.max(mostInside, ++inside)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inside--
      return 'entered'
    }
    const probes = (pause: boolean) => ({
      isAlive: () => true,
      commandLine: async (pid: number) => {
        if (pid === process.pid) return 'node vitest'
        if (pause) {
          bIsInspecting()
          await bMayResume
        }
        return '/usr/bin/vim'
      }
    })

    const runB = withBookLock(bookDir, enter, probes(true)).catch(busyOr)
    await bStartedInspecting
    const runA = withBookLock(bookDir, enter, probes(false))
      .catch(busyOr)
      .finally(() => {
        aFinished = true
      })
    // A must have recovered the lock and be inside before B resumes.
    while (inside === 0 && !aFinished) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    releaseB!()

    const [a, b] = await Promise.all([runA, runB])
    expect(a).toBe('entered')
    expect(b).toBe('busy')
    expect(mostInside).toBe(1)
    expect(await lockExists()).toBe(false)
    expect(await leftovers()).toEqual([])
  })

  it('serialises many contenders over one stale lock, round after round', async () => {
    for (let round = 0; round < 5; round++) {
      await plantLock(4242)

      let inside = 0
      let mostInside = 0
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          takeOverStale(async () => {
            mostInside = Math.max(mostInside, ++inside)
            await new Promise((resolve) => setTimeout(resolve, 10))
            inside--
            return 'entered'
          }).catch(busyOr)
        )
      )

      // Whether a given contender enters (after the previous one released) or
      // is told the book is busy depends on timing; what may never happen is
      // two of them inside at once.
      expect(outcomes.every((o) => o === 'entered' || o === 'busy')).toBe(true)
      expect(outcomes.filter((o) => o === 'entered').length).toBeGreaterThan(0)
      expect(mostInside).toBe(1)
      expect(await lockExists()).toBe(false)
      expect(await leftovers()).toEqual([])
    }
  })

  it('never removes a lock a later run has taken over', async () => {
    // Run A's lock goes stale from B's point of view (B is told A's pid is
    // dead), B takes over, then A finishes: A must leave B's lock alone.
    let releaseA: () => void
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const runA = withBookLock(bookDir, () => aMayFinish, { command: 'ocr' })
    while (!(await lockExists())) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const runB = withBookLock(
      bookDir,
      async () => {
        const bOwner = await readOwner()
        releaseA!()
        await runA
        // A has finished and released; B's lock must still be here.
        expect(await readOwner()).toMatchObject({ token: bOwner.token })
      },
      { isAlive: () => false, command: 'export' }
    )

    await runB
    expect(await lockExists()).toBe(false)
  })

  it('creates the book directory if it does not exist yet', async () => {
    const fresh = path.join(bookDir, 'B00NEW')

    await withBookLock(fresh, async () => {
      await fs.access(fresh)
    })
  })

  it('keeps two real processes from both entering on one stale lock', async () => {
    // The delayed-verdict schedule across process boundaries: worker B reads
    // the stale owner and pauses; worker A is then started and left to do
    // whatever it can; B is released. Each worker records when it was inside.
    await plantLock(4242)
    const script = path.join(bookDir, 'contender.mts')
    await fs.writeFile(
      script,
      `
      import fs from 'node:fs/promises'
      import { isBookBusyError, withBookLock } from ${JSON.stringify(
        path.resolve('src/book-lock.ts')
      )}

      const [bookDir, out, inspecting, resume] = process.argv.slice(2)
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const exists = (p) => fs.access(p).then(() => true, () => false)

      try {
        await withBookLock(
          bookDir,
          async () => {
            const enteredAt = Date.now()
            await sleep(300)
            await fs.writeFile(out, JSON.stringify({ entered: [enteredAt, Date.now()] }))
          },
          {
            isAlive: () => true,
            commandLine: async (pid) => {
              if (pid !== 4242) return 'node contender'
              if (inspecting) {
                await fs.writeFile(inspecting, '')
                while (!(await exists(resume))) await sleep(10)
              }
              return '/usr/bin/vim'
            }
          }
        )
      } catch (err) {
        await fs.writeFile(out, JSON.stringify({ busy: isBookBusyError(err), error: String(err) }))
      }
      `
    )

    const outA = path.join(bookDir, 'result-a')
    const outB = path.join(bookDir, 'result-b')
    const inspecting = path.join(bookDir, 'b-inspecting')
    const resume = path.join(bookDir, 'b-resume')
    const spawnWorker = (args: string[]) =>
      execFileAsync(process.execPath, ['--import', 'tsx', script, ...args])
    const exists = (p: string) =>
      fs.access(p).then(
        () => true,
        () => false
      )

    const workerB = spawnWorker([bookDir, outB, inspecting, resume])
    while (!(await exists(inspecting))) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const workerA = spawnWorker([bookDir, outA])
    // A is inside once its own owner file is the lock.
    while (!(await exists(outA)) && !(await lockHeldByOtherPid())) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await fs.writeFile(resume, '')
    await Promise.all([workerA, workerB])

    interface WorkerReport {
      entered?: [number, number]
      busy?: boolean
    }
    const [a, b] = (await Promise.all(
      [outA, outB].map(
        async (out) => JSON.parse(await fs.readFile(out, 'utf8')) as unknown
      )
    )) as [WorkerReport, WorkerReport]

    expect(a.entered).toBeDefined()
    expect(b.busy).toBe(true)
    expect(await lockExists()).toBe(false)

    async function lockHeldByOtherPid(): Promise<boolean> {
      try {
        const [name] = await fs.readdir(bookLockPath(bookDir))
        return name !== undefined && !name.includes('-4242-')
      } catch {
        return false
      }
    }
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
