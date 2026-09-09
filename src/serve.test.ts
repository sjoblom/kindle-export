import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserConfig } from './config'
import type * as Pipeline from './pipeline'

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

/**
 * Jobs are driven through a stand-in pipeline: the real one opens Chrome and
 * reads a book for an hour. Everything around it — validation, the single-job
 * rule, the options the job is started with — is the server's own code.
 */
const pipelineCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const gate = vi.hoisted(() => ({
  hold: false,
  release: undefined as (() => void) | undefined
}))

vi.mock('./pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof Pipeline>()

  return {
    ...actual,
    processBook: async (asin: string, options: any) => {
      pipelineCalls.push({
        asin,
        command: options.command,
        forceCapture: options.forceCapture,
        formats: options.formats
      })

      if (gate.hold) {
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
      }

      return {
        asin,
        outputs: [],
        completeness: {
          complete: true,
          capturedPages: 1,
          transcribedPages: 1,
          missingPages: [],
          captureStoppedEarly: false,
          warnings: []
        },
        failedPages: [],
        durationMs: 1
      }
    }
  }
})

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
  pipelineCalls.length = 0
  gate.hold = false
  gate.release = undefined
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
  gate.release?.()
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

/** Wait for something the job runs towards, rather than for a fixed delay. */
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function getState(): Promise<any> {
  return (await fetch(handle.url + '/api/state')).json()
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

  it('captures a book again when the page asks it to', async () => {
    // The only way out of a capture that stopped part-way: without this the
    // same truncated book is rebuilt from the same pages every time.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')

    const res = await post('/api/export', {
      asins: ['B00TEST'],
      formats: ['md'],
      forceCapture: true
    })
    expect(res.status).toBe(202)

    await until(() => pipelineCalls.length === 1, 'the book to be processed')
    expect(pipelineCalls[0]).toMatchObject({
      asin: 'B00TEST',
      command: 'all',
      forceCapture: true
    })

    // The page needs to know a run is a re-capture, not an ordinary export.
    expect((await getState()).job.forceCapture).toBe(true)
  })

  it('resumes rather than re-captures for an ordinary export', async () => {
    // Retrying unreadable pages must not throw away an hour of capture; the
    // pipeline resumes page by page when it is left alone.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')

    expect((await post('/api/export', { asins: ['B00TEST'] })).status).toBe(202)

    await until(() => pipelineCalls.length === 1, 'the book to be processed')
    expect(pipelineCalls[0]).toMatchObject({ forceCapture: false })
  })

  it('re-captures one book at a time', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')

    const res = await post('/api/export', {
      asins: ['B00TEST', 'B00OTHER'],
      forceCapture: true
    })
    expect(res.status).toBe(400)
    expect(pipelineCalls).toHaveLength(0)
  })

  it('refuses a second run while one is going', async () => {
    // One browser, one profile: the busy rule has to hold for a re-capture
    // started from the downloads list too.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    gate.hold = true

    expect((await post('/api/export', { asins: ['B00TEST'] })).status).toBe(202)
    await until(() => pipelineCalls.length === 1, 'the first job to start')

    const second = await post('/api/export', {
      asins: ['B00TEST'],
      forceCapture: true
    })
    expect(second.status).toBe(409)
    expect(pipelineCalls).toHaveLength(1)

    gate.release?.()
    await until(
      async () => (await getState()).busy === null,
      'the first job to finish'
    )
  })

  it('stays quiet about unknown routes', async () => {
    const res = await fetch(handle.url + '/api/nope')
    expect(res.status).toBe(404)
  })
})
