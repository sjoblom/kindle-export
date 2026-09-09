#!/bin/sh
# Render an app icon into the .icns the bundle expects. Best effort: the caller
# treats failure as "use the generic icon" rather than a broken build.
set -eu

OUT="${1:?usage: make-icon.sh <path/to/icon.icns>}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SVG="$WORK/icon.svg"
cat > "$SVG" <<'SVGEOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f7a23b"/>
      <stop offset="100%" stop-color="#e0742b"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <g transform="translate(256 232)">
    <rect width="512" height="440" rx="26" fill="#fffaf3"/>
    <rect x="238" y="0" width="36" height="440" fill="#e8dccb"/>
    <g fill="#c9b9a3">
      <rect x="52" y="78" width="150" height="20" rx="10"/>
      <rect x="52" y="140" width="150" height="20" rx="10"/>
      <rect x="52" y="202" width="112" height="20" rx="10"/>
      <rect x="310" y="78" width="150" height="20" rx="10"/>
      <rect x="310" y="140" width="150" height="20" rx="10"/>
      <rect x="310" y="202" width="112" height="20" rx="10"/>
    </g>
    <path d="M256 300 L256 452 M196 396 L256 456 L316 396"
      stroke="#e0742b" stroke-width="46" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
SVGEOF

# sharp ships with the project and renders SVG; qlmanage is the fallback on a
# machine where node_modules isn't installed.
PNG="$WORK/icon.png"
node -e '
  const sharp = require("sharp")
  sharp(process.argv[1]).png().resize(1024, 1024).toFile(process.argv[2])
    .then(() => {}, (err) => { console.error(err.message); process.exit(1) })
' "$SVG" "$PNG"

ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$OUT"
