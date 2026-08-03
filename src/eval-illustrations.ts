import { execSync } from 'node:child_process'
import path from 'node:path'

import type { IllustrationChunk } from './types'
import { readJsonFile } from './utils'

async function main() {
  const datasetPath = path.resolve('eval-dataset.json')
  const dataset =
    await readJsonFile<
      Record<
        string,
        { illustrations: Record<string, number>; text_only: number[] }
      >
    >(datasetPath)

  let totalPrecision = 0
  let totalRecall = 0
  let totalF1 = 0
  let evaluatedCount = 0

  for (const [asin, data] of Object.entries(dataset)) {
    console.log(`Evaluating ASIN: ${asin}`)

    // Build page indices to run
    const illustrationPages = Object.keys(data.illustrations).map(Number)
    const textOnlyPages = data.text_only
    const allPages = [...illustrationPages, ...textOnlyPages]

    console.log(`Running extraction on ${allPages.length} pages...`)

    // Build and run command
    const pageIndicesStr = allPages.join(',')
    const cmd = `pnpm tsx src/extract-illustrations.ts --asin ${asin} --page-indices "${pageIndicesStr}" --overwrite`

    try {
      execSync(cmd, { stdio: 'inherit' })
    } catch (err) {
      console.error(`Error running extraction for ${asin}:`, err)
    }

    // Read outputs
    const outDir = path.resolve('out', asin)
    const illustrationsPath = path.join(outDir, 'illustrations.json')

    let extracted: IllustrationChunk[] = []
    try {
      extracted = await readJsonFile<IllustrationChunk[]>(illustrationsPath)
    } catch {
      console.warn(`No illustrations.json found for ${asin}`)
    }

    // Evaluate
    let truePositives = 0
    let falsePositives = 0
    let falseNegatives = 0
    let trueNegatives = 0

    const extractedPageMap = new Map<number, IllustrationChunk[]>()
    for (const ex of extracted) {
      if (!extractedPageMap.has(ex.index)) {
        extractedPageMap.set(ex.index, [])
      }
      extractedPageMap.get(ex.index)!.push(ex)
    }

    for (const page of allPages) {
      const isExpected = data.illustrations[page] === 1
      const isExtracted =
        extractedPageMap.has(page) && extractedPageMap.get(page)!.length > 0

      if (isExpected && isExtracted) {
        truePositives++
      } else if (!isExpected && !isExtracted) {
        trueNegatives++
      } else if (isExpected && !isExtracted) {
        falseNegatives++
        console.log(`[FN] Missed illustration on page ${page}`)
      } else if (!isExpected && isExtracted) {
        falsePositives++
        console.log(`[FP] Incorrectly extracted illustration on page ${page}`)
      }
    }

    const precision = truePositives / (truePositives + falsePositives || 1)
    const recall = truePositives / (truePositives + falseNegatives || 1)
    const f1 = (2 * (precision * recall)) / (precision + recall || 1)

    console.log(`\nResults for ${asin}:`)
    console.log(
      `TP: ${truePositives}, FP: ${falsePositives}, TN: ${trueNegatives}, FN: ${falseNegatives}`
    )
    console.log(`Precision: ${(precision * 100).toFixed(2)}%`)
    console.log(`Recall: ${(recall * 100).toFixed(2)}%`)
    console.log(`F1 Score: ${(f1 * 100).toFixed(2)}%\n`)

    totalPrecision += precision
    totalRecall += recall
    totalF1 += f1
    evaluatedCount++
  }

  if (evaluatedCount > 0) {
    console.log(`=== Overall Metrics ===`)
    console.log(
      `Average Precision: ${((totalPrecision / evaluatedCount) * 100).toFixed(2)}%`
    )
    console.log(
      `Average Recall: ${((totalRecall / evaluatedCount) * 100).toFixed(2)}%`
    )
    console.log(
      `Average F1 Score: ${((totalF1 / evaluatedCount) * 100).toFixed(2)}%`
    )
  }
}

await main()
