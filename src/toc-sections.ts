import type { ContentChunk, TocItem } from './types'
import { isHeadingLine, normalizeLabel } from './postprocess-text'

/**
 * Resolving TOC entries to the page chunks they actually cover.
 *
 * Kindle reports coarse page numbers and routinely gives several TOC entries
 * the same one. In The Mom Test, `Title Page`, `Contents`, `Introduction` and
 * `1. The Mom Test` all report page 1, so slicing purely by page collapses the
 * first three sections to nothing and files the entire front matter plus
 * chapter 1 under `1. The Mom Test`. A chapter heading also often falls a page
 * before the TOC claims the chapter starts, stranding it at the tail of the
 * previous section.
 *
 * Page numbers give the coarse window; the entry's own label, found verbatim on
 * its own line in the OCR text, pins down the exact chunk within it.
 */

export interface BookSection {
  tocItem: TocItem
  /** Index into the TOC, so callers can keep TOC-derived numbering. */
  tocIndex: number
  chunks: ContentChunk[]
  /** Label of the following section, if any. */
  nextLabel?: string
}

/** `1. The Mom Test` also matches a page heading that reads `THE MOM TEST`. */
function labelKeys(label: string): string[] {
  const key = normalizeLabel(label)
  if (!key) return []

  const unnumbered = key.replace(/^\d+\s+/, '')
  return unnumbered && unnumbered !== key ? [key, unnumbered] : [key]
}

/** A long chapter title wraps onto a second or third heading line. */
const MAX_HEADING_LINES_PER_LABEL = 3

/**
 * Normalized forms of every heading a chunk contains: each line on its own, and
 * each run of consecutive heading lines joined back together. Joining is what
 * lets a title that wrapped across two lines match its single-line TOC label;
 * requiring the joined lines to be headings keeps prose from being glued up.
 */
function chunkHeadingKeys(chunk: ContentChunk): Set<string> {
  const lines = (chunk.text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const keys = new Set<string>()

  for (const [i, line] of lines.entries()) {
    const key = normalizeLabel(line)
    if (key) keys.add(key)

    if (!isHeadingLine(line)) continue

    let joined = line
    for (
      let j = i + 1;
      j < lines.length && j < i + MAX_HEADING_LINES_PER_LABEL;
      j++
    ) {
      const next = lines[j]!
      if (!isHeadingLine(next)) break

      joined += ` ${next}`
      const joinedKey = normalizeLabel(joined)
      if (joinedKey) keys.add(joinedKey)
    }
  }

  return keys
}

/**
 * Every chunk in `[0, end)` whose headings include this label. Whole-line (or
 * whole-heading-block) equality keeps in-text cross references ("as we saw in
 * chapter 4") from moving a section boundary.
 */
function findLabelIndices(
  headingKeys: Array<Set<string>>,
  end: number,
  keys: string[],
  skip: ReadonlySet<number>
): number[] {
  if (!keys.length) return []

  const found: number[] = []
  for (let i = 0; i < Math.min(end, headingKeys.length); i++) {
    if (skip.has(i)) continue
    if (keys.some((key) => headingKeys[i]!.has(key))) found.push(i)
  }

  return found
}

/**
 * Choose at most one candidate chunk per TOC entry so that the chosen indices
 * strictly increase in TOC order, maximising how many entries get placed.
 *
 * Matching greedily instead — taking each label's first hit — lets one entry
 * that matches late swallow the whole tail of the book, because every later
 * entry is then restricted to the chunks after it. Optimising over the sequence
 * as a whole makes a single stray match cost one entry rather than sixty.
 */
function assignCandidates(
  candidates: number[][],
  chunkCount: number,
  prefer: (entry: number, index: number) => number
): Array<number | undefined> {
  const n = candidates.length

  // best[i][v] = most entries placeable from entry i onwards, given the next
  // chunk index must be >= v.
  const best: Int32Array[] = Array.from(
    { length: n + 1 },
    () => new Int32Array(chunkCount + 2)
  )

  for (let i = n - 1; i >= 0; i--) {
    const isCandidate = new Set(candidates[i])
    // suffix[v] = best score achievable by placing entry i at some index >= v.
    const suffix = new Int32Array(chunkCount + 2).fill(-1)
    for (let c = chunkCount - 1; c >= 0; c--) {
      const placed = isCandidate.has(c) ? 1 + best[i + 1]![c + 1]! : -1
      suffix[c] = Math.max(placed, suffix[c + 1]!)
    }

    for (let v = 0; v <= chunkCount; v++) {
      best[i]![v] = Math.max(best[i + 1]![v]!, suffix[v]!)
    }
  }

  const starts: Array<number | undefined> = Array.from({ length: n })
  let next = 0

  for (let i = 0; i < n; i++) {
    const target = best[i]![next]!
    let choice: number | undefined
    let choiceRank = -1

    for (const c of candidates[i]!) {
      if (c < next) continue
      if (1 + best[i + 1]![c + 1]! !== target) continue

      // Among placements that are equally optimal, take the most trustworthy
      // one — a real heading match beats a bare page boundary.
      const rank = prefer(i, c)
      if (rank > choiceRank) {
        choice = c
        choiceRank = rank
      }
    }

    if (choice === undefined) continue

    starts[i] = choice
    next = choice + 1
  }

  return starts
}

/**
 * Index into `content` where each TOC entry starts, or `undefined` for entries
 * with no page or no room left. Always non-decreasing.
 */
export function resolveTocStartIndices(
  toc: TocItem[],
  content: ContentChunk[]
): Array<number | undefined> {
  // `undefined` means there is no usable page anchor: either the entry has no
  // page, or its page lies past the last chunk. Some books number the TOC on a
  // finer scale than the chunks (Kindle locations vs reader pages), in which
  // case the tail of the TOC has no anchor and falls back to label matching.
  const pageStarts = toc.map((item) => {
    if (item.page === undefined) return undefined

    const index = content.findIndex((chunk) => chunk.page >= item.page!)
    return index === -1 ? undefined : index
  })

  const headingKeys = content.map((chunk) => chunkHeadingKeys(chunk))

  // A book's own contents listing repeats every chapter title, and it can sit
  // at the back as easily as the front. Left alone it steals the match for a
  // title whose real heading was missed, which then starves every entry after
  // it — so ignore chunks that look like the listing itself.
  const contentsKeys = new Set(toc.flatMap((item) => labelKeys(item.label)))
  const contentsChunks = new Set(
    headingKeys.flatMap((keys, i) => {
      let hits = 0
      for (const key of keys) {
        if (contentsKeys.has(key)) hits++
      }

      return hits >= 3 ? [i] : []
    })
  )

  const labelMatches: Array<Set<number>> = []
  const candidates: number[][] = []

  for (const [i, item] of toc.entries()) {
    const pageStart = pageStarts[i]

    // The window ends where the next entry on a *later* page begins, so entries
    // sharing a page each get the whole page group to find their heading in.
    let windowEnd = content.length
    if (pageStart !== undefined) {
      for (let j = i + 1; j < toc.length; j++) {
        const nextPageStart = pageStarts[j]
        if (nextPageStart !== undefined && nextPageStart > pageStart) {
          windowEnd = nextPageStart
          break
        }
      }
    }

    // The entry that *is* the contents listing still gets to match it.
    const keys = labelKeys(item.label)
    const matches = findLabelIndices(
      headingKeys,
      windowEnd,
      keys,
      keys.includes('contents') ? new Set() : contentsChunks
    )

    labelMatches.push(new Set(matches))
    candidates.push(
      pageStart === undefined || matches.includes(pageStart)
        ? matches
        : [...matches, pageStart].toSorted((a, b) => a - b)
    )
  }

  return assignCandidates(candidates, content.length, (entry, index) =>
    labelMatches[entry]!.has(index) ? 1 : 0
  )
}

/**
 * Split the book's chunks into sections, one per resolvable TOC entry.
 *
 * Every chunk lands in exactly one section: the first section is extended back
 * to the start of the book and the last runs to the end. Entries with no
 * chunks at all are dropped — back matter such as `Index` or `About the
 * Publisher` routinely sits past the last page the scrape captured.
 */
export function resolveBookSections(
  toc: TocItem[],
  content: ContentChunk[]
): BookSection[] {
  const starts = resolveTocStartIndices(toc, content)
  const resolved = toc
    .map((tocItem, tocIndex) => ({
      tocItem,
      tocIndex,
      start: starts[tocIndex]
    }))
    .filter(
      (entry): entry is typeof entry & { start: number } =>
        entry.start !== undefined
    )

  if (!resolved.length) return []

  // Nothing before the first heading is dropped on the floor.
  resolved[0]!.start = 0

  const sections = resolved
    .map((entry, i) => ({
      tocItem: entry.tocItem,
      tocIndex: entry.tocIndex,
      chunks: content.slice(
        entry.start,
        resolved[i + 1]?.start ?? content.length
      )
    }))
    .filter((section) => section.chunks.length)

  return sections.map((section, i) => ({
    ...section,
    nextLabel: sections[i + 1]?.tocItem.label
  }))
}
