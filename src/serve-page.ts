/**
 * The web app's single page: markup, styles and client script in one string,
 * served with no external assets so it works offline and never phones home.
 *
 * The client script deliberately avoids template literals — the whole page
 * lives inside one TypeScript template string, and nested backticks are a
 * silent way to break it. DOM nodes are built with a small helper instead,
 * which also means book titles are always set via textContent, never HTML.
 */
export function renderPage(): string {
  return PAGE
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kindle Export</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📖</text></svg>">
<style>
:root {
  --bg: #f6f4f0;
  --card: #ffffff;
  --text: #1f1b16;
  --muted: #6f675e;
  --border: #e4dfd7;
  --accent: #955115;
  --accent-text: #ffffff;
  --accent-soft: #f4e8dc;
  --good: #1a7f37;
  --good-soft: #e3f2e7;
  --warn: #9a6700;
  --warn-soft: #fbf0d9;
  --bad: #c03030;
  --bad-soft: #fbe5e5;
  --track: #eee9e1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #191512;
    --card: #211d19;
    --text: #ece7e0;
    --muted: #a49a8e;
    --border: #38322b;
    --accent: #e8944a;
    --accent-text: #201409;
    --accent-soft: #33261a;
    --good: #4cc06a;
    --good-soft: #1d2f22;
    --warn: #e0aa3e;
    --warn-soft: #322a17;
    --bad: #e06c6c;
    --bad-soft: #382020;
    --track: #322d27;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
header { margin-bottom: 24px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
h1 .logo { margin-right: 8px; }
.tagline { color: var(--muted); margin: 0; }
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 16px;
}
.card h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  margin: 0 0 6px;
}
.stepnum {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--track);
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
}
.stepnum.done { background: var(--good-soft); color: var(--good); }
.hint { color: var(--muted); font-size: 13.5px; margin: 0 0 14px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
label.field { display: block; margin-bottom: 12px; }
label.field span { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
input[type=text], input[type=password], input[type=search] {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  font: inherit;
  font-weight: 600;
  padding: 9px 16px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover:not(:disabled) { filter: brightness(1.08); }
button:disabled { opacity: 0.55; cursor: default; }
button.small { padding: 5px 10px; font-size: 13px; font-weight: 500; }
a.filelink {
  display: inline-block;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  text-decoration: none;
  color: var(--accent);
  font-weight: 600;
}
a.filelink:hover { border-color: var(--accent); }
.pill {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.pill.good { background: var(--good-soft); color: var(--good); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--bad-soft); color: var(--bad); }
.pill.busy { background: var(--accent-soft); color: var(--accent); }
.pill.idle { background: var(--track); color: var(--muted); }
.booklist { margin: 12px 0 0; border: 1px solid var(--border); border-radius: 10px; max-height: 420px; overflow-y: auto; }
.bookrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.bookrow:last-child { border-bottom: none; }
.bookrow:hover { background: var(--bg); }
.bookrow input { flex: none; width: 16px; height: 16px; accent-color: var(--accent); }
.bookrow .meta { flex: 1; min-width: 0; }
.bookrow .title { font-weight: 600; font-size: 14px; }
.bookrow .authors { color: var(--muted); font-size: 12.5px; }
.jobrow { padding: 12px 0; border-bottom: 1px solid var(--border); }
.jobrow:last-child { border-bottom: none; }
.jobrow .toprow { display: flex; align-items: center; gap: 10px; }
.jobrow .title { flex: 1; font-weight: 600; font-size: 14px; min-width: 0; }
.progress { height: 6px; border-radius: 999px; background: var(--track); margin-top: 8px; overflow: hidden; }
.progress .fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 0.6s ease; }
.progress.indeterminate .fill { width: 30% !important; animation: slide 1.6s ease-in-out infinite; }
@keyframes slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.warnnote { color: var(--warn); font-size: 13px; margin-top: 6px; }
.errnote { color: var(--bad); font-size: 13px; margin-top: 6px; }
.notice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13.5px;
  margin-bottom: 14px;
}
.notice.warn { background: var(--warn-soft); }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.log {
  margin-top: 8px;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg);
  border-radius: 8px;
  padding: 10px 12px;
  max-height: 240px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.log .warn { color: var(--warn); }
.selectbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.selectbar .count { color: var(--muted); font-size: 13.5px; }
.formats { display: flex; gap: 12px; align-items: center; font-size: 13.5px; }
.formats label { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.formats input { accent-color: var(--accent); }
.spacer { flex: 1; }
#toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: var(--bad);
  color: #fff;
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 14px;
  max-width: 90vw;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s;
  z-index: 10;
}
#toast.show { opacity: 1; }
.filedone { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.mutedsmall { color: var(--muted); font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <header>
    <h1><span class="logo">📖</span>Kindle Export</h1>
    <p class="tagline">Turn Kindle books you own into files on this computer.</p>
  </header>

  <section class="card" id="card-settings">
    <h2><span class="stepnum" id="step1">1</span>Settings <span id="key-pill"></span></h2>
    <p class="hint" id="settings-hint">Reading a book's pages uses OpenAI and costs a little money —
    usually well under a dollar for a whole book. Your key is stored only on
    this computer.</p>
    <label class="field"><span>OpenAI API key</span>
      <input type="password" id="api-key" placeholder="sk-..." autocomplete="off">
    </label>
    <label class="field"><span>Model that reads the pages <span class="mutedsmall">(optional)</span></span>
      <input type="text" id="model" list="model-options" placeholder="gpt-4.1-mini" autocomplete="off">
      <datalist id="model-options">
        <option value="gpt-4.1-mini"></option>
        <option value="gpt-4.1"></option>
        <option value="gpt-4o-mini"></option>
        <option value="gpt-5-mini"></option>
      </datalist>
    </label>
    <div class="row">
      <button class="primary" id="save-settings">Save settings</button>
      <span class="mutedsmall" id="settings-msg"></span>
    </div>
  </section>

  <section class="card" id="card-amazon">
    <h2><span class="stepnum" id="step2">2</span>Amazon <span id="amazon-pill"></span></h2>
    <p class="hint">A Chrome window opens on Amazon's sign-in page. Sign in the
    way you always do — password, any code Amazon sends you — and the window
    closes by itself. Your password is never seen or stored by this app.</p>
    <div class="row">
      <button class="primary" id="login-btn">Sign in to Amazon</button>
      <span class="mutedsmall" id="amazon-msg"></span>
    </div>
  </section>

  <section class="card" id="card-books">
    <h2><span class="stepnum" id="step3">3</span>Your books</h2>
    <p class="hint">Pick the books to export. Books you already exported are
    marked, and can be downloaded again below without redoing anything.</p>
    <div class="row">
      <button class="primary" id="load-library">Show my books</button>
      <span class="mutedsmall" id="library-msg"></span>
    </div>
    <div id="library-area" hidden>
      <div style="margin-top:14px">
        <input type="search" id="search" placeholder="Search by title or author…">
      </div>
      <div class="booklist" id="booklist"></div>
      <div class="selectbar">
        <span class="count" id="sel-count">0 selected</span>
        <div class="formats" id="formats">
          <label><input type="checkbox" id="fmt-md" checked> Markdown</label>
          <label><input type="checkbox" id="fmt-pdf"> PDF</label>
        </div>
        <div class="spacer"></div>
        <button class="primary" id="export-btn" disabled>Export selected</button>
      </div>
    </div>
  </section>

  <section class="card" id="card-job" hidden>
    <h2>Export progress</h2>
    <div class="notice" id="chrome-notice" hidden>
      <span>🪟</span>
      <span><strong>Chrome is reading your book in the background.</strong> The
      window is minimized so it stays out of your way — no need to touch it,
      and it closes on its own when the book is done. If Amazon needs you to
      sign in, the window pops back up by itself; sign in and it
      continues.</span>
    </div>
    <div id="job-books"></div>
    <div class="row" style="margin-top:14px">
      <button id="stop-btn" hidden>Stop after current book</button>
      <span class="mutedsmall" id="job-msg"></span>
    </div>
    <details id="log-details"><summary>Show details</summary>
      <div class="log" id="job-log"></div>
    </details>
  </section>

  <section class="card" id="card-done" hidden>
    <h2>Finished books on this computer</h2>
    <p class="hint" id="done-hint"></p>
    <div id="done-list"></div>
  </section>
</main>
<div id="toast"></div>

<script>
'use strict'

var state = null
var selected = new Set()
var listFingerprint = ''
var modelTouched = false

function $(id) { return document.getElementById(id) }

function el(tag, attrs) {
  var node = document.createElement(tag)
  attrs = attrs || {}
  for (var key in attrs) {
    if (key === 'text') node.textContent = attrs[key]
    else if (key === 'class') node.className = attrs[key]
    else if (key === 'onclick') node.addEventListener('click', attrs[key])
    else node.setAttribute(key, attrs[key])
  }
  for (var i = 2; i < arguments.length; i++) {
    if (arguments[i]) node.appendChild(arguments[i])
  }
  return node
}

function toast(message) {
  var node = $('toast')
  node.textContent = message
  node.classList.add('show')
  clearTimeout(node._timer)
  node._timer = setTimeout(function () { node.classList.remove('show') }, 6000)
}

function api(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kindle-export': '1' },
    body: JSON.stringify(body || {})
  }).then(function (res) {
    return res.json().catch(function () { return {} }).then(function (data) {
      if (!res.ok) throw new Error(data.error || ('request failed (' + res.status + ')'))
      return data
    })
  })
}

function pill(kind, text) {
  return el('span', { class: 'pill ' + kind, text: text })
}

// ------------------------------------------------------------------ render

function render() {
  if (!state) return
  renderSettings()
  renderAmazon()
  renderLibrary()
  renderJob()
  renderDone()
}

function renderSettings() {
  // With local OCR there is nothing to fill in, so the step is complete from
  // the start and reads as an optional detail rather than a barrier.
  var settled = state.localOcr || state.hasApiKey
  $('step1').className = 'stepnum' + (settled ? ' done' : '')
  $('step1').textContent = settled ? '✓' : '1'

  var keyPill = $('key-pill')
  keyPill.textContent = ''
  keyPill.appendChild(state.localOcr
    ? pill('good', 'reads pages on this Mac')
    : state.hasApiKey
      ? pill('good', 'key saved')
      : pill('idle', 'no key yet'))

  $('settings-hint').textContent = state.localOcr
    ? 'Pages are read on this computer, free and offline — nothing to set up '
      + 'and nothing to pay for. An OpenAI key is only needed if you name a '
      + 'model below to read them instead.'
    : "Reading a book's pages uses OpenAI and costs a little money — usually "
      + 'well under a dollar for a whole book. Your key is stored only on this '
      + 'computer.'

  $('api-key').placeholder = state.hasApiKey
    ? 'saved — paste a new key to replace it'
    : state.localOcr
      ? 'not needed — sk-... to use OpenAI instead'
      : 'sk-...'

  var model = $('model')
  if (!modelTouched && document.activeElement !== model) {
    model.value = state.model || ''
    // Blank means local OCR where that exists, so say so rather than showing a
    // model name that isn't what will actually run.
    model.placeholder = state.localOcr
      ? 'this Mac (leave blank)'
      : state.defaultModel
  }
}

function renderAmazon() {
  var signedIn = state.amazon === 'signed-in'
  $('step2').className = 'stepnum' + (signedIn ? ' done' : '')
  $('step2').textContent = signedIn ? '✓' : '2'

  var pillNode
  if (signedIn) pillNode = pill('good', 'signed in')
  else if (state.amazon === 'signing-in') pillNode = pill('busy', 'waiting for you…')
  else if (state.amazon === 'signed-out') pillNode = pill('bad', 'signed out')
  else pillNode = pill('idle', 'not checked yet')

  var holder = $('amazon-pill')
  holder.textContent = ''
  holder.appendChild(pillNode)

  var btn = $('login-btn')
  btn.disabled = !!state.busy
  btn.textContent = signedIn ? 'Sign in again' : 'Sign in to Amazon'

  var msg = $('amazon-msg')
  if (state.amazon === 'signing-in') {
    msg.textContent = 'Finish signing in inside the Chrome window that opened.'
  } else if (state.amazon === 'signed-out') {
    msg.textContent = 'Amazon signed you out — sign in to continue.'
  } else {
    msg.textContent = ''
  }
}

function renderLibrary() {
  var loaded = !!(state.library && state.library.books.length)
  $('step3').className = 'stepnum' + (loaded ? ' done' : '')
  $('step3').textContent = loaded ? '✓' : '3'

  var btn = $('load-library')
  btn.disabled = !!state.busy
  btn.textContent = state.library ? 'Refresh list' : 'Show my books'

  var msg = $('library-msg')
  if (state.busy === 'library') {
    msg.textContent = 'Reading your library in a background Chrome window…'
  } else if (state.libraryError) {
    msg.textContent = 'Could not load the library: ' + state.libraryError
  } else if (state.library && !state.library.books.length) {
    msg.textContent = 'No books found in this Kindle library.'
  } else {
    msg.textContent = ''
  }

  if (!loaded) return
  $('library-area').hidden = false

  var byAsin = {}
  state.diskBooks.forEach(function (b) { byAsin[b.asin] = b })

  var fingerprint = String(state.library.fetchedAt) + '|' + JSON.stringify(state.diskBooks)
  if (fingerprint !== listFingerprint) {
    listFingerprint = fingerprint
    buildBookList(byAsin)
  }

  updateSelectionBar()
}

function buildBookList(byAsin) {
  var list = $('booklist')
  list.textContent = ''

  state.library.books.forEach(function (book) {
    var disk = byAsin[book.asin]
    var box = el('input', { type: 'checkbox' })
    box.checked = selected.has(book.asin)
    box.addEventListener('change', function () {
      if (box.checked) selected.add(book.asin)
      else selected.delete(book.asin)
      updateSelectionBar()
    })

    var meta = el('div', { class: 'meta' },
      el('div', { class: 'title', text: book.title }),
      el('div', { class: 'authors', text: (book.authors || []).join(', ') }))

    var row = el('label', { class: 'bookrow', 'data-search': (book.title + ' ' + (book.authors || []).join(' ')).toLowerCase() }, box, meta)

    if (disk && disk.exports.length) {
      var incomplete = (disk.incompleteCapture && disk.incompleteCapture.length) ||
        disk.transcribedPages < disk.capturedPages
      row.appendChild(incomplete ? pill('warn', 'exported, missing pages') : pill('good', 'exported'))
    } else if (book.resourceType && book.resourceType.indexOf('SAMPLE') !== -1) {
      row.appendChild(pill('idle', 'sample'))
    }

    list.appendChild(row)
  })

  applySearch()
}

function applySearch() {
  var needle = $('search').value.trim().toLowerCase()
  var rows = $('booklist').children
  for (var i = 0; i < rows.length; i++) {
    var haystack = rows[i].getAttribute('data-search') || ''
    rows[i].style.display = !needle || haystack.indexOf(needle) !== -1 ? '' : 'none'
  }
}

function updateSelectionBar() {
  var count = selected.size
  $('sel-count').textContent = count + ' selected'
  var busy = !!state.busy
  // A named model means OpenAI reads the pages, so it needs a key even when
  // this machine could have done it locally.
  var needsKey = !state.localOcr || !!state.model
  $('export-btn').disabled = !count || busy || (needsKey && !state.hasApiKey)
  $('export-btn').textContent = busy && state.busy === 'export'
    ? 'Exporting…'
    : 'Export ' + (count || '') + (count === 1 ? ' book' : ' books')
  if (needsKey && !state.hasApiKey && count) {
    $('library-msg').textContent = 'Save an OpenAI API key in step 1 first.'
  }
}

function renderJob() {
  var job = state.job
  $('card-job').hidden = !job
  if (!job) return

  var running = job.state === 'running'
  var anyCapturing = job.books.some(function (b) {
    return b.status === 'capturing' || b.status === 'working'
  })
  $('chrome-notice').hidden = !(running && anyCapturing)

  var holder = $('job-books')
  holder.textContent = ''
  job.books.forEach(function (book) { holder.appendChild(jobRow(book, job)) })

  var stop = $('stop-btn')
  stop.hidden = !running
  stop.disabled = job.stopRequested
  stop.textContent = job.stopRequested ? 'Stopping after this book…' : 'Stop after current book'

  var msg = $('job-msg')
  if (job.state === 'done') msg.textContent = 'All done.'
  else if (job.state === 'stopped') msg.textContent = 'Stopped.'
  else msg.textContent = ''

  var log = $('job-log')
  log.textContent = ''
  job.log.forEach(function (entry) {
    var line = el('div', { text: entry.message })
    if (entry.level === 'warn') line.className = 'warn'
    log.appendChild(line)
  })
  if ($('log-details').open) log.scrollTop = log.scrollHeight
}

function jobRow(book, job) {
  var statusPill
  var skipped = job.state !== 'running' && book.status === 'queued'
  if (skipped) statusPill = pill('idle', 'skipped')
  else if (book.status === 'queued') statusPill = pill('idle', 'waiting')
  else if (book.status === 'working') statusPill = pill('busy', 'starting…')
  else if (book.status === 'capturing') statusPill = pill('busy', 'reading pages')
  else if (book.status === 'transcribing') statusPill = pill('busy', 'turning pages into text')
  else if (book.status === 'exporting') statusPill = pill('busy', 'writing file')
  else if (book.status === 'done') statusPill = pill('good', 'done')
  else if (book.status === 'warning') statusPill = pill('warn', 'done, with warnings')
  else statusPill = pill('bad', 'failed')

  var row = el('div', { class: 'jobrow' },
    el('div', { class: 'toprow' },
      el('div', { class: 'title', text: book.title }),
      statusPill))

  if (book.status === 'capturing') {
    var captured = book.captured || 0
    if (book.capturedTotal) {
      row.appendChild(bar(captured / book.capturedTotal))
      row.appendChild(el('div', { class: 'mutedsmall', text: 'page ' + captured + ' of about ' + book.capturedTotal }))
    } else {
      row.appendChild(bar(null))
      if (captured) row.appendChild(el('div', { class: 'mutedsmall', text: captured + ' pages so far' }))
    }
  } else if (book.status === 'transcribing') {
    if (book.transcribedTotal) {
      row.appendChild(bar((book.transcribed || 0) / book.transcribedTotal))
      row.appendChild(el('div', { class: 'mutedsmall', text: (book.transcribed || 0) + ' of ' + book.transcribedTotal + ' pages read' }))
    } else {
      row.appendChild(bar(null))
    }
  } else if (book.status === 'working' || book.status === 'exporting') {
    row.appendChild(bar(null))
  }

  if (book.status === 'done' || book.status === 'warning') {
    var files = el('div', { class: 'filedone' })
    book.outputs.forEach(function (name) {
      if (!/\\.(md|pdf)$/.test(name)) return
      files.appendChild(el('a', {
        class: 'filelink',
        href: '/api/download/' + encodeURIComponent(book.asin) + '/' + encodeURIComponent(name),
        text: '⬇ ' + name
      }))
    })
    if (files.children.length) row.appendChild(files)
  }

  book.warnings.slice(0, 3).forEach(function (warning) {
    row.appendChild(el('div', { class: 'warnnote', text: warning }))
  })
  if (book.error) {
    row.appendChild(el('div', { class: 'errnote', text: book.error }))
  }

  return row
}

function bar(fraction) {
  var wrap = el('div', { class: 'progress' + (fraction === null ? ' indeterminate' : '') })
  var fill = el('div', { class: 'fill' })
  fill.style.width = fraction === null ? '30%' : Math.round(Math.min(1, fraction) * 100) + '%'
  wrap.appendChild(fill)
  return wrap
}

function renderDone() {
  var books = state.diskBooks.filter(function (b) { return b.exports.length })
  $('card-done').hidden = !books.length
  if (!books.length) return

  $('done-hint').textContent = 'Saved under ' + state.outDir

  var holder = $('done-list')
  holder.textContent = ''
  books.forEach(function (book) {
    var row = el('div', { class: 'jobrow' },
      el('div', { class: 'toprow' },
        el('div', { class: 'title', text: book.title || book.asin }),
        (book.incompleteCapture && book.incompleteCapture.length) ||
        book.transcribedPages < book.capturedPages
          ? pill('warn', 'missing pages')
          : pill('good', 'complete')))

    var files = el('div', { class: 'filedone' })
    book.exports.forEach(function (file) {
      files.appendChild(el('a', {
        class: 'filelink',
        href: '/api/download/' + encodeURIComponent(book.asin) + '/' + encodeURIComponent(file.name),
        text: '⬇ ' + file.name
      }))
    })
    if (state.platform === 'darwin') {
      files.appendChild(el('button', {
        class: 'small',
        text: 'Show in Finder',
        onclick: function () {
          api('/api/reveal', { asin: book.asin }).catch(function (err) { toast(err.message) })
        }
      }))
    }
    row.appendChild(files)

    if (book.incompleteCapture && book.incompleteCapture.length) {
      row.appendChild(el('div', { class: 'warnnote', text: book.incompleteCapture[0] }))
    } else if (book.transcribedPages < book.capturedPages) {
      row.appendChild(el('div', {
        class: 'warnnote',
        text: (book.capturedPages - book.transcribedPages) + ' pages could not be read — export it again to retry them'
      }))
    }

    holder.appendChild(row)
  })
}

// ------------------------------------------------------------------ wiring

$('save-settings').addEventListener('click', function () {
  var body = { model: $('model').value }
  var key = $('api-key').value.trim()
  if (key) body.apiKey = key
  $('settings-msg').textContent = 'Saving…'
  api('/api/config', body).then(function () {
    $('api-key').value = ''
    modelTouched = false
    $('settings-msg').textContent = 'Saved.'
    setTimeout(function () { $('settings-msg').textContent = '' }, 3000)
  }).catch(function (err) {
    $('settings-msg').textContent = ''
    toast(err.message)
  })
})
$('model').addEventListener('input', function () { modelTouched = true })

$('login-btn').addEventListener('click', function () {
  api('/api/login').catch(function (err) { toast(err.message) })
})

$('load-library').addEventListener('click', function () {
  api('/api/library').catch(function (err) { toast(err.message) })
})

$('search').addEventListener('input', applySearch)

$('export-btn').addEventListener('click', function () {
  var formats = []
  if ($('fmt-md').checked) formats.push('md')
  if ($('fmt-pdf').checked) formats.push('pdf')
  if (!formats.length) { toast('Pick at least one format.'); return }
  api('/api/export', { asins: Array.from(selected), formats: formats })
    .catch(function (err) { toast(err.message) })
})

$('stop-btn').addEventListener('click', function () {
  api('/api/job/stop').catch(function (err) { toast(err.message) })
})

var events = new EventSource('/api/events')
events.onmessage = function (event) {
  state = JSON.parse(event.data)
  render()
}

fetch('/api/state?scan=1').then(function (res) { return res.json() }).then(function (data) {
  state = data
  render()
})
</script>
</body>
</html>
`
