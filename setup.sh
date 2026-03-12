#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"

usage() {
  echo "使い方: ./setup.sh [all|planner|builder]"
  echo ""
  echo "  all      Planner と Builder の両方をセットアップ（デフォルト）"
  echo "  planner  Planner のみ"
  echo "  builder  Builder のみ"
  exit 1
}

case "$TARGET" in
  all|planner|builder) ;;
  -h|--help) usage ;;
  *) echo "エラー: 不明な引数 '$TARGET'"; echo ""; usage ;;
esac

echo "=== CDD-Assistants セットアップ ==="
echo ""

# Node.js チェック
if ! command -v node &> /dev/null; then
  echo "エラー: Node.js が見つかりません。Node.js 18 以上をインストールしてください。"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "エラー: Node.js 18 以上が必要です（現在: $(node -v)）"
  exit 1
fi

echo "Node.js $(node -v) を検出"
echo ""

INSTALLED_PLANNER=false
INSTALLED_BUILDER=false

# Planner
if [ "$TARGET" = "all" ] || [ "$TARGET" = "planner" ]; then
  echo "--- Planner ---"
  cd "$SCRIPT_DIR/planner"
  npm install
  npm run build
  echo "Planner: ビルド完了"
  echo ""
  INSTALLED_PLANNER=true
fi

# Builder
if [ "$TARGET" = "all" ] || [ "$TARGET" = "builder" ]; then
  echo "--- Builder ---"
  cd "$SCRIPT_DIR/builder"
  npm install
  npm run build
  echo "Builder: ビルド完了"
  echo ""
  INSTALLED_BUILDER=true
fi

# MCP 設定の案内
echo "=== セットアップ完了 ==="
echo ""
echo "Claude Code で使うには、~/.claude/settings.json に以下を追加してください:"
echo ""
echo '{'
echo '  "mcpServers": {'

if [ "$INSTALLED_PLANNER" = true ]; then
  PLANNER_PATH="$SCRIPT_DIR/planner/dist/index.js"
  if [ "$INSTALLED_BUILDER" = true ]; then
    echo '    "cdd-planner": {'
    echo "      \"command\": \"node\","
    echo "      \"args\": [\"$PLANNER_PATH\"]"
    echo '    },'
  else
    echo '    "cdd-planner": {'
    echo "      \"command\": \"node\","
    echo "      \"args\": [\"$PLANNER_PATH\"]"
    echo '    }'
  fi
fi

if [ "$INSTALLED_BUILDER" = true ]; then
  BUILDER_PATH="$SCRIPT_DIR/builder/dist/index.js"
  echo '    "cdd-builder": {'
  echo "      \"command\": \"node\","
  echo "      \"args\": [\"$BUILDER_PATH\"]"
  echo '    }'
fi

echo '  }'
echo '}'
