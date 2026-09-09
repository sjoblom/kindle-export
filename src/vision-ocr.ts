import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { OcrEngine, OcrRequest } from './ocr-engine'
import { parseOcrLines, reconstructParagraphs } from './ocr-layout'

/**
 * Local OCR on macOS via Apple's Vision framework, so the normal path needs no
 * API key, no network and no per-page cost.
 *
 * The binary is a long-lived worker rather than one process per page: startup
 * dominates a single page's cost, so spawning per page would add roughly a
 * second each to a book of hundreds.
 *
 * Vision recognises one rendered line at a time, so the worker answers with a
 * box per line and the paragraphs are rebuilt here — the formatter downstream
 * reads every newline as a paragraph break, and one line per newline would make
 * every wrapped line its own paragraph.
 */

/** Bumped alongside the binary's own `protocol` field when the wire format changes. */
const SUPPORTED_PROTOCOL = 2
const HANDSHAKE_TIMEOUT_MS = 10_000

interface PendingRequest {
  resolve: (text: string) => void
  reject: (err: Error) => void
}

/**
 * `bin/` sits beside both `src/` and `dist/`, so this resolves the same whether
 * the caller is running from source via tsx or from the built output.
 */
export function visionOcrBinaryPath(): string {
  return path.resolve(
    fileURLToPath(import.meta.url),
    '../../bin/kindle-ocr-macos'
  )
}

/**
 * Whether local OCR can be used here. False on non-macOS, and on Macs where the
 * binary was never built because the Xcode command line tools were missing.
 */
export async function isVisionOcrAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false

  try {
    await fs.access(visionOcrBinaryPath(), fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The page's text as paragraphs. `text` is the older protocol's shape and is
 * only here so a stale binary degrades to over-split prose rather than to
 * nothing at all.
 */
function pageText(message: any): string {
  const lines = parseOcrLines(message?.lines)
  if (lines.length) return reconstructParagraphs(lines)

  return typeof message?.text === 'string' ? message.text : ''
}

export function createVisionOcrEngine(
  opts: { languages?: string[] } = {}
): OcrEngine {
  let child: ChildProcessWithoutNullStreams | undefined
  let starting: Promise<ChildProcessWithoutNullStreams> | undefined
  let closed = false
  let nextId = 1
  const pending = new Map<number, PendingRequest>()

  function failAllPending(err: Error): void {
    for (const request of pending.values()) {
      request.reject(err)
    }
    pending.clear()
  }

  function handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let message: any
    try {
      message = JSON.parse(trimmed)
    } catch {
      // Anything the worker prints that isn't a response is diagnostic noise.
      return
    }

    if (message?.ready) return

    const request = pending.get(message?.id)
    // No entry means the page already timed out and was retried; its late
    // answer is stale, so drop it rather than resolving a settled promise.
    if (!request) return

    pending.delete(message.id)
    if (message.ok) {
      request.resolve(pageText(message))
    } else {
      request.reject(new Error(message?.error ?? 'Vision OCR failed'))
    }
  }

  async function start(): Promise<ChildProcessWithoutNullStreams> {
    const binary = visionOcrBinaryPath()
    const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })

    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        handleLine(line)
        newline = buffer.indexOf('\n')
      }
    })

    // The worker writes nothing to stderr in normal operation; keeping it out of
    // the user's terminal matters because a page can legitimately fail.
    proc.stderr.resume()

    proc.on('exit', (code, signal) => {
      child = undefined
      starting = undefined
      if (closed) return
      failAllPending(
        new Error(
          `Vision OCR worker exited unexpectedly (code ${code}, signal ${signal})`
        )
      )
    })

    proc.on('error', (err) => {
      child = undefined
      starting = undefined
      failAllPending(err)
    })

    // Wait for the handshake so a binary the OS refuses to run (unsigned,
    // quarantined, wrong architecture) fails here with a clear message rather
    // than hanging the first page.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        proc.kill()
        reject(
          new Error(
            `Vision OCR worker did not start within ${HANDSHAKE_TIMEOUT_MS}ms (${binary})`
          )
        )
      }, HANDSHAKE_TIMEOUT_MS)

      function cleanup(): void {
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        proc.off('exit', onExit)
        proc.off('error', onError)
      }

      let seen = ''
      function onData(chunk: string): void {
        seen += chunk
        const newline = seen.indexOf('\n')
        if (newline === -1) return

        try {
          const message: any = JSON.parse(seen.slice(0, newline).trim())
          if (!message?.ready) throw new Error('missing ready flag')
          if (message.protocol !== SUPPORTED_PROTOCOL) {
            throw new Error(
              `unsupported protocol ${message.protocol}, expected ${SUPPORTED_PROTOCOL} — rebuild with 'pnpm build'`
            )
          }
          cleanup()
          resolve()
        } catch (err) {
          cleanup()
          proc.kill()
          reject(
            new Error(
              `Vision OCR worker sent a bad handshake: ${(err as Error).message}`
            )
          )
        }
      }

      function onExit(code: number | null): void {
        cleanup()
        reject(
          new Error(
            `Vision OCR worker exited during startup (code ${code}). ` +
              `Rebuild it with 'pnpm build'.`
          )
        )
      }

      function onError(err: Error): void {
        cleanup()
        reject(new Error(`Could not run the Vision OCR worker: ${err.message}`))
      }

      proc.stdout.on('data', onData)
      proc.once('exit', onExit)
      proc.once('error', onError)
    })

    child = proc
    return proc
  }

  async function ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (child) return child
    // Concurrent pages must not each spawn a worker.
    starting ??= start().finally(() => {
      starting = undefined
    })
    return starting
  }

  return {
    name: 'Apple Vision',
    costsMoney: false,

    async recognize({ imagePath, signal }: OcrRequest): Promise<string> {
      if (closed) throw new Error('Vision OCR engine is closed')

      const proc = await ensureStarted()
      const id = nextId++

      return new Promise<string>((resolve, reject) => {
        function onAbort(): void {
          pending.delete(id)
          reject(new Error('Vision OCR timed out'))
        }

        pending.set(id, {
          resolve: (text) => {
            signal.removeEventListener('abort', onAbort)
            resolve(text)
          },
          reject: (err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          }
        })

        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })

        const request = {
          id,
          path: path.resolve(imagePath),
          ...(opts.languages?.length ? { languages: opts.languages } : {})
        }
        proc.stdin.write(`${JSON.stringify(request)}\n`, (err) => {
          if (!err) return
          pending.delete(id)
          signal.removeEventListener('abort', onAbort)
          reject(err)
        })
      })
    },

    async close(): Promise<void> {
      closed = true
      const proc = child
      child = undefined
      if (!proc) return

      failAllPending(new Error('Vision OCR engine closed'))
      // Closing stdin lets the worker finish in-flight pages and exit cleanly.
      proc.stdin.end()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill()
          resolve()
        }, 2000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
}
