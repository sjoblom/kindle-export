#!/bin/bash
# Build "Kindle Export.app" — a double-clickable bundle with its own Node
# runtime, so the machine it runs on needs nothing installed but Google Chrome.
#
#   pnpm package
#
# The result is unsigned. Installing it on someone else's Mac means copying it
# to /Applications and right-click → Open once, which you do for them; after
# that it opens like any other app.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.11.0}"
ARCH="${ARCH:-$(uname -m)}"
APP_NAME="Kindle Export"
DIST="dist-app"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"

# NODE_CPU is what npm and pnpm call the same thing, and it is what decides
# which native binaries get staged.
case "$ARCH" in
  arm64) NODE_ARCH="darwin-arm64"; NODE_CPU="arm64" ;;
  x86_64) NODE_ARCH="darwin-x64"; NODE_CPU="x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "package-app: macOS only." >&2
  exit 1
fi

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }

say "Building TypeScript and the OCR binary"
pnpm build

if [ ! -x bin/kindle-ocr-macos ]; then
  echo "package-app: bin/kindle-ocr-macos is missing." >&2
  echo "  Install the Xcode command line tools and re-run:" >&2
  echo "    xcode-select --install" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$CONTENTS/MacOS" "$RES/app"

say "Staging production dependencies for $NODE_ARCH"
# A fresh install rather than a copy of node_modules: the dev tree carries
# hundreds of megabytes this app never runs. From the lockfile, because what
# ships has to be the versions that were tested, not whatever the ranges
# resolve to today.
cp package.json pnpm-lock.yaml "$RES/app/"
# `prepare` installs git hooks and would fail outside a repo. devDependencies
# have to stay in the manifest until after the install — `--prod` leaves them
# on disk anyway, and removing them first makes the lockfile look out of date.
#
# supportedArchitectures is what keeps a cross-architecture bundle honest:
# without it the optional native packages (sharp's, mainly) are chosen for the
# machine doing the building, and an x86_64 bundle built on an arm64 Mac dies
# at module load.
node -e '
  const fs = require("fs")
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
  delete pkg.scripts
  delete pkg.simpleGitHooks
  delete pkg["lint-staged"]
  pkg.pnpm = {
    ...pkg.pnpm,
    supportedArchitectures: { os: ["darwin"], cpu: [process.argv[2]] }
  }
  fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2))
' "$RES/app/package.json" "$NODE_CPU"

# node-linker=hoisted gives a flat node_modules with no symlinks back into this
# checkout, which is the only shape a copied-elsewhere bundle can require from.
# Scripts stay off: none of the runtime dependencies need a build step, and
# Playwright's postinstall would pull a Chromium the app never uses.
(cd "$RES/app" && pnpm install --prod --frozen-lockfile --ignore-scripts \
  --config.node-linker=hoisted)

# From here on the bundle only needs the runtime manifest.
node -e '
  const fs = require("fs")
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  delete pkg.devDependencies
  delete pkg.pnpm
  fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2))
' "$RES/app/package.json"
rm -f "$RES/app/pnpm-lock.yaml"

cp -R dist "$RES/app/dist"
mkdir -p "$RES/app/bin"
cp bin/kindle-ocr-macos "$RES/app/bin/"

say "Fetching Node $NODE_VERSION ($NODE_ARCH)"
NODE_TARBALL="node-v$NODE_VERSION-$NODE_ARCH"
CACHE="${TMPDIR:-/tmp}/kindle-export-node"
mkdir -p "$CACHE"
if [ ! -d "$CACHE/$NODE_TARBALL" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL.tar.gz" \
    | tar xz -C "$CACHE"
fi
mkdir -p "$RES/node/bin"
cp "$CACHE/$NODE_TARBALL/bin/node" "$RES/node/bin/node"

say "Compiling the launcher"
swiftc -O -swift-version 5 \
  -target "$ARCH-apple-macos11.0" \
  -o "$CONTENTS/MacOS/$APP_NAME" \
  native/launcher/main.swift

say "Writing Info.plist"
VERSION="$(node -p 'require("./package.json").version')"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.kindle-export.app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

say "Drawing an icon"
# Nice to have, not worth failing the build over.
if ! sh scripts/make-icon.sh "$RES/icon.icns" 2>/dev/null; then
  echo "  (skipped — the app will use the generic icon)"
fi

# Ad-hoc signing keeps macOS from killing the bundle outright on Apple Silicon;
# it is not notarisation, so first launch still needs right-click → Open.
say "Signing ad-hoc"
codesign --force --deep --sign - "$APP" 2>/dev/null || \
  echo "  (codesign unavailable — first launch may need right-click → Open)"

say "Smoke-testing the bundle"
HOST_ARCH="$(uname -m)"
if [ "$ARCH" = "$HOST_ARCH" ]; then
  # Run the staged app the way the launcher will: the bundled Node, not the
  # one on PATH, against the staged node_modules.
  NODE_BIN="$(cd "$RES/node/bin" && pwd)/node"
  APP_DIR="$(cd "$RES/app" && pwd)"
  echo "  bundled node    $("$NODE_BIN" --version)"
  echo "  kindle-export   $("$NODE_BIN" "$APP_DIR/dist/cli.js" --version)"
  # sharp is the only dependency with a native binary, so it is the one that
  # catches a bundle staged for the wrong CPU.
  (cd "$APP_DIR" && "$NODE_BIN" -e 'require("sharp")' && echo "  sharp           loads")
else
  echo "  (skipped: this is an $ARCH bundle on a $HOST_ARCH Mac, so neither the"
  echo "   bundled node nor its native modules can run here)"
fi

SIZE="$(du -sh "$APP" | cut -f1)"
say "Built $APP ($SIZE)"
echo
echo "To install on another Mac:"
echo "  1. Copy \"$APP_NAME.app\" to that Mac's /Applications folder"
echo "  2. Right-click it → Open → Open (once, because it isn't notarised)"
echo "  3. After that it opens with a normal double-click"
echo
echo "It needs Google Chrome installed. Books are written to"
echo "  ~/Documents/Kindle Export"
