# kindle-export

Export Kindle books you own as clean markdown. Runs entirely on your own
machine — your Amazon session never leaves it.

```bash
kindle-export login          # once
kindle-export                # pick books from your library, then export
```

No need to hunt for ASINs — running it with no arguments reads your Kindle
library and shows a menu you can select one or many books from. If you already
know the ASIN, pass it directly: `kindle-export B01H4G2J1U`.

## How it works

Kindle Cloud Reader renders each page as an image, so there is no text layer to
read. The pipeline is three stages, and each one resumes:

1. **capture** — drives a real browser through the book, saving one image per
   rendered page plus the table of contents and metadata.
2. **transcribe** — sends each page image to a vision model and stores the text
   in `content.json`.
3. **export** — reassembles the text into markdown.

Re-running skips any stage whose output already exists, so an interrupted book
picks up where it left off. Use `--force-ocr` (or `--force`) to redo a stage.

## Install

Requires Node 20+, Chrome, and an OpenAI API key.

```bash
pnpm install
```

Set credentials in `.env` (see `.env.example`):

```
AMAZON_EMAIL=
AMAZON_PASSWORD=
OPENAI_API_KEY=
```

Then sign in once. This opens a browser, lets you complete login and 2FA
yourself, and stores the session under `~/.kindle-export/profile`:

```bash
kindle-export login
```

## Usage

```
kindle-export                        pick books from your library, then export
kindle-export <ASIN...>              capture, transcribe and export
kindle-export login                  sign in once, storing the session
kindle-export list                   list the books in your Kindle library
kindle-export capture <ASIN...>      capture page images only
kindle-export ocr <ASIN...>          transcribe captured pages only
kindle-export export <ASIN...>       render markdown from transcribed text only
```

Useful options: `--json` and `--limit` for `list`, plus `--out-dir`,
`--profile-dir`, `--model`, `--concurrency`, `--otp` and `--force`. Run
`kindle-export --help` for the full list.

`list` reads the same internal JSON endpoint the Kindle library page uses, so
it sees everything in your account and pages through it. Piping `--json`
elsewhere is the easy way to script a bulk export.

The ASIN is also in the Amazon URL for a book — `.../dp/B01H4G2J1U`.

## Output

```
out/<ASIN>/
  metadata.json    title, authors, table of contents, page index
  pages/           one PNG per rendered page
  content.json     transcribed text, one chunk per page
  <title>.md       the finished markdown
```

## Text quality

Transcribing page-by-page introduces two artefacts that
[`postprocess-text.ts`](src/postprocess-text.ts) repairs deterministically:

- **Paragraphs split across page boundaries.** 20–40% of pages end mid-sentence;
  those halves are rejoined. The join only happens when the previous page ends
  mid-sentence _and_ the next begins lowercase — a missed join reads as it does
  today, whereas a wrong join welds unrelated paragraphs together.
- **Flattened headings.** Section headings arrive as ordinary all-caps
  paragraphs and are promoted back to markdown headings.

Rules a PDF pipeline would need are deliberately absent — this corpus has no
line-ending hyphens, no standalone page numbers, and no running heads, and
stripping repeated page-edge lines would eat real chapter headings.

Section boundaries come from the table of contents, matched against headings
found in the text ([`toc-sections.ts`](src/toc-sections.ts)). Kindle page
numbers are coarse and sometimes numbered on a different scale from the
captured pages, so the label match is what actually pins a chapter down.

## Limitations

- **Transcription is a model call**, so it is neither free nor perfectly
  faithful. Budget roughly one call per page.
- **Some books section poorly.** Where the table of contents is numbered in
  Kindle locations rather than pages, and chapter titles wrap across lines,
  fewer chapters are matched and sections run long. No text is lost — every
  page lands in exactly one section.
- **Login is interactive.** Amazon may challenge the session; that is by design
  and the reason this is a local tool rather than a service.

## Scope

This is for exporting books **you have purchased**, for your own reading,
research and archival use. Automating Kindle Cloud Reader is contrary to
Amazon's terms of service, and using it may put your Amazon account at risk.
Don't redistribute what it produces — the output is copyrighted material.

## Credits

A fork of [kindle-ai-export](https://github.com/transitive-bullshit/kindle-ai-export)
by Travis Fischer, MIT licensed. This fork adds a unified CLI, resumable
stages, deterministic text post-processing, and table-of-contents section
resolution.
