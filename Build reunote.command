#!/bin/bash
# reunote — macOS 一键构建脚本
# 双击本文件即可生成通用（Apple Silicon + Intel）DMG 安装包。
set -Eeuo pipefail

readonly APP_NAME="reunote"
readonly APP_VERSION="1.0.0"
readonly RUST_TOOLCHAIN="1.95"
readonly NODE_MAJOR="20"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
TOOLS_DIR="$SCRIPT_DIR/.build-tools"
OUTPUT_DIR="$SCRIPT_DIR/output"
FINAL_DMG="$OUTPUT_DIR/reunote-v${APP_VERSION}-macOS-universal.dmg"

finish() {
  local status="$1"
  trap - EXIT
  echo
  if [[ "$status" -eq 0 ]]; then
    echo "✅ 构建完成"
    echo "   DMG：$FINAL_DMG"
  else
    echo "❌ 构建失败（退出码 ${status}）" >&2
    echo "   请把上面的报错信息完整发给开发者。" >&2
  fi
  if [[ -t 0 ]]; then
    echo
    read -r -p "按回车键关闭窗口…" _ || true
  fi
  exit "$status"
}
trap 'finish $?' EXIT

log() { echo; echo "==> $*"; }
fail() { echo "错误：$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "本脚本只能在 macOS 上运行。"

cd "$SCRIPT_DIR"
mkdir -p "$TOOLS_DIR" "$OUTPUT_DIR"

log "检查 Apple 命令行工具"
if ! xcode-select -p >/dev/null 2>&1; then
  echo "需要先安装 Apple Command Line Tools，安装窗口即将弹出。"
  echo "装完之后请重新运行本文件。"
  xcode-select --install >/dev/null 2>&1 || true
  exit 1
fi
for tool in codesign curl diskutil ditto hdiutil lipo osascript otool plutil screencapture shasum sips tar xcrun; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少系统工具：$tool"
done

log "检查 Node.js"
if ! command -v node >/dev/null 2>&1 || \
   ! node -e "process.exit(parseInt(process.versions.node) >= ${NODE_MAJOR} ? 0 : 1)" >/dev/null 2>&1; then
  fail "需要 Node.js ${NODE_MAJOR} 或更高版本。请到 https://nodejs.org 安装后重试。"
fi
echo "Node $(node --version)"

log "准备 Rust 工具链（安装到项目内，不污染系统）"
export CARGO_HOME="${CARGO_HOME_OVERRIDE:-$TOOLS_DIR/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME_OVERRIDE:-$TOOLS_DIR/rustup}"
export PATH="$CARGO_HOME/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  echo "正在下载 rustup…"
  curl -fsSL --proto '=https' --tlsv1.2 https://sh.rustup.rs -o "$TOOLS_DIR/rustup-init.sh"
  sh "$TOOLS_DIR/rustup-init.sh" -y --no-modify-path --profile minimal \
    --default-toolchain "$RUST_TOOLCHAIN"
fi
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal >/dev/null
rustup target add aarch64-apple-darwin x86_64-apple-darwin --toolchain "$RUST_TOOLCHAIN" >/dev/null
CARGO_BIN="$(rustup which --toolchain "$RUST_TOOLCHAIN" cargo)"
export PATH="$(dirname "$CARGO_BIN"):$PATH"
echo "$(cargo --version)"

log "按锁文件安装前端依赖"
npm ci --no-audit --no-fund

log "生成应用图标"
if [[ ! -f src-tauri/icons/icon.icns ]]; then
  if command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" >/dev/null 2>&1; then
    python3 scripts/make_icons.py
  else
    echo "跳过（未安装 Pillow），将使用仓库内已有图标。"
  fi
fi

log "生成 DMG 安装背景"
xcrun swift scripts/make_dmg_background.swift

log "运行测试与类型检查"
npm test
npm run typecheck
cargo test --locked --manifest-path src-tauri/Cargo.toml

log "构建通用 App 与 DMG（首次编译约需 5–15 分钟）"
npx tauri build --target universal-apple-darwin -- --locked

BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
BUILT_DMG="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' -print -quit 2>/dev/null || true)"
BUILT_APP="$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"

[[ -n "$BUILT_DMG" ]] || fail "没有找到生成的 DMG。"
[[ -n "$BUILT_APP" ]] || fail "没有找到生成的 App。"

log "整理产物"
TMP_DMG="$OUTPUT_DIR/.reunote-v${APP_VERSION}-macOS-universal.tmp.dmg"
TMP_APP="$OUTPUT_DIR/.${APP_NAME}.tmp.app"
rm -f "$TMP_DMG"
rm -rf "$TMP_APP"
cp "$BUILT_DMG" "$TMP_DMG"
ditto "$BUILT_APP" "$TMP_APP"
mv -f "$TMP_DMG" "$FINAL_DMG"
rm -rf "$OUTPUT_DIR/$APP_NAME.app"
mv "$TMP_APP" "$OUTPUT_DIR/$APP_NAME.app"

log "修正 App 元数据并重新签名"
cp "$SCRIPT_DIR/src-tauri/PkgInfo" "$OUTPUT_DIR/$APP_NAME.app/Contents/PkgInfo"
plutil -remove LSRequiresCarbon "$OUTPUT_DIR/$APP_NAME.app/Contents/Info.plist" 2>/dev/null || true
codesign --force --deep --sign - "$OUTPUT_DIR/$APP_NAME.app"

log "严格校验发布产物"
bash "$SCRIPT_DIR/scripts/verify_macos_release.sh"

ls -lh "$OUTPUT_DIR"
