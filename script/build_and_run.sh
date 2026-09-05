#!/bin/bash
set -Eeuo pipefail

readonly APP_NAME="reunote"
readonly PROCESS_NAME="reunote"
readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly APP_BUNDLE="$PROJECT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
readonly MODE="${1:-run}"

stop_existing() {
  /usr/bin/pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
}

normalize_bundle() {
  local bundle="$1"
  /bin/cp "$PROJECT_DIR/src-tauri/PkgInfo" "$bundle/Contents/PkgInfo"
  /usr/bin/plutil -remove LSRequiresCarbon "$bundle/Contents/Info.plist" >/dev/null 2>&1 || true
  /usr/bin/codesign --force --deep --sign - "$bundle" >/dev/null
}

verify_launch() {
  npm run app:build -- --bundles app
  [[ -d "$APP_BUNDLE" ]] || {
    echo "没有找到构建后的应用：$APP_BUNDLE" >&2
    exit 1
  }
  normalize_bundle "$APP_BUNDLE"
  /usr/bin/open -n "$APP_BUNDLE"
  for _ in {1..30}; do
    if /usr/bin/pgrep -x "$PROCESS_NAME" >/dev/null; then
      echo "$APP_NAME 已成功构建并启动。"
      return
    fi
    sleep 0.5
  done
  echo "$APP_NAME 未能在 15 秒内启动。" >&2
  exit 1
}

cd "$PROJECT_DIR"
stop_existing

case "$MODE" in
  run)
    exec npm run app:dev
    ;;
  --verify|verify)
    verify_launch
    ;;
  *)
    echo "用法：$0 [run|--verify]" >&2
    exit 2
    ;;
esac
