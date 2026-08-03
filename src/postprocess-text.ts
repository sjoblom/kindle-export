import type { ContentChunk } from './types'

/**
 * Deterministic cleanup of the raw per-page OCR text in `content.json`.
 *
 * The OCR step asks for verbatim plain text with no markdown and strips
 * per-line indentation, so the only layout signal that survives is where the
 * model chose to break lines. Empirically it breaks on *paragraphs*, not on
 * rendered lines, which leaves exactly two recoverable defects:
 *
 * 1. A paragraph that spans a page boundary is split in two, because each page
 *    is a separate chunk. ~20-40% of pages end mid-sentence.
 * 2. Section headings inside a chapter are emitted as ordinary all-caps
 *    paragraphs. Only chapter-level headings are recovered downstream, from
 *    the table of contents.
 *
 * Rules that a PDF pipeline would need here — dehyphenation, page-number
 * stripping, running-header removal — are deliberately absent: the corpus has
 * no line-ending hyphens, no standalone page numbers, and no running heads,
 * and stripping repeated page-edge lines would eat real chapter headings.
 */

const MAX_HEADING_LENGTH = 70

/** `CHAPTER 1`, `Part IV`, `Step 3.` — a heading that only numbers a section. */
const SECTION_LEADER_REGEX =
  /^(?:chapter|part|section|step|book|appendix)\s+[\divxlcdm]+[.:]?$/i

/** A paragraph ending that could plausibly continue onto the next page. */
const CONTINUATION_END_REGEX = /[\p{L}\p{N},;—–-]$/u

/** A paragraph opening that could plausibly continue the previous page. */
const CONTINUATION_START_REGEX = /^\p{Ll}/u

const DASH_END_REGEX = /[—–-]$/

export interface FormatContentChunksOptions {
  /** Promote detected all-caps headings to markdown headings. */
  detectHeadings?: boolean

  /** Number of `#` to use for detected headings. */
  headingLevel?: number

  /**
   * Label of the enclosing TOC section. Headings at the top of the section
   * which restate it are dropped, since the caller has already emitted one.
   */
  sectionLabel?: string

  /**
   * Label of the next TOC section. A chapter heading usually falls a page or
   * two before the TOC says the chapter starts, so it lands at the end of this
   * section; trailing headings that restate the next section are dropped.
   */
  nextSectionLabel?: string

  /**
   * Markdown blocks to emit before a page's first chunk (illustrations).
   * Text is never joined across these.
   */
  getPageBlocks?: (page: number) => string[]
}

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, ' ')
    .trim()
}

/**
 * Whether a line is an all-caps section heading. Headings lose their font
 * metrics during OCR, so capitalization is the only signal left.
 */
export function isHeadingLine(line: string): boolean {
  if (!line || line.length > MAX_HEADING_LENGTH) return false

  // Any lowercase letter means it's prose, not an all-caps heading.
  if (/\p{Ll}/u.test(line)) return false

  // Needs a real run of capitals, so `1984` and `* * *` don't qualify.
  if (!/\p{Lu}{2}/u.test(line)) return false

  // Headings may end in `?` or `!` but not in sentence or list punctuation.
  return !/[.,;:]$/.test(line)
}

function isDuplicateSectionHeading(
  line: string,
  sectionLabelKey: string | undefined
): boolean {
  if (!sectionLabelKey) return false
  if (SECTION_LEADER_REGEX.test(line)) return true

  const key = normalizeLabel(line)
  if (!key) return false

  return (
    key === sectionLabelKey ||
    // TOC labels are often numbered (`1. The Mom Test`) while the heading on
    // the page is not.
    sectionLabelKey.replace(/^\d+\s+/, '') === key
  )
}

interface Block {
  markdown: string
  /** The raw heading text, for blocks that are headings. */
  heading?: string
}

function splitParagraphs(text: string | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Whether `next` continues the paragraph `prev` across a page boundary.
 *
 * Both sides must look like a mid-sentence break. Requiring the next page to
 * start lowercase misses continuations that resume on a proper noun, which is
 * the safe direction to be wrong in: a missed join reads as it does today,
 * whereas a bad join welds two unrelated paragraphs together.
 */
export function continuesParagraph(prev: string, next: string): boolean {
  return (
    CONTINUATION_END_REGEX.test(prev) && CONTINUATION_START_REGEX.test(next)
  )
}

function joinParagraphs(prev: string, next: string): string {
  return DASH_END_REGEX.test(prev) ? prev + next : `${prev} ${next}`
}

/**
 * Render a run of page chunks as markdown paragraphs, rejoining paragraphs
 * that were split across pages and recovering all-caps section headings.
 */
export function formatContentChunks(
  chunks: ContentChunk[],
  {
    detectHeadings = true,
    headingLevel = 3,
    sectionLabel,
    nextSectionLabel,
    getPageBlocks
  }: FormatContentChunksOptions = {}
): string {
  const sectionLabelKey = sectionLabel
    ? normalizeLabel(sectionLabel)
    : undefined
  const nextSectionLabelKey = nextSectionLabel
    ? normalizeLabel(nextSectionLabel)
    : undefined
  const seenPages = new Set<number>()
  const blocks: Block[] = []

  // The trailing paragraph of the previous chunk, held back so the next chunk
  // can continue it.
  let pending = ''
  let hasBody = false

  function flush() {
    if (!pending) return

    blocks.push({ markdown: pending })
    pending = ''
    hasBody = true
  }

  for (const chunk of chunks) {
    if (!seenPages.has(chunk.page)) {
      seenPages.add(chunk.page)

      const pageBlocks = getPageBlocks?.(chunk.page) ?? []
      if (pageBlocks.length) {
        // An illustration interrupts the text, so never join across it.
        flush()
        blocks.push(...pageBlocks.map((markdown) => ({ markdown })))
      }
    }

    const paragraphs = splitParagraphs(chunk.text)

    for (const [i, paragraph] of paragraphs.entries()) {
      if (detectHeadings && isHeadingLine(paragraph)) {
        flush()

        if (!hasBody && isDuplicateSectionHeading(paragraph, sectionLabelKey)) {
          continue
        }

        blocks.push({
          markdown: `${'#'.repeat(headingLevel)} ${paragraph}`,
          heading: paragraph
        })
        continue
      }

      if (pending && continuesParagraph(pending, paragraph)) {
        pending = joinParagraphs(pending, paragraph)
      } else {
        flush()
        pending = paragraph
      }

      // Only the last paragraph of a chunk can continue onto the next page.
      if (i < paragraphs.length - 1) {
        flush()
      }
    }
  }

  flush()

  // The heading for the next chapter usually sits a page or two before the TOC
  // says that chapter starts, so it lands here and would duplicate the heading
  // the caller emits next.
  while (blocks.length) {
    const block = blocks.at(-1)!
    if (
      block.heading === undefined ||
      !isDuplicateSectionHeading(block.heading, nextSectionLabelKey)
    ) {
      break
    }

    blocks.pop()
  }

  return blocks.map((block) => block.markdown).join('\n\n')
}
