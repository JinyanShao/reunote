#!/bin/bash
set -Eeuo pipefail

readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly OUTPUT_DIR="$PROJECT_DIR/output"
readonly APP_PATH="$OUTPUT_DIR/reunote.app"
readonly DMG_PATH="$OUTPUT_DIR/reunote-v1.0.0-macOS-universal.dmg"
readonly BINARY_PATH="$APP_PATH/Contents/MacOS/reunote"
readonly BACKGROUND_NAME="dmg-background.png"
readonly FINDER_EVIDENCE_PATH="$OUTPUT_DIR/reunote-v1.0.0-DMG-Finder.png"

fail() {
  echo "发布校验失败：$*" >&2
  exit 1
}

[[ -d "$APP_PATH" ]] || fail "缺少应用包 $APP_PATH"
[[ -f "$DMG_PATH" ]] || fail "缺少安装包 $DMG_PATH"
[[ -x "$BINARY_PATH" ]] || fail "缺少主程序 $BINARY_PATH"

ARCHS="$(lipo -archs "$BINARY_PATH")"
read -r -a ARCH_LIST <<< "$ARCHS"
[[ "${#ARCH_LIST[@]}" -eq 2 ]] || fail "架构数量不是 2：$ARCHS"
for REQUIRED_ARCH in arm64 x86_64; do
  [[ " $ARCHS " == *" $REQUIRED_ARCH "* ]] || fail "缺少 $REQUIRED_ARCH：$ARCHS"
done
echo "架构：$ARCHS"

TMP_DIR="$(mktemp -d /tmp/reunote-release.XXXXXX)"
[[ "$TMP_DIR" == /tmp/reunote-release.* ]] || fail "临时目录不安全：$TMP_DIR"
MOUNT_DIR="$TMP_DIR/mount"
mkdir -p "$MOUNT_DIR"
ATTACHED=0
FINDER_WINDOW_OPEN=0
cleanup() {
  if [[ "$FINDER_WINDOW_OPEN" -eq 1 ]]; then
    osascript - "$MOUNT_DIR" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
  set mountAlias to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    set targetDisk to disk of mountAlias
    close container window of targetDisk
  end tell
end run
APPLESCRIPT
  fi
  if [[ "$ATTACHED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

for ARCH in arm64 x86_64; do
  THIN_BINARY="$TMP_DIR/reunote-$ARCH"
  lipo "$BINARY_PATH" -thin "$ARCH" -output "$THIN_BINARY"
  MIN_OS="$(otool -l "$THIN_BINARY" | awk '
    /LC_BUILD_VERSION/ { build = 1; next }
    build && $1 == "minos" { print $2; exit }
    /LC_VERSION_MIN_MACOSX/ { legacy = 1; next }
    legacy && $1 == "version" { print $2; exit }
  ')"
  [[ "$MIN_OS" == 13.* ]] || fail "$ARCH 的最低系统不是 macOS 13：${MIN_OS:-未知}"
  echo "$ARCH 最低系统：macOS $MIN_OS"
done

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dvvv --entitlements :- "$APP_PATH" 2>&1

if spctl -a -vv "$APP_PATH" 2>&1; then
  echo "Gatekeeper：已接受"
else
  echo "Gatekeeper：当前为本地 ad-hoc 构建，未使用 Developer ID，也未公证。"
fi

hdiutil verify "$DMG_PATH"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null
ATTACHED=1

[[ -d "$MOUNT_DIR/reunote.app" ]] || fail "DMG 内缺少应用包"
[[ -L "$MOUNT_DIR/Applications" ]] || fail "DMG 内缺少 Applications 链接"
[[ "$(readlink "$MOUNT_DIR/Applications")" == "/Applications" ]] || fail "Applications 链接目标错误"
BACKGROUND_PATH="$MOUNT_DIR/.background/$BACKGROUND_NAME"
[[ -f "$BACKGROUND_PATH" ]] || fail "DMG 内缺少指定背景：.background/$BACKGROUND_NAME"
BACKGROUND_WIDTH="$(sips -g pixelWidth "$BACKGROUND_PATH" 2>/dev/null | awk '/pixelWidth/ { print $2 }')"
BACKGROUND_HEIGHT="$(sips -g pixelHeight "$BACKGROUND_PATH" 2>/dev/null | awk '/pixelHeight/ { print $2 }')"
[[ "$BACKGROUND_WIDTH" == "660" && "$BACKGROUND_HEIGHT" == "420" ]] || \
  fail "DMG 背景尺寸错误：${BACKGROUND_WIDTH:-?}x${BACKGROUND_HEIGHT:-?}，预期 660x420"
[[ -f "$MOUNT_DIR/.DS_Store" ]] || fail "DMG 缺少 Finder 布局数据"
if ! strings "$MOUNT_DIR/.DS_Store" | grep -Fqx "$BACKGROUND_NAME"; then
  fail "Finder 布局未引用指定背景：$BACKGROUND_NAME"
fi
if ! strings "$MOUNT_DIR/.DS_Store" | grep -Fq "/.background/$BACKGROUND_NAME"; then
  fail "Finder 布局未引用 .background/$BACKGROUND_NAME"
fi

FINDER_WINDOW_OPEN=1
LAYOUT_INFO="$(osascript - "$MOUNT_DIR" "reunote.app" "Applications" <<'APPLESCRIPT'
on run argv
  set mountPath to item 1 of argv
  set appName to item 2 of argv
  set applicationsName to item 3 of argv
  set mountAlias to POSIX file mountPath as alias
  tell application "Finder"
    activate
    set targetDisk to disk of mountAlias
    tell targetDisk
      open
      delay 1
      set diskWindow to container window
      set current view of diskWindow to icon view
      delay 1
      set appPosition to position of item appName
      set applicationsPosition to position of item applicationsName
      set windowBounds to bounds of diskWindow
      return (item 1 of appPosition as string) & "," & (item 2 of appPosition as string) & "|" & (item 1 of applicationsPosition as string) & "," & (item 2 of applicationsPosition as string) & "|" & (item 1 of windowBounds as string) & "," & (item 2 of windowBounds as string) & "," & (item 3 of windowBounds as string) & "," & (item 4 of windowBounds as string)
    end tell
  end tell
end run
APPLESCRIPT
)" || fail "无法读取 Finder 实际布局"
IFS='|' read -r APP_POSITION APPLICATIONS_POSITION WINDOW_BOUNDS <<< "$LAYOUT_INFO"
[[ "$APP_POSITION" == "180,210" ]] || fail "App 图标位置错误：$APP_POSITION"
[[ "$APPLICATIONS_POSITION" == "480,210" ]] || fail "Applications 图标位置错误：$APPLICATIONS_POSITION"
IFS=',' read -r WINDOW_LEFT WINDOW_TOP WINDOW_RIGHT WINDOW_BOTTOM <<< "$WINDOW_BOUNDS"
WINDOW_WIDTH=$((WINDOW_RIGHT - WINDOW_LEFT))
WINDOW_HEIGHT=$((WINDOW_BOTTOM - WINDOW_TOP))
[[ "$WINDOW_WIDTH" -gt 0 && "$WINDOW_HEIGHT" -gt 0 ]] || fail "Finder 窗口尺寸无效：$WINDOW_BOUNDS"
screencapture -x -R"$WINDOW_LEFT,$WINDOW_TOP,$WINDOW_WIDTH,$WINDOW_HEIGHT" "$FINDER_EVIDENCE_PATH"
[[ -s "$FINDER_EVIDENCE_PATH" ]] || fail "未能保存 Finder 视觉检查证据"
echo "Finder 布局：背景 ${BACKGROUND_NAME}（.DS_Store 已引用），App ${APP_POSITION}，Applications ${APPLICATIONS_POSITION}"
echo "Finder 视觉证据：$FINDER_EVIDENCE_PATH"

DMG_NAME="$(basename "$DMG_PATH")"
(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256"
  shasum -a 256 -c "$DMG_NAME.sha256"
)

echo "DMG 挂载结构、背景和 SHA-256 校验通过。"
