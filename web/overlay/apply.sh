#!/usr/bin/env bash
# 把 overlay/ 里的文件覆盖到 ws-scrcpy-web 源码树上。
# 用法：./apply.sh [ws-scrcpy 源码目录]     默认：./ws-scrcpy
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-./ws-scrcpy}"
BASE_VERSION="0.5.13"

[ -d "$TARGET/src/app" ] || { echo "✗ $TARGET 不像 ws-scrcpy-web 源码目录（缺 src/app）" >&2; exit 1; }

if [ -f "$TARGET/package.json" ]; then
  ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TARGET/package.json" | head -1)
  if [ "$ver" != "$BASE_VERSION" ]; then
    echo "! 基线版本是 $BASE_VERSION，当前 $ver。文件结构若有变化，覆盖后构建可能报错，见 overlay/README.md" >&2
  fi
fi

echo "→ 覆盖到 $TARGET"
( cd "$HERE" && find . -type f ! -name README.md ! -name apply.sh -print0 ) |
  while IFS= read -r -d '' f; do
    mkdir -p "$TARGET/$(dirname "$f")"
    cp -a "$HERE/$f" "$TARGET/$f"
    echo "   $f"
  done

echo
echo "完成。下一步："
echo "  cd $TARGET && npm run build     # 产物在 dist/"
echo "回滚：git -C $TARGET checkout -- . && git -C $TARGET clean -fd"
