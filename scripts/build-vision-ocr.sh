#!/bin/sh
# Compile the macOS Vision OCR worker into a universal binary.
#
# Absent on Linux, and absent on Macs without the Xcode command line tools.
# Both are fine: transcription falls back to OpenAI when the binary is missing,
# so this exits 0 either way and never breaks `pnpm build`.
set -eu

OUT="bin/kindle-ocr-macos"
SRC="native/macos-ocr/main.swift"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-vision-ocr: not macOS, skipping (transcription will use OpenAI)"
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-vision-ocr: swiftc not found, skipping."
  echo "  Install the Xcode command line tools for free local OCR:"
  echo "    xcode-select --install"
  exit 0
fi

mkdir -p bin tmp

# macOS 11 covers every Mac that runs a current Chrome; Vision's text
# recognition itself has been available since 10.15.
build_slice() {
  arch="$1"
  swiftc -O -swift-version 5 \
    -target "${arch}-apple-macos11.0" \
    -o "tmp/kindle-ocr-${arch}" \
    "$SRC"
}

slices=""
for arch in arm64 x86_64; do
  if build_slice "$arch" 2>/dev/null; then
    slices="$slices tmp/kindle-ocr-${arch}"
  else
    echo "build-vision-ocr: no SDK for ${arch}, skipping that slice"
  fi
done

if [ -z "$slices" ]; then
  echo "build-vision-ocr: no slices built, skipping (transcription will use OpenAI)"
  exit 0
fi

# shellcheck disable=SC2086
lipo -create $slices -output "$OUT"
chmod +x "$OUT"
rm -f $slices

echo "build-vision-ocr: wrote $OUT ($(lipo -archs "$OUT"))"
