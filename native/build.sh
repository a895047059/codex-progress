#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$PROJECT_ROOT/Codex Progress.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
SERVER="$RESOURCES/server"
BUILD="$PROJECT_ROOT/work/distribution"
NODE_VERSION="24.18.0"
NODE_CACHE="$BUILD/node"
mkdir -p "$CONTENTS/MacOS" "$SERVER/src" "$SERVER/web" "$RESOURCES/runtime" "$BUILD"
# Supply verified official Node archives via scripts/prepare-runtime.sh first.
for arch in arm64 x64; do
  test -f "$NODE_CACHE/node-v$NODE_VERSION-darwin-$arch/bin/node" || { echo "Run bash scripts/prepare-runtime.sh first" >&2; exit 1; }
done
cp -R "$PROJECT_ROOT/src/." "$SERVER/src/"
cp -R "$PROJECT_ROOT/web/." "$SERVER/web/"
cp "$PROJECT_ROOT/native/assets/CodexProgress.icns" "$RESOURCES/CodexProgress.icns"
xcrun lipo -create "$NODE_CACHE/node-v$NODE_VERSION-darwin-arm64/bin/node" "$NODE_CACHE/node-v$NODE_VERSION-darwin-x64/bin/node" -output "$RESOURCES/runtime/node"
chmod +x "$RESOURCES/runtime/node"
cp "$NODE_CACHE/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$RESOURCES/runtime/NODE-LICENSE"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CodexProgress</string>
<key>CFBundleIdentifier</key><string>local.codex.progress</string>
<key>CFBundleName</key><string>Codex Progress</string>
<key>CFBundleIconFile</key><string>CodexProgress</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>2</string>
<key>CFBundleShortVersionString</key><string>1.1</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
plutil -lint "$CONTENTS/Info.plist"
for arch in arm64 x86_64; do
  xcrun swiftc -target "$arch-apple-macos13.5" -parse-as-library -O -framework AppKit -framework WebKit \
    "$PROJECT_ROOT/native/ComposerBridge.swift" "$PROJECT_ROOT/native/ProgressWebView.swift" \
    "$PROJECT_ROOT/native/NativeEditMenu.swift" "$PROJECT_ROOT/native/RuntimePaths.swift" \
    "$PROJECT_ROOT/native/StatusGridIcon.swift" "$PROJECT_ROOT/native/StatusBorderAnimation.swift" \
    "$PROJECT_ROOT/native/StatusMetricsTitle.swift" "$PROJECT_ROOT/native/ProgressApp.swift" \
    -o "$BUILD/CodexProgress-$arch"
done
xcrun lipo -create "$BUILD/CodexProgress-arm64" "$BUILD/CodexProgress-x86_64" -output "$CONTENTS/MacOS/CodexProgress"
# Local integrity signing. Distribution identity may be supplied by release owner.
codesign --force --sign "${CODEX_PROGRESS_SIGN_IDENTITY:--}" "$RESOURCES/runtime/node"
codesign --force --sign "${CODEX_PROGRESS_SIGN_IDENTITY:--}" "$APP"
codesign --verify --deep --strict "$APP"
echo "Built Universal macOS 13.5+: $APP"
