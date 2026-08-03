import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cleanPageImages, cleanRenderData, formatBytes } from './cleanup'

const ASIN = 'B000TEST01'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-clean-'))

  const book = path.join(root, ASIN)
  await fs.mkdir(path.join(book, 'data', 'render', 'abc'), { recursive: true })
  await fs.mkdir(path.join(book, 'pages'), { recursive: true })
  await fs.writeFile(
    path.join(book, 'data', 'render', 'abc', 'glyphs.json'),
    'x'.repeat(2048)
  )
  await fs.writeFile(path.join(book, 'pages', '0.png'), 'y'.repeat(4096))
  await fs.writeFile(path.join(book, 'content.json'), '[]')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('cleanRenderData', () => {
  it('removes the render directory and reports what it freed', async () => {
    const result = await cleanRenderData(root, ASIN)

    expect(result.freed).toBe(2048)
    expect(result.removed).toEqual([path.join(root, ASIN, 'data')])
    await expect(fs.access(path.join(root, ASIN, 'data'))).rejects.toBeDefined()
  })

  it('leaves the transcribed text and page images alone', async () => {
    await cleanRenderData(root, ASIN)

    await expect(
      fs.access(path.join(root, ASIN, 'content.json'))
    ).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(root, ASIN, 'pages'))
    ).resolves.toBeUndefined()
  })

  it('is a no-op when there is nothing to remove', async () => {
    await cleanRenderData(root, ASIN)
    const again = await cleanRenderData(root, ASIN)

    expect(again).toEqual({ freed: 0, removed: [] })
  })
})

describe('cleanPageImages', () => {
  it('removes the page images but keeps the text', async () => {
    const result = await cleanPageImages(root, ASIN)

    expect(result.freed).toBe(4096)
    await expect(
      fs.access(path.join(root, ASIN, 'pages'))
    ).rejects.toBeDefined()
    await expect(
      fs.access(path.join(root, ASIN, 'content.json'))
    ).resolves.toBeUndefined()
  })
})

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatBytes(45 * 1024 * 1024)).toBe('45 MB')
  })
})
