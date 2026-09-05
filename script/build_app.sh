#!/bin/bash
set -Eeuo pipefail

readonly APP_NAME="reunote"
readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly APP_BUNDLE="$PROJECT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
readonly OUTPUT_BUNDLE="$PROJECT_DIR/output/$APP_NAME.app"

cd "$PROJECT_DIR"
npx tauri build "$@"

if [[ -d "$APP_BUNDLE" ]]; then
  /bin/cp "$PROJECT_DIR/src-tauri/PkgInfo" "$APP_BUNDLE/Contents/PkgInfo"
  /usr/bin/plutil -remove LSRequiresCarbon "$APP_BUNDLE/Contents/Info.plist" >/dev/null 2>&1 || true
  /usr/bin/codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null
  /usr/bin/ditto "$APP_BUNDLE" "$OUTPUT_BUNDLE"
  /usr/bin/codesign --force --deep --sign - "$OUTPUT_BUNDLE" >/dev/null
fi
