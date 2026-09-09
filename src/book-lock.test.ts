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
  takeoverPath,
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

  it("does not let a paused contender rename away a fresh owner's lock", async () => {
    // The sequence that beat the previous version: A and B both look at the
    // same stale owner; B pauses inside its liveness check; A takes over and
    // enters; B resumes with its stale verdict and renames A's fresh lock
    // aside. Inspection now happens under the takeover directory, so B still
    // holds that directory while paused and A cannot have acted in between —
    // A instead waits its turn and finds B's live lock.
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

    const runB = withBookLock(bookDir, enter, probes(true)).catch(
      (err: unknown) => (isBookBusyError(err) ? 'busy' : err)
    )
    await bStartedInspecting
    const runA = withBookLock(bookDir, enter, probes(false)).catch(
      (err: unknown) => (isBookBusyError(err) ? 'busy' : err)
    )
    // Give A every chance to act while B is paused.
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseB!()

    const [a, b] = await Promise.all([runA, runB])
    expect(b).toBe('entered')
    expect(a).toBe('busy')
    expect(mostInside).toBe(1)
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
    expect(await leftovers()).toEqual([])
  })

  it('serialises many contenders over one stale lock', async () => {
    await plantLock(4242)

    let inside = 0
    let mostInside = 0
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        takeOverStale(async () => {
          mostInside = Math.max(mostInside, ++inside)
          await new Promise((resolve) => setTimeout(resolve, 20))
          inside--
          return 'entered'
        }).catch((err: unknown) => (isBookBusyError(err) ? 'busy' : err))
      )
    )

    // Whether a given contender enters (after the previous one released) or
    // is told the book is busy depends on timing; what may never happen is
    // two of them inside at once.
    expect(outcomes.every((o) => o === 'entered' || o === 'busy')).toBe(true)
    expect(outcomes.filter((o) => o === 'entered').length).toBeGreaterThan(0)
    expect(mostInside).toBe(1)
    await expect(fs.access(bookLockPath(bookDir))).rejects.toThrow()
    expect(await leftovers()).toEqual([])
  })

  it('clears a takeover directory left by a holder that died', async () => {
    await fs.mkdir(takeoverPath(bookDir))
    await fs.writeFile(path.join(takeoverPath(bookDir), 'pid'), '4242')
    await plantLock(4242)

    // The lock is stale, so the only thing standing in the way is the dead
    // holder's takeover directory.
    const result = await withBookLock(bookDir, async () => 'ran', {
      isAlive: () => false
    })

    expect(result).toBe('ran')
    expect(await leftovers()).toEqual([])
  })

  it('reports busy rather than inspecting alongside a live, slow holder', async () => {
    await fs.mkdir(takeoverPath(bookDir))
    await fs.writeFile(
      path.join(takeoverPath(bookDir), 'pid'),
      `${process.pid}`
    )
    await plantLock(4242)

    await expect(
      withBookLock(bookDir, async () => 'ran', { isAlive: () => true })
    ).rejects.toSatisfy(isBookBusyError)
  }, 10_000)

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

  it('keeps two real processes from both entering on one stale lock', async () => {
    // The staggered schedule across process boundaries: worker B reads the
    // stale owner and pauses; worker A is then started and left to do
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

    const workerB = spawnWorker([bookDir, outB, inspecting, resume])
    while (
      !(await fs.access(inspecting).then(
        () => true,
        () => false
      ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const workerA = spawnWorker([bookDir, outA])
    // A has had this long to act on the lock B is inspecting.
    await new Promise((resolve) => setTimeout(resolve, 1500))
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
    // B held the takeover right throughout its pause, so B enters and A can
    // only have found B's lock live — or, if A polled after B finished, run
    // afterwards. Either way the two were never inside together.
    expect(b.entered).toBeDefined()
    if (a.entered) {
      const [aStart, aEnd] = a.entered
      const [bStart, bEnd] = b.entered!
      expect(aStart >= bEnd || bStart >= aEnd).toBe(true)
    } else {
      expect(a.busy).toBe(true)
    }
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
