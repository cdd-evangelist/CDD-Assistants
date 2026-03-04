---
status: complete
layer: foundation
last_reviewed: 2026-03-01
decisions:
  - DEC-001
  - DEC-003
open_questions: []
---
# 基本設計

## 1. 概要

TypeScript と Node.js で実装する。
データベースは SQLite (better-sqlite3)。

## 2. アーキテクチャ

2エディション構成:
- Git版（完全版）
- Lite版（SQLite のみ）

両版とも ghost.db を共通データアクセス層として使用。

## 3. データベース

### テーブル定義

- `episodes` テーブル
- `entities` テーブル
- `tags` テーブル

参照: [[mcp-tools]] [[ai-usecases]]
