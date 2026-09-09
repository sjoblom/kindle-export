import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserConfig } from './config'

// The server reads and writes the stored config; the real one lives in the
// home directory of whoever runs the tests.
let stored: UserConfig = {}
vi.mock('./config', () => ({
  loadConfig: async () => stored,
  saveConfig: async (config: UserConfig) => {
    stored = config
    return '/dev/null'
  }
}))

const { createServeHandle } = await import('./serve')
const { EMPTY_OPTIONS } = await import('./pipeline')
const { isVisionOcrAvailable } = await import('./vision-ocr')

/** Whether this machine can read pages itself; decides which gate applies. */
const localOcr = await isVisionOcrAvailable()

type Handle = Awaited<ReturnType<typeof createServeHandle>>

let outDir: string
let handle: Handle
let port: number

beforeEach(async () => {
  stored = {}
  vi.stubEnv('OPENAI_API_KEY', '')

  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-serve-'))
  const bookDir = path.join(outDir, 'B00TEST')
  await fs.mkdir(bookDir, { recursive: true })
  await fs.writeFile(path.join(bookDir, 'the-book.md'), 'hello book')
  await fs.writeFile(path.join(bookDir, 'notes.txt'), 'not downloadable')
  // A file outside the book folder that a traversal would reach.
  await fs.writeFile(path.join(outDir, 'secret.md'), 'should stay put')

  handle = await createServeHandle({
    ...EMPTY_OPTIONS,
    command: 'serve',
    outDir,
    profileDir: path.join(outDir, '.profile'),
    port: 0
  })
  port = Number(new URL(handle.url).port)
})

afterEach(async () => {
  await handle.close()
  await fs.rm(outDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function post(
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>
) {
  return fetch(handle.url + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kindle-export': '1',
      ...headers
    },
    body: JSON.stringify(body ?? {})
  })
}

/** A request with full header control, for what fetch won't let us send. */
function rawGet(
  pathname: string,
  headers: Record<string, string>
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, headers },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('serve', () => {
  it('serves the app page', async () => {
    const res = await fetch(handle.url + '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Kindle Export')
  })

  it('reports state, including books found on disk', async () => {
    const res = await fetch(handle.url + '/api/state')
    expect(res.status).toBe(200)

    const state = (await res.json()) as any
    expect(state.hasApiKey).toBe(false)
    expect(state.amazon).toBe('unknown')
    expect(state.diskBooks).toHaveLength(1)
    expect(state.diskBooks[0]).toMatchObject({ asin: 'B00TEST' })
    expect(state.diskBooks[0].exports.map((f: any) => f.name)).toEqual([
      'the-book.md'
    ])
  })

  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    const { status } = await rawGet('/api/state', { host: 'evil.example' })
    expect(status).toBe(403)
  })

  it('rejects writes without the app header (cross-site requests)', async () => {
    const res = await fetch(handle.url + '/api/library', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('reports whether pages can be read on this machine', async () => {
    const state = (await (await fetch(handle.url + '/api/state')).json()) as any
    // Drives the whole Settings step: with local OCR there is nothing to fill
    // in, so it must reflect reality rather than a guess about the platform.
    expect(state.localOcr).toBe(localOcr)
  })

  it('refuses to export without an API key when a model is named', async () => {
    // Naming a model means OpenAI reads the pages, so a key is required even
    // where local OCR would otherwise have covered it.
    expect((await post('/api/config', { model: 'gpt-test' })).status).toBe(200)

    const res = await post('/api/export', { asins: ['B00TEST'] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/API key/)
  })

  it.skipIf(localOcr)(
    'refuses to export without an API key when there is no local OCR',
    async () => {
      const res = await post('/api/export', { asins: ['B00TEST'] })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/API key/)
    }
  )

  it('validates the export request before touching a browser', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')

    for (const asins of [[], ['b00!bad'], ['../escape'], 'B00TEST']) {
      const res = await post('/api/export', { asins })
      expect(res.status).toBe(400)
    }
  })

  it('saves settings and makes the key usable without a restart', async () => {
    const res = await post('/api/config', {
      apiKey: 'sk-new',
      model: 'gpt-test'
    })
    expect(res.status).toBe(200)

    expect(stored).toMatchObject({ openaiApiKey: 'sk-new', model: 'gpt-test' })
    const state = (await (await fetch(handle.url + '/api/state')).json()) as any
    expect(state.hasApiKey).toBe(true)
    expect(state.model).toBe('gpt-test')
  })

  it('keeps a stored key when settings are saved without one', async () => {
    stored = { openaiApiKey: 'sk-old', model: 'gpt-old' }

    const res = await post('/api/config', { model: 'gpt-new' })
    expect(res.status).toBe(200)
    expect(stored).toMatchObject({ openaiApiKey: 'sk-old', model: 'gpt-new' })
  })

  it('downloads an exported file', async () => {
    const res = await fetch(handle.url + '/api/download/B00TEST/the-book.md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(await res.text()).toBe('hello book')
  })

  it('downloads a file whose name is not Latin-1', async () => {
    // Someone renames an export by hand and it still has to come down. The raw
    // name in a header is what Node refuses outright, so the plain `filename`
    // has to be an ASCII stand-in with the real name only in `filename*`.
    const name = '日本語.md'
    await fs.writeFile(path.join(outDir, 'B00TEST', name), 'hello book')

    const res = await fetch(
      handle.url + '/api/download/B00TEST/' + encodeURIComponent(name)
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello book')

    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toBe(
      `attachment; filename="book.md"; filename*=UTF-8''${encodeURIComponent(name)}`
    )
    // Latin-1 only, or Node would never have written it in the first place.
    expect(disposition).toMatch(/^[\u0020-\u007E]+$/)
  })

  it('refuses download paths that leave the book folder', async () => {
    const traversal = await fetch(
      handle.url + '/api/download/B00TEST/..%2Fsecret.md'
    )
    expect(traversal.status).toBe(400)

    const wrongType = await fetch(
      handle.url + '/api/download/B00TEST/notes.txt'
    )
    expect(wrongType.status).toBe(400)

    const badAsin = await fetch(handle.url + '/api/download/b00%2F../x.md')
    expect(badAsin.status).toBe(400)

    const absent = await fetch(handle.url + '/api/download/B00TEST/absent.md')
    expect(absent.status).toBe(404)
  })

  it('stays quiet about unknown routes', async () => {
    const res = await fetch(handle.url + '/api/nope')
    expect(res.status).toBe(404)
  })
})
