# CDD-Assistants

## Environment

- 開発環境: WSL2 / macOS / Linux（setup.sh は bash 前提）
- このリポジトリの Code Style は CDD-Assistants 自体の開発に適用される
- Builder が生成するコードの言語・プラットフォームは設計文書の tech_stack で決まる（ここでは制約しない）

## Build & Test

- セットアップ: `./setup.sh` (all | planner | builder)
- Planner ビルド: `cd planner && npm run build`
- Builder ビルド: `cd builder && npm run build`
- 全テスト実行: `npx vitest run`（ルートディレクトリから）
- 個別テスト: `npx vitest run planner/tests/clarify-idea.test.ts`

## Architecture

- `planner/` — 設計壁打ち支援 MCP サーバー（6ツール）
- `builder/` — 設計→実装レシピ→実行エンジン MCP サーバー（8ツール）
- `docs/` — 設計文書・ロードマップ・リファレンス

## Code Style

- TypeScript, ESM (`"type": "module"`)
- 2スペースインデント
- テストフレームワーク: vitest
- 設計文書・コメント・テスト名は日本語

## Design Docs

- 設計変更時は対応する `docs/*-design.md` も更新すること
- 実装と設計の乖離はラウンドトリップ検証で検出する（docs/ref/ 参照）
