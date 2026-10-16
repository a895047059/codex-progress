#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/work/distribution/package"
OUTPUT="$ROOT/dist/Codex-Progress-1.1-Universal.dmg"
mkdir -p "$STAGE" "$ROOT/dist"
ditto "$ROOT/Codex Progress.app" "$STAGE/Codex Progress.app"
if [ ! -L "$STAGE/Applications" ]; then ln -s /Applications "$STAGE/Applications"; fi
cp "$ROOT/INSTALL.md" "$STAGE/安装说明.md"
codesign --verify --deep --strict "$STAGE/Codex Progress.app"
hdiutil create -volname 'Codex Progress' -srcfolder "$STAGE" -ov -format UDZO "$OUTPUT"
hdiutil verify "$OUTPUT"
(cd "$(dirname "$OUTPUT")"; shasum -a 256 "$(basename "$OUTPUT")") > "$OUTPUT.sha256"
rm "$STAGE/Applications"
rm -r "$STAGE"
echo "Packaged: $OUTPUT"
