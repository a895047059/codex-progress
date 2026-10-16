#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=24.18.0
CACHE="$ROOT/work/distribution/node"
mkdir -p "$CACHE"
curl --fail -L --retry 2 --max-time 45 -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/v$VERSION/SHASUMS256.txt"
for arch in arm64 x64; do
  name="node-v$VERSION-darwin-$arch.tar.gz"
  if [ ! -f "$CACHE/$name" ]; then
    curl --fail -L --retry 2 --max-time 180 -o "$CACHE/$name.part" "https://nodejs.org/dist/v$VERSION/$name"
    mv "$CACHE/$name.part" "$CACHE/$name"
  fi
  (cd "$CACHE"; awk -v name="$name" '$2 == name' SHASUMS256.txt > "$name.sha256"; test -s "$name.sha256"; shasum -a 256 -c "$name.sha256")
  tar -xzf "$CACHE/$name" -C "$CACHE"
done
