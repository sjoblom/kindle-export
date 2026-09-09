# kindle-export

Export Kindle books you own as clean markdown. On macOS it runs entirely on
your own machine — no API key, no network calls, nothing to pay for.

```bash
kindle-export serve          # the web app — everything in your browser
```

or, in the terminal:

```bash
kindle-export login          # once
kindle-export                # pick books from your library, then export
```

No need to hunt for ASINs — running it with no arguments reads your Kindle
library and shows a menu you can select one or many books from. If you already
know the ASIN, pass it directly: `kindle-export B01H4G2J1U`.

## The web app

`kindle-export serve` opens a local page in your browser that walks through
the whole flow — made so that someone who never touches a terminal can use
this after a one-time install:

1. **Settings** — nothing to fill in on macOS, which reads pages itself. An
   OpenAI key is only needed if you name a model instead; it's stored in
   `~/.kindle-export/config.json`, readable only by you.
2. **Sign in to Amazon** — a Chrome window opens on Amazon's own sign-in page.
   Password and 2FA happen there, exactly as they would anywhere; the window
   closes itself when the sign-in is confirmed. The app never sees the
   password.
3. **Pick books** — your Kindle library with search, checkboxes, and badges on
   books that were already exported.
4. **Export** — live progress per book. Capture happens in a minimized Chrome
   window that turns the pages by itself, and pops back up only if Amazon
   wants a sign-in. Books that finish with unreadable pages are labelled
   honestly instead of pretending success.
5. **Download** — every finished book is listed with download buttons (and
   "Show in Finder" on macOS), including books exported in earlier runs.

The server binds `127.0.0.1` only — nothing is reachable from the network —
and rejects requests whose `Host` or headers don't come from its own page.
Everything the CLI can do beyond this (per-stage commands, `--force`, PDF
output, cleanup) still works from the terminal; the two share one pipeline and
one on-disk state, so you can mix them freely.

### A double-clickable app

For someone who shouldn't have to see a terminal at all, `pnpm package` builds
`Kindle Export.app` — a self-contained bundle with its own Node runtime, so
the Mac it runs on needs nothing installed except Google Chrome:

```bash
pnpm package
```

It lands in `dist-app/`. Copy it to the other Mac's `/Applications`, then
right-click → **Open** → **Open** once — it isn't notarised, so the first
launch needs that; afterwards it opens with a normal double-click. It shows a
Dock icon while running, writes books to `~/Documents/Kindle Export`, and
**Quit** stops the server properly rather than leaving it holding the port.

If something goes wrong at startup it says so and points at
`~/Library/Logs/Kindle Export.log`.

## How it works

Kindle Cloud Reader renders each page as an image, so there is no text layer to
read. The pipeline is three stages, and each one resumes:

1. **capture** — drives a real browser through the book, saving one image per
   rendered page plus the table of contents and metadata.
2. **transcribe** — reads the text off each page image and stores it in
   `content.json`. On macOS this uses Apple's Vision framework locally;
   elsewhere, or with `--model`, an OpenAI vision model.
3. **export** — reassembles the text into markdown.

Re-running skips any stage whose output already exists, so an interrupted book
picks up where it left off. Use `--force-ocr` (or `--force`) to redo a stage.

Transcription resumes at page granularity: if some pages fail, re-running
retries only those, rather than paying to read the whole book again. Pages that
could never be read are listed explicitly and the command exits non-zero — an
export with holes in it isn't success, even though a file was written.

## Install

Requires Node 20+. Uses Google Chrome if installed, otherwise Playwright's
bundled Chromium. On macOS, the Xcode command line tools
(`xcode-select --install`) enable free local OCR; without them the build still
succeeds and transcription falls back to OpenAI.

```bash
git clone https://github.com/sjoblom/kindle-export
cd kindle-export
pnpm install
pnpm build
npm link          # optional: puts `kindle-export` on your PATH
```

Without `npm link`, run it as `pnpm kindle-export <args>`.

There is nothing you have to configure on macOS. `kindle-export setup` stores
defaults — output directory, and an OpenAI key if you want one — in
`~/.kindle-export/config.json`:

```bash
kindle-export setup
```

(A key in `.env` or the environment also works and takes precedence; the web
app's Settings screen writes the same stored config.)

Sign in once. This opens a browser, lets you complete login and 2FA
yourself, and stores the session under `~/.kindle-export/profile`:

```bash
kindle-export login
```

**You do not need to put your Amazon password anywhere.** If the stored session
expires, a browser window opens and you sign in by hand. `AMAZON_EMAIL` and
`AMAZON_PASSWORD` exist only if you want sign-in scripted for unattended runs.

### What leaves your machine

On macOS, in the default configuration: **nothing**. Pages are read locally by
Apple's Vision framework, your Amazon session stays in a local browser profile,
and the text and images stay in `out/`. The only network traffic is with Amazon
itself, to read the book you already own.

Passing `--model` (or running off macOS) sends every page image to OpenAI to be
transcribed instead. That costs roughly one vision-model call per page — a few
tens of cents for a 300-page book on `gpt-4.1-mini` — and both the model and
the concurrency are configurable.

### Platform support

Developed and tested on **macOS**, where it also reads pages locally. It uses
Google Chrome when installed and falls back to Playwright's bundled Chromium
otherwise, which should cover Linux and containers — but that fallback path is
**untested**, so treat Linux and Windows as unverified rather than supported.
Off macOS, transcription requires an OpenAI key. Set `BROWSER_CHANNEL` to pick
a specific channel (`chrome`, `msedge`, …) or leave it unset for the default.
Reports welcome.

## Usage

```
kindle-export serve                  open the web app in your browser
kindle-export                        pick books from your library, then export
kindle-export <ASIN...>              capture, transcribe and export
kindle-export login                  sign in once, storing the session
kindle-export list                   list the books in your Kindle library
kindle-export capture <ASIN...>      capture page images only
kindle-export ocr <ASIN...>          transcribe captured pages only
kindle-export export <ASIN...>       render markdown from transcribed text only
```

Useful options: `--format md,pdf`, `--json` and `--limit` for `list`,
`--port` for `serve`, plus `--out-dir`, `--profile-dir`, `--model`,
`--concurrency`, `--otp` and `--force`. Run `kindle-export --help` for the
full list.

`--model` switches transcription from local OCR to an OpenAI model, which needs
an API key. Leave it unset on macOS to read pages for free.

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

- **Transcription is OCR**, so it is not perfectly faithful. Apple's Vision
  framework applies language correction, which resolves ambiguous glyphs
  against a dictionary — measured over a 126-page book it altered 62 pages and
  touched a digit exactly once, so on prose it fixes far more than it invents.
  An isolated number with no surrounding words is where it errs.
- **Off macOS, transcription is a paid model call.** Budget roughly one call
  per page.
- **Some books section poorly.** Where the table of contents is numbered in
  Kindle locations rather than pages, and chapter titles wrap across lines,
  fewer chapters are matched and sections run long. No text is lost — every
  page lands in exactly one section.
- **Login is interactive.** Amazon may challenge the session; that is by design
  and the reason this is a local tool rather than a service.

## Scope

This is for exporting books **you have purchased**, for your own reading,
research and archival use. Automating Kindle Cloud Reader is contrary to
Amazon's terms of service, and using it may put your Amazon account at risk —
that risk is yours to weigh. Don't redistribute what it produces; the output is
copyrighted material belonging to its authors and publishers.

Not affiliated with, endorsed by, or connected to Amazon. "Kindle" is a
trademark of Amazon.com, Inc.

## Credits

A fork of [kindle-ai-export](https://github.com/transitive-bullshit/kindle-ai-export)
by Travis Fischer, MIT licensed. This fork adds a unified CLI, library listing
and selection, resumable stages, deterministic text post-processing,
table-of-contents section resolution, free local OCR on macOS, a local web app
and a double-clickable macOS bundle.

Licensed under the [MIT License](LICENSE).
