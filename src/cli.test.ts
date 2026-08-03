import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserConfig } from './config'

// Reading the real ~/.kindle-export/config.json would make these tests depend
// on the machine they run on, and applyConfig copies a stored key into the
// environment.
let stored: UserConfig = {}
vi.mock('./config', () => ({
  loadConfig: async () => stored,
  saveConfig: async () => '/dev/null'
}))

const { applyConfig, parseArgs } = await import('./cli')

const EMPTY: Parameters<typeof applyConfig>[0] = {
  command: 'all',
  asins: [],
  outDir: '',
  profileDir: '',
  json: false,
  formats: ['md'],
  keepPages: false,
  forceCapture: false,
  forceOcr: false,
  forceExport: false
}

beforeEach(() => {
  stored = {}
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('parseArgs', () => {
  it('treats a bare ASIN as the full pipeline', () => {
    const options = parseArgs(['B01H4G2J1U'])

    expect(options).toMatchObject({ command: 'all', asins: ['B01H4G2J1U'] })
  })

  it('recognises a leading command keyword', () => {
    expect(parseArgs(['capture', 'B01H4G2J1U'])).toMatchObject({
      command: 'capture',
      asins: ['B01H4G2J1U']
    })
  })

  it('normalises ASIN case and surrounding space', () => {
    expect(parseArgs([' b01h4g2j1u '])?.asins).toEqual(['B01H4G2J1U'])
  })

  it('rejects an ASIN that could escape the output directory', () => {
    // `clean ..` would otherwise resolve outside the book folder and delete a
    // directory that has nothing to do with the export.
    expect(() => parseArgs(['clean', '..'])).toThrow(/invalid ASIN/)
    expect(() => parseArgs(['clean', 'a/b'])).toThrow(/invalid ASIN/)
  })

  it('rejects an unknown option rather than reading it as an ASIN', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/)
  })

  it('rejects an unknown format', () => {
    expect(() => parseArgs(['--format', 'epub'])).toThrow(/unknown format/)
    expect(parseArgs(['--format', 'md,pdf'])?.formats).toEqual(['md', 'pdf'])
  })

  it('returns nothing for --help and --version', () => {
    expect(parseArgs(['--help'])).toBeUndefined()
    expect(parseArgs(['--version'])).toBeUndefined()
  })

  it('makes --force imply every stage', () => {
    expect(parseArgs(['--force', 'B01H4G2J1U'])).toMatchObject({
      forceCapture: true,
      forceOcr: true,
      forceExport: true
    })
  })

  it('leaves paths unset so applyConfig can resolve them', () => {
    // The contract between the two: parseArgs reports only what was actually
    // typed, and every fallback lives in applyConfig.
    const options = parseArgs(['B01H4G2J1U'])

    expect(options!.outDir).toBeUndefined()
    expect(options!.profileDir).toBeUndefined()
  })
})

describe('applyConfig', () => {
  it('fills in a blank profile directory', async () => {
    // Regression: `setup` builds its options by hand with empty strings, and
    // `??` only replaces null/undefined — so the blank survived every fallback
    // and reached mkdir(''), crashing the sign-in it had just offered.
    const options = await applyConfig({ ...EMPTY, command: 'login' })

    expect(options.profileDir).toBe(
      path.join(os.homedir(), '.kindle-export', 'profile')
    )
    expect(options.outDir).toBe('out')
  })

  it('prefers the environment over stored config', async () => {
    stored = { outDir: 'from-config' }
    vi.stubEnv('KINDLE_OUT_DIR', 'from-env')

    expect((await applyConfig({ ...EMPTY })).outDir).toBe('from-env')
  })

  it('falls back to stored config when the environment is silent', async () => {
    stored = { outDir: 'from-config' }

    expect((await applyConfig({ ...EMPTY })).outDir).toBe('from-config')
  })

  it('keeps a path that was given explicitly', async () => {
    stored = { outDir: 'from-config' }
    vi.stubEnv('KINDLE_OUT_DIR', 'from-env')

    const options = await applyConfig({
      ...EMPTY,
      outDir: 'from-flag',
      profileDir: '/tmp/profile'
    })

    expect(options.outDir).toBe('from-flag')
    expect(options.profileDir).toBe('/tmp/profile')
  })
})
