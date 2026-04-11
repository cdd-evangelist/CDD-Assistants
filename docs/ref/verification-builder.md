# ラウンドトリップ検証結果: CDD-Builder

- 検証日時: 2026-03-08
- 設計文書: docs/builder-design.md
- リファレンス: docs/ref/builder-reference.md

## 判定: OK（要更新は全件反映済み）

致命的な乖離はなく、設計意図は正しく実装に反映されている。
当初「要更新」だった6件は全て設計文書に反映済み（2026-03-08）。

## 乖離一覧

| # | 重み | 分類 | 内容 | 対応 |
|---|------|------|------|------|
| 1 | 要更新 | 機能の部分実装 | `validate_refs` は設計書の5チェック項目中3つのみ実装（テーブル名不一致・フロー図カバレッジ・ポリシー設定漏れが未実装） | **反映済み** §3.3 にv0.1実装状況を注記 |
| 2 | 要更新 | 設計の進化 | `split_chunks` の `expected_outputs` は空配列、`completion_criteria` は `['テストが通る']` 固定。`needs_review: true` + 固定3項目の `review_notes` で人のレビューを前提とする設計に進化 | **反映済み** §3.2 出力例を更新 |
| 3 | 要更新 | 出力スキーマ差異 | `DraftChunk` 中間型（`implementation_prompt_template` を持ち `source_content` なし）が設計書に未記載。split_chunks→export_recipe の変換パイプラインの要 | **反映済み** §3.2 に DraftChunk の説明を追加 |
| 4 | 要更新 | 出力スキーマ差異 | `execution-state.json` のファイル名規則が `{recipe}-state.json` だが設計書では固定名で記載 | **反映済み** §4.1 を更新 |
| 5 | 要更新 | 設計の進化 | `ClaudeCodeExecutor` の具体実装（`listFiles` によるmtime差分検出、`--max-turns 30`、`maxBuffer 10MB`）が設計書に未記載 | **反映済み** §6.2 に実装詳細を追記 |
| 6 | 要更新 | 設計の進化 | `complete_chunk` の `node_modules` 存在チェックとテスト60秒タイムアウトが設計書に未記載 | **反映済み** §4.3 に追記 |
| 7 | 軽微 | 説明の粒度 | `estimateTokens` の具体係数（CJK=2トークン/文字、ASCII=0.25トークン/文字）は設計書では未記載 | 通過 |
| 8 | 軽微 | 説明の粒度 | `extractMarkdownLinks` のインラインコード除外ロジック、レイヤー推定の4段フォールバック詳細はリファレンスの方が詳細 | 通過 |
| 9 | 軽微 | 命名の揺れ | 設計書の `tech_stack` 出力例に `platforms`, `platform_notes`, `directory_structure` があるが、リファレンスの型定義ではこれらは optional | 通過 |

## サマリー

- 致命的: 0件
- 要更新: 6件
- 軽微: 3件
