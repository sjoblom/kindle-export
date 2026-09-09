/**
 * Rebuilding paragraphs from the line boxes an OCR engine reports.
 *
 * Apple's Vision framework recognises one *rendered* line at a time, but the
 * formatter downstream (`postprocess-text.ts`) treats every newline in a page's
 * text as a paragraph boundary. Emitting one line per newline therefore turns
 * every wrapped line of prose into its own paragraph. This module puts the
 * paragraphs back together from where the lines sit on the page, so the engine
 * can honour that contract: one newline out means one paragraph.
 *
 * Every threshold below is calibrated from the page itself — the median line
 * height, the median line pitch, the column edges — because font size, leading
 * and margins all change with the reader's own settings.
 */

export interface OcrLine {
  /** The recognised text of one rendered line. */
  text: string
  /** Pixels from the left edge of the page image. */
  left: number
  /** Pixels from the top edge of the page image. */
  top: number
  width: number
  height: number
}

interface PageMetrics {
  /** Typical height of a line's box, which stands in for the font size. */
  lineHeight: number
  /** Typical top-to-top distance between consecutive lines. */
  pitch: number
  /** Where the body column starts, ignoring indented and centred lines. */
  columnLeft: number
  /** Where the body column ends, taken from the line that reaches furthest. */
  columnRight: number
}

/**
 * A line ending in a hyphen after a run of letters long enough that a
 * typesetter would have broken there. Two letters or fewer is far more likely
 * to be a real prefix (`co-`, `e-`, `re-`) than a soft break, so those keep
 * their hyphen.
 */
const SOFT_HYPHEN_END_REGEX = /\p{Ll}{3,}[-‐]$/u

/** A hyphen or dash at the end of a line, soft or not. */
const HYPHEN_END_REGEX = /[-‐]$/u

/** An em or en dash, which joins tight against the next word rather than with a space. */
const DASH_END_REGEX = /[—–]$/u

/** A continuation of a hyphenated word, as opposed to `Anglo-` + `Saxon`. */
const LOWERCASE_START_REGEX = /^\p{Ll}/u

function percentile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]!

  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

function quantile(values: number[], fraction: number): number {
  return percentile(
    values.toSorted((a, b) => a - b),
    fraction
  )
}

function measurePage(lines: OcrLine[]): PageMetrics {
  const lineHeight = quantile(
    lines.map((line) => line.height),
    0.5
  )

  // Only forward steps down the page describe leading; Vision occasionally
  // hands back two boxes on the same visual line, and those would drag the
  // typical pitch towards zero.
  const pitches: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const step = lines[i]!.top - lines[i - 1]!.top
    if (step > 0) pitches.push(step)
  }

  return {
    lineHeight,
    // A page of prose is mostly body lines, so the median pitch is the normal
    // leading even when a few paragraph gaps are mixed in.
    pitch: pitches.length ? quantile(pitches, 0.5) : lineHeight * 1.2,
    // Everything that is not flush left — indented first lines, centred
    // headings — sits to the right of the column edge, so a low quantile finds
    // the edge itself. The median would do on a page of prose but drifts on a
    // short page that is half heading.
    columnLeft: quantile(
      lines.map((line) => line.left),
      0.25
    ),
    // Right edges are the other way round: every paragraph ends on a short
    // line, so only the longest line reaches the margin. Being too generous
    // here is the safe direction — it can only make the `stops short` test
    // below more permissive, and that test never splits a paragraph on its own.
    columnRight: Math.max(...lines.map((line) => line.left + line.width))
  }
}

/**
 * Whether a line is centred in the column rather than set flush left, which is
 * how chapter headings, scene breaks and epigraph attributions are rendered.
 * Those should stay paragraphs of their own even when nothing else separates
 * them from the prose around them.
 */
function isCentered(line: OcrLine, metrics: PageMetrics): boolean {
  const columnWidth = metrics.columnRight - metrics.columnLeft
  if (columnWidth <= 0) return false

  // A full-width line cannot be centred, whatever its margins say.
  if (line.width > columnWidth * 0.8) return false

  const leftMargin = line.left - metrics.columnLeft
  const rightMargin = metrics.columnRight - (line.left + line.width)

  // Flush left with a ragged end is just the last line of a paragraph.
  if (leftMargin < metrics.lineHeight * 0.5) return false

  // Generous, because the column's right edge is only ever an estimate: it
  // comes from the longest line on the page, which need not quite reach the
  // margin.
  const tolerance = Math.max(metrics.lineHeight * 1.5, columnWidth * 0.06)
  return Math.abs(leftMargin - rightMargin) <= tolerance
}

/**
 * Whether `line` sits further down the page than the leading on this page
 * explains, which is how a book that separates paragraphs with a blank line
 * marks a boundary.
 *
 * The margin has to be generous because Vision's boxes hug the glyphs: a line
 * with no ascenders starts measurably lower than its neighbours, so raw
 * top-to-top distances jitter by a fair fraction of a line.
 */
function hasExtraLeading(
  prev: OcrLine,
  line: OcrLine,
  metrics: PageMetrics
): boolean {
  const step = line.top - prev.top
  const slack = Math.max(metrics.pitch * 0.35, metrics.lineHeight * 0.4)

  return step > metrics.pitch + slack
}

/**
 * Whether `line` is a first line indented under the previous paragraph's last
 * line, which is how a book that does not leave a blank line marks a boundary.
 *
 * An indent is about an em wide, which is why the threshold is scaled to the
 * line height rather than to the page. The previous line also has to have
 * stopped short of the right margin, as the last line of a paragraph does:
 * that costs nothing in a real book and rules out prose that simply runs on
 * with a wide glyph at the start of a line.
 */
function isIndentedStart(
  prev: OcrLine,
  line: OcrLine,
  metrics: PageMetrics
): boolean {
  const indented = line.left > metrics.columnLeft + metrics.lineHeight * 0.8
  const prevStopsShort =
    prev.left + prev.width < metrics.columnRight - metrics.lineHeight * 0.3

  return indented && prevStopsShort
}

/**
 * Join two rendered lines of the same paragraph back into running text.
 *
 * A line-ending hyphen is ambiguous — `some-`/`thing` wants joining as one
 * word, `Anglo-`/`Saxon` keeps its hyphen — so the split is made on the two
 * things that are visible: a soft break happens after a decent run of
 * lowercase letters and resumes in lowercase, whereas a real compound usually
 * shows a capital on one side or is a short prefix.
 */
export function joinWrappedLines(prev: string, next: string): string {
  if (SOFT_HYPHEN_END_REGEX.test(prev) && LOWERCASE_START_REGEX.test(next)) {
    return prev.slice(0, -1) + next
  }

  // A hyphen or dash that survives is part of the text, and the word after it
  // belongs tight against it rather than a space away.
  if (HYPHEN_END_REGEX.test(prev) || DASH_END_REGEX.test(prev)) {
    return prev + next
  }

  return `${prev} ${next}`
}

/**
 * Turn per-line OCR output into text where each newline is a real paragraph
 * boundary, which is what the markdown formatter expects.
 *
 * The lines are consumed in the order the engine reported them, which is the
 * reading order Vision already worked out; this only decides where the breaks
 * between them go.
 */
export function reconstructParagraphs(lines: OcrLine[]): string {
  const usable = lines.filter((line) => line.text.trim().length > 0)
  if (usable.length === 0) return ''

  const metrics = measurePage(usable)
  const paragraphs: string[] = []

  let current = usable[0]!.text.trim()
  let currentIsCentered = isCentered(usable[0]!, metrics)

  for (let i = 1; i < usable.length; i++) {
    const prev = usable[i - 1]!
    const line = usable[i]!
    const centered = isCentered(line, metrics)

    // Crossing between centred and flush-left text is always a boundary. Two
    // centred lines in a row are one wrapped heading rather than two headings,
    // and the indent test means nothing there — every centred line is indented.
    const boundary =
      centered !== currentIsCentered ||
      hasExtraLeading(prev, line, metrics) ||
      (!centered && isIndentedStart(prev, line, metrics))

    if (boundary) {
      paragraphs.push(current)
      current = line.text.trim()
    } else {
      current = joinWrappedLines(current, line.text.trim())
    }

    currentIsCentered = centered
  }

  paragraphs.push(current)
  return paragraphs.filter(Boolean).join('\n')
}

/**
 * Validate the line boxes off the wire. The worker is our own binary, but a
 * stale one on disk should degrade to dropping a line rather than throwing
 * partway through a book.
 */
export function parseOcrLines(value: unknown): OcrLine[] {
  if (!Array.isArray(value)) return []

  const lines: OcrLine[] = []
  for (const entry of value) {
    const line = entry as Partial<OcrLine> | null
    if (!line || typeof line.text !== 'string') continue
    if (
      ![line.left, line.top, line.width, line.height].every(
        (n) => typeof n === 'number' && Number.isFinite(n)
      )
    ) {
      continue
    }

    lines.push({
      text: line.text,
      left: line.left!,
      top: line.top!,
      width: line.width!,
      height: line.height!
    })
  }

  return lines
}
