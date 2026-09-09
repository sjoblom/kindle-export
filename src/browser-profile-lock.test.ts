import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  commandLineOwnsProfile,
  inspectProfileLock,
  isProfileBusyError,
  parseLockPid,
  ProfileBusyError
} from './browser-profile-lock'

const PROFILE_DIR = 'out/.browser-profile'
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ' +
  `--user-data-dir=${path.resolve(PROFILE_DIR)} --hide-crash-restore-bubble`

/** Chrome's SingletonLock target: `<host>-<pid>`. */
function lockTarget(pid: number): string {
  return `Emils-MacBook-Pro.local-${pid}`
}

function inspect(
  opts: {
    linkTarget?: string
    alive?: boolean
    commandLine?: string | undefined
    commandLineThrows?: boolean
  } = {}
) {
  return inspectProfileLock({
    profileDir: PROFILE_DIR,
    // 'linkTarget' in opts, rather than ??, so a test can ask for no lock.
    linkTarget: 'linkTarget' in opts ? opts.linkTarget : lockTarget(4242),
    isAlive: () => opts.alive ?? true,
    commandLine: async () => {
      if (opts.commandLineThrows) throw new Error('ps exploded')
      return opts.commandLine
    }
  })
}

describe('parseLockPid', () => {
  it('reads the pid Chrome appends to the lock target', () => {
    expect(parseLockPid('host.local-4242')).toBe(4242)
  })

  it('returns nothing for a target with no pid in it', () => {
    expect(parseLockPid('host.local')).toBeUndefined()
    expect(parseLockPid('')).toBeUndefined()
    expect(parseLockPid('host.local-0')).toBeUndefined()
  })
})

describe('commandLineOwnsProfile', () => {
  it('matches the browser running against this profile', () => {
    expect(commandLineOwnsProfile(CHROME, PROFILE_DIR)).toBe(true)
  })

  it('matches when the profile was given as a relative path', () => {
    expect(
      commandLineOwnsProfile(
        `chrome --user-data-dir=${PROFILE_DIR}`,
        PROFILE_DIR
      )
    ).toBe(true)
  })

  it('does not match a browser on a different profile', () => {
    expect(
      commandLineOwnsProfile('chrome --user-data-dir=/tmp/other', PROFILE_DIR)
    ).toBe(false)
  })

  it('does not mistake a neighbouring profile for this one', () => {
    // Substring matching would call this ours and delete a live browser's lock.
    expect(
      commandLineOwnsProfile(
        `chrome --user-data-dir=${path.resolve(PROFILE_DIR)}-2`,
        PROFILE_DIR
      )
    ).toBe(false)
  })

  it('does not match an unrelated program that reused the pid', () => {
    expect(commandLineOwnsProfile('/usr/bin/vim notes.md', PROFILE_DIR)).toBe(
      false
    )
  })

  it('falls back to the profile path appearing anywhere', () => {
    // Some launchers pass the profile without --user-data-dir; err towards
    // "this is the owner" rather than clearing a live lock.
    expect(
      commandLineOwnsProfile(`chromium ${PROFILE_DIR} --headless`, PROFILE_DIR)
    ).toBe(true)
  })
})

describe('inspectProfileLock', () => {
  it('reports an unlocked profile when there is no lock', async () => {
    await expect(inspect({ linkTarget: undefined })).resolves.toEqual({
      state: 'unlocked'
    })
  })

  it('treats a lock naming no pid as stale', async () => {
    const lock = await inspect({ linkTarget: 'host.local' })
    expect(lock.state).toBe('stale')
  })

  it('treats a lock whose process is gone as stale', async () => {
    const lock = await inspect({ alive: false, commandLine: undefined })
    expect(lock).toMatchObject({ state: 'stale', pid: 4242 })
  })

  it('reports a live browser on this profile as busy', async () => {
    // The bug this fixes: `kindle-export list` used to kill this process,
    // taking the web app's in-progress capture with it.
    await expect(inspect({ commandLine: CHROME })).resolves.toEqual({
      state: 'busy',
      pid: 4242
    })
  })

  it('treats a live pid belonging to something else as a stale lock', async () => {
    // Pids get recycled. The old code sent SIGKILL to whatever this is.
    const lock = await inspect({ commandLine: '/usr/bin/vim notes.md' })
    expect(lock).toMatchObject({ state: 'stale', pid: 4242 })
  })

  it('assumes a live owner when the command line cannot be read', async () => {
    // Windows, a restricted `ps`, a process we can't see into: refusing to
    // launch is recoverable, stealing the profile is not.
    await expect(inspect({ commandLine: undefined })).resolves.toEqual({
      state: 'busy',
      pid: 4242
    })

    await expect(inspect({ commandLineThrows: true })).resolves.toEqual({
      state: 'busy',
      pid: 4242
    })
  })
})

describe('ProfileBusyError', () => {
  it('says which process holds the profile and what to do', () => {
    const err = new ProfileBusyError(4242, PROFILE_DIR)

    expect(err.message).toContain('pid 4242')
    expect(err.message).toMatch(/wait for it to finish|close that browser/)
    expect(err.profileDir).toBe(PROFILE_DIR)
  })

  it('is recognisable by class and by code', () => {
    expect(isProfileBusyError(new ProfileBusyError(1, PROFILE_DIR))).toBe(true)
    // A copy that crossed a bundle boundary keeps the marker if not the class.
    expect(isProfileBusyError({ code: 'PROFILE_BUSY' })).toBe(true)
    expect(isProfileBusyError(new Error('nope'))).toBe(false)
    expect(isProfileBusyError(undefined)).toBe(false)
  })
})
