import 'dotenv/config'

import { extractBook, launchBrowserContext } from './extract-kindle-book'
import { assert, getEnv } from './utils'

const asins = process.argv
  .slice(2)
  .map((asin) => asin.trim().toUpperCase())
  .filter(Boolean)

if (!asins.length) {
  throw new Error(
    'No ASINs provided. Usage: npx tsx src/extract-multiple-kindle-books.ts <ASIN...>'
  )
}

type ExtractionResult = {
  asin: string
  success: boolean
  durationMs: number
  error?: string
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

async function main() {
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')

  console.log(`Launching shared browser for ${asins.length} book(s)...`)
  const context = await launchBrowserContext()

  // Close the default blank page that comes with the persistent context
  for (const p of context.pages()) {
    await p.close()
  }

  const results: ExtractionResult[] = []
  const startedAt = Date.now()

  try {
    for (const asin of asins) {
      const bookStartedAt = Date.now()
      console.log(`\n=== [${asin}] Starting extraction ===`)

      try {
        await extractBook(context, { asin, amazonEmail, amazonPassword })
        const durationMs = Date.now() - bookStartedAt
        console.log(
          `=== [${asin}] Completed successfully in ${formatDuration(durationMs)} ===`
        )
        results.push({ asin, success: true, durationMs })
      } catch (err: any) {
        const durationMs = Date.now() - bookStartedAt
        const error = err?.message ?? String(err)
        console.log(
          `=== [${asin}] Failed after ${formatDuration(durationMs)}: ${error} ===`
        )
        results.push({ asin, success: false, durationMs, error })
      }
    }
  } finally {
    await context.close()
    await context.browser()?.close()
  }

  const succeeded = results.filter((result) => result.success)
  const failed = results.filter((result) => !result.success)

  console.log('\n=== Extraction summary ===')
  console.log(`Total: ${results.length}`)
  console.log(`Succeeded: ${succeeded.length}`)
  console.log(`Failed: ${failed.length}`)
  console.log(`Elapsed: ${formatDuration(Date.now() - startedAt)}`)

  if (succeeded.length) {
    console.log('\nSuccessful ASINs:')
    for (const result of succeeded) {
      console.log(`- ${result.asin} (${formatDuration(result.durationMs)})`)
    }
  }

  if (failed.length) {
    console.log('\nFailed ASINs:')
    for (const result of failed) {
      console.log(
        `- ${result.asin} (${formatDuration(result.durationMs)}): ${result.error ?? 'unknown error'}`
      )
    }
    process.exitCode = 1
  }
}

await main()
