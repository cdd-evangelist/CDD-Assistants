---
status: complete
layer: specification
---

# テストルール自己学習システム設計書

更新日: 2026-05-09

## 1. 概要

Test Agent が生成するテストコードには、テストフレームワーク固有の記法ルール（例: vitest × CJS モジュールの mock パターン）を誤ることがある。ルールをプロンプトに静的に埋め込むと、Builder が扱う全スタックを網羅できない上にメンテナンスコストが高い。

本機能は以下の 2 層で対応する:

1. **ルール注入** — `tech_stack.test` でフレームワークを検出し、蓄積済みルールを Test Agent プロンプトに動的注入する
2. **自己学習** — テスト失敗→リカバリーの遷移時に、エラー出力とテンプレートを照合してルールを蒸留・追記する

初期ルールのないフレームワークは初回失敗を許容し、リカバリーによって自然にナレッジが蓄積される。

## 2. 構成要素

### 2.1 バウンダリ（外部との接点）

| バウンダリ | 内容 |
|---|---|
| **グローバルルールストア** | `~/.cdd/test-rules/{framework}.jsonl` — インストールされた Builder を使う全プロジェクトで共有 |
| **プロジェクトルールストア** | `{project_dir}/docs/4-ref/test-rules/{framework}.jsonl` — プロジェクト固有ルール |
| **初期テンプレート** | Builder ソース同梱の `src/test-rules/templates.ts` — ルール化すべき既知パターンの定義 |
| **Test Agent プロンプト** | `buildTestAgentPrompt()` — ルール注入先 |
| **チャンク実行状態** | `execution-state.json` の `chunkState.error` — リカバリー検出に使う前回エラー |

### 2.2 エンティティ（扱うデータ）

**RuleTemplate（テンプレート定義）**

```typescript
interface RuleTemplate {
  id: string              // 'mock-cjs-default' 等
  framework: string       // 'vitest' | 'jest' | 'pytest' | ...
  scope: 'global' | 'project'
  error_pattern: string   // テスト失敗出力に対する regex
  description: string     // テンプレートの説明
  rule_template: string   // {{package}} 等のプレースホルダあり
  example_before?: string
  example_after?: string
}
```

**StoredRule（蓄積済みルール）**

```typescript
interface StoredRule {
  id: string              // uuid
  template_id: string     // どのテンプレートから生成されたか
  framework: string
  rule: string            // プレースホルダ解決済みのルール文
  example_before?: string
  example_after?: string
  created_at: string      // ISO 8601
}
```

### 2.3 コントローラー（主要な処理）

| コントローラー | 処理内容 |
|---|---|
| **ルールストア** | グローバル・プロジェクトからのルール読み込み、新ルールの追記 |
| **ルール抽出器** | エラー出力とテンプレートの照合、`StoredRule` の生成 |
| **プロンプトビルダー** | フレームワーク検出 + ルール注入 |
| **リカバリー検出器** | チャンク状態遷移（failed→done）でのルール蒸留トリガー |

## 3. 初期テンプレート

`src/test-rules/templates.ts` に同梱し、インストール直後から有効。

| id | framework | error_pattern（概要） | scope |
|---|---|---|---|
| `mock-cjs-default` | vitest | `No "default" export is defined on the .* mock` | global |
| `mock-hoisting` | vitest | `hoisting` / `vi.mock.*outside` 系 | global |

テンプレートの追加は手動運用（LLM がテンプレート自体を自動生成しない）。未知パターンはリカバリー検出でマッチせずスキップされ、初回失敗として許容される。

## 4. ルール注入フロー

```
buildTestAgentPrompt(chunk, recipe)
  │
  ├─ tech_stack.test でフレームワーク検出（例: 'vitest'）
  │
  ├─ loadRules(framework, projectDir)
  │    ├─ グローバル: ~/.cdd/test-rules/vitest.jsonl
  │    └─ プロジェクト: {project_dir}/docs/4-ref/test-rules/vitest.jsonl
  │    （両方をマージ、重複は id で排除）
  │
  └─ ルールあり → プロンプト末尾に追記
       ## テストフレームワーク固有ルール (vitest)
       - web-push を default import する場合、vi.mock は { default: {...} } でラップする
         Bad:  vi.mock('web-push', () => ({ fn: vi.fn() }))
         Good: vi.mock('web-push', () => ({ default: { fn: vi.fn() } }))
```

ルールなし（初回）の場合はセクションを追加せずプロンプトをそのまま返す。

## 5. リカバリー検出とルール蒸留

`complete_chunk` がチャンクを `done` に遷移させる際、以下を実行する:

```
complete_chunk() でチャンク完了
  │
  ├─ retry_count > 0 かつ last_error あり
  │    → リカバリーが発生したとみなす
  │
  ├─ matchErrorToTemplate(last_error, framework)
  │    → templates を走査して error_pattern の regex マッチ
  │
  ├─ マッチあり
  │    instantiateRule(template, errorContext) で StoredRule を生成
  │    → template.scope に応じて appendRule()
  │         global → ~/.cdd/test-rules/{fw}.jsonl
  │         project → {project_dir}/docs/4-ref/test-rules/{fw}.jsonl
  │
  └─ マッチなし → スキップ（初回失敗として許容）
```

ルールの重複追記は `template_id` で検出して防ぐ（同テンプレートからのルールは 1 件のみ保持）。

## 6. チャンク実行状態への追加

`chunkState` に `last_error?: string` を追加する。

- チャンク失敗時: `last_error = error` として保存
- チャンク成功時: `last_error` は保持（リカバリー検出のため上書きしない）
- 次回チャンク開始時: `last_error` をクリア

## 7. 設計判断

### なぜテンプレートを「LLM が発明しない」構造にするか

テンプレートマッチングは regex であり、LLM が新テンプレートを自動生成しない。これにより:
- 誤ったルールが蓄積されない（誤検出より見逃しを選ぶ）
- 未知パターンは初回失敗→人が気づく→テンプレート追加という明確なフローになる

### なぜ error_pattern マッチ（regex）にするか

リカバリー内容（テストファイルの diff）から LLM でパターンを蒸留する案と比較して:
- 実装コストが低い
- テスト失敗出力は構造化されていることが多く、regex で十分な精度が出る
- LLM 呼び出しを増やさない（コスト・レイテンシ）

### なぜグローバルとプロジェクトの 2 層にするか

フレームワークレベルのルール（CJS mock パターン等）はプロジェクトをまたいで再利用できる。一方「このプロジェクトは vi.setup.ts でこういう初期化をしている」はプロジェクト固有。スコープをテンプレートが持つことで、蒸留時に LLM が判断しなくてよい。

## 8. 検証方針

- ルールなし状態で Test Agent プロンプトにルールセクションが追加されないこと
- ルールあり状態でプロンプトに正しい形式で注入されること
- `mock-cjs-default` テンプレートが vitest の CJS エラー出力にマッチすること
- リカバリー遷移（retry_count > 0 かつ last_error あり → done）でルールが保存されること
- 重複テンプレートからのルールが 2 件以上蓄積されないこと

## 9. 導入ロードマップ

| フェーズ | 対応内容 |
|---|---|
| v0.1（本書） | テンプレート定義・ルールストア・注入・リカバリー検出の基本実装 |
| v0.2 以降 | テンプレート追加（jest / pytest 等）、プロジェクトルールの UI |

## 関連ドキュメント

- [エージェントプロンプト詳細設計](../3-details/agent-prompts.md)
- [実行フロー](execution-flow.md)
- [テスト品質](test-quality.md)
- [コード規約](coding-standards.md)
- [基本設計](../basic-design.md)
