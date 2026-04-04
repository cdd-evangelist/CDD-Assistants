#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"
OPTION="${2:-}"

PLANNER_PATH="$SCRIPT_DIR/planner/dist/index.js"
BUILDER_PATH="$SCRIPT_DIR/builder/dist/index.js"
CLAUDE_JSON="$HOME/.claude.json"

usage() {
  echo "使い方: ./setup.sh [all|planner|builder|mcp-install|mcp-uninstall]"
  echo ""
  echo "  all            Planner と Builder の両方をセットアップ（デフォルト）"
  echo "  planner        Planner のみ"
  echo "  builder        Builder のみ"
  echo "  mcp-install    Claude Code に MCP サーバーを登録"
  echo "  mcp-uninstall  Claude Code から MCP サーバーを登録解除"
  echo ""
  echo "オプション:"
  echo "  --all    mcp-install/mcp-uninstall: 全プロジェクトに一括適用"
  exit 1
}

# --- MCP 登録ヘルパー ---

# node -e でJSON操作（Node.js は必須要件なのでそのまま使う）
mcp_install() {
  local install_all="${1:-}"

  # 1) ~/.claude.json にグローバル登録
  #    ※ mcpServers は settings.json ではなく .claude.json に記述する必要がある
  if [ ! -f "$CLAUDE_JSON" ]; then
    echo "エラー: $CLAUDE_JSON が見つかりません。Claude Code を一度起動してください。"
    exit 1
  fi

  node -e "
    const fs = require('fs');
    const path = '$CLAUDE_JSON';
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!data.mcpServers) data.mcpServers = {};
    let changed = false;
    const want = {
      'cdd-planner': { type: 'stdio', command: 'node', args: ['$PLANNER_PATH'], env: {} },
      'cdd-builder': { type: 'stdio', command: 'node', args: ['$BUILDER_PATH'], env: {} },
    };
    for (const [k, v] of Object.entries(want)) {
      const cur = data.mcpServers[k];
      if (!cur || JSON.stringify(cur) !== JSON.stringify(v)) {
        data.mcpServers[k] = v;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
      console.log('.claude.json (global): cdd-planner, cdd-builder を登録しました');
    } else {
      console.log('.claude.json (global): 既に登録済み');
    }
  "

  # 2) .claude.json にプロジェクト別登録
  node -e "
    const fs = require('fs');
    const path = '$CLAUDE_JSON';
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    const projects = data.projects || {};
    const cwd = process.cwd();
    const installAll = '$install_all' === '--all';
    const entry = {
      'cdd-planner': { type: 'stdio', command: 'node', args: ['$PLANNER_PATH'], env: {} },
      'cdd-builder': { type: 'stdio', command: 'node', args: ['$BUILDER_PATH'], env: {} },
    };
    let count = 0;
    const keys = Object.keys(projects);
    if (installAll) {
      for (const pkey of keys) {
        if (!projects[pkey].mcpServers) projects[pkey].mcpServers = {};
        for (const [k, v] of Object.entries(entry)) {
          if (!projects[pkey].mcpServers[k]) {
            projects[pkey].mcpServers[k] = v;
            count++;
          }
        }
      }
      data.projects = projects;
      fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
      console.log('.claude.json: ' + (count > 0 ? count + ' エントリを追加（' + keys.length + ' プロジェクト）' : '全プロジェクト登録済み'));
    } else {
      let matched = null;
      for (const pkey of keys) {
        if (cwd === pkey || cwd.startsWith(pkey + '/') || cwd.startsWith(pkey + '\\\\')) {
          matched = pkey;
          break;
        }
      }
      if (!matched) {
        console.log('.claude.json: カレントディレクトリに一致するプロジェクトがありません（--all で全プロジェクトに登録できます）');
      } else {
        if (!projects[matched].mcpServers) projects[matched].mcpServers = {};
        for (const [k, v] of Object.entries(entry)) {
          if (!projects[matched].mcpServers[k]) {
            projects[matched].mcpServers[k] = v;
            count++;
          }
        }
        data.projects = projects;
        fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
        console.log('.claude.json [' + matched + ']: ' + (count > 0 ? count + ' エントリを追加' : '既に登録済み'));
      }
    }
  "

  echo ""
  echo "登録完了。Claude Code を再起動すると反映されます。"
}

mcp_uninstall() {
  local uninstall_all="${1:-}"

  # 1) ~/.claude.json からグローバル削除
  if [ -f "$CLAUDE_JSON" ]; then
    node -e "
      const fs = require('fs');
      const path = '$CLAUDE_JSON';
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      let changed = false;
      for (const k of ['cdd-planner', 'cdd-builder']) {
        if (data.mcpServers && data.mcpServers[k]) {
          delete data.mcpServers[k];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
        console.log('.claude.json (global): cdd-planner, cdd-builder を削除しました');
      } else {
        console.log('.claude.json (global): 登録なし（スキップ）');
      }
    "
  fi

  # 2) .claude.json からプロジェクト別削除
  if [ ! -f "$CLAUDE_JSON" ]; then
    return
  fi

  node -e "
    const fs = require('fs');
    const path = '$CLAUDE_JSON';
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    const projects = data.projects || {};
    const cwd = process.cwd();
    const uninstallAll = '$uninstall_all' === '--all';
    let count = 0;
    const keys = Object.keys(projects);
    const targets = ['cdd-planner', 'cdd-builder'];
    if (uninstallAll) {
      for (const pkey of keys) {
        if (!projects[pkey].mcpServers) continue;
        for (const k of targets) {
          if (projects[pkey].mcpServers[k]) {
            delete projects[pkey].mcpServers[k];
            count++;
          }
        }
      }
      data.projects = projects;
      fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
      console.log('.claude.json: ' + (count > 0 ? count + ' エントリを削除' : '登録なし'));
    } else {
      let matched = null;
      for (const pkey of keys) {
        if (cwd === pkey || cwd.startsWith(pkey + '/') || cwd.startsWith(pkey + '\\\\')) {
          matched = pkey;
          break;
        }
      }
      if (!matched) {
        console.log('.claude.json: カレントディレクトリに一致するプロジェクトがありません（--all で全プロジェクトから削除できます）');
      } else {
        if (projects[matched].mcpServers) {
          for (const k of targets) {
            if (projects[matched].mcpServers[k]) {
              delete projects[matched].mcpServers[k];
              count++;
            }
          }
        }
        data.projects = projects;
        fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
        console.log('.claude.json [' + matched + ']: ' + (count > 0 ? count + ' エントリを削除' : '登録なし'));
      }
    }
  "

  echo ""
  echo "削除完了。Claude Code を再起動すると反映されます。"
}

case "$TARGET" in
  all|planner|builder) ;;
  mcp-install) mcp_install "$OPTION"; exit 0 ;;
  mcp-uninstall) mcp_uninstall "$OPTION"; exit 0 ;;
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
echo "Claude Code に MCP サーバーを登録するには:"
echo "  ./setup.sh mcp-install        # 現在のプロジェクトに登録"
echo "  ./setup.sh mcp-install --all  # 全プロジェクトに一括登録"
