---
status: draft
layer: detail
---

# エージェントプロンプト詳細設計書

更新日: 2026-04-17

## 1. 概要

Builder が起動する 3 つの実行エージェント（Test Agent / Impl Agent / Investigation Agent）のプロンプトテンプレート仕様を定義する。

各エージェントの振る舞いは LLM に渡すプロンプトで定義される。したがって本書の内容はそのまま実装成果物（TypeScript ソース内のテンプレート文字列、または `src/prompts/` 配下のテンプレートファイル）と 1 対 1 で対応する。

### 1.1 本書の責務

| 本書が定義する | 本書が定義しない |
|---|---|
| 各エージェントへの**プロンプト文（日本語）** | エージェントの振る舞いそのもの（→ execution-flow §4） |
| プロンプトに差し込む**動的変数**の仕様 | 動的変数の**生成ロジック**（→ mcp-tools.md / execution-adapter.md） |
| 期待する**出力フォーマット** | 出力のパース・検証ロジック（→ execution-flow §4 各 Step） |

### 1.2 二層構造（静的 + 動的）

プロンプトは以下の 2 層で組み立てる:

1. **静的部分（テンプレート）** — エージェントの役割・原則・出力フォーマット。チャンクに依存せず、本書で仕様化される
2. **動的部分（チャンク固有情報）** — `source_content`, `test_code`, `expected_outputs` 等。オーケストレーターが `recipe.json` と実行状態ファイル（命名規約: `{recipe_name}-state.json`、例: `recipe-state.json`。詳細は [builder-reference](../4-ref/builder-reference.md) §load_recipe 参照）から組み立てて注入する

## 2. 組み立てルール（共通仕様）

### 2.1 プレースホルダ記法

テンプレート内の動的変数は `{{variable_name}}` で表記する。オーケストレーターが注入時に置換する。

```
## 担当するチャンク
{{chunk_id}}: {{chunk_name}}
```

### 2.2 動的変数の由来

| 由来 | 変数例 |
|---|---|
| `recipe.json` のチャンク定義 | `chunk_id`, `chunk_name`, `source_content`, `implementation_prompt`, `expected_outputs`, `completion_criteria`, `reference_doc_path` |
| `recipe.json` の全体設定 | `coding_standards_digest` |
| 実行状態ファイル | `depends_on_types`（前チャンク出力から抽出） |
| 直前の Step の出力 | `test_code`（Step 1）, `implementation_code`（Step 2）, `verification_result`（Step 3〜4） |

### 2.3 オーケストレーター側の責務

- テンプレートのロード
- チャンク情報・前 Step 出力からの動的変数抽出
- プレースホルダ置換
- 実行アダプタ経由で LLM 呼び出し
- 応答のパース（期待する出力フォーマット §3.4 / §4.5 / §5.4 参照）
- リトライ管理・死活監視・エスカレーション（→ §2.4）

実装場所の想定は §6 を参照。

### 2.4 リトライ上限と死活監視

オーケストレーターは各エージェント呼び出しに対してリトライ回数を管理し、規定上限を超えた場合は人にエスカレーションする。収束しないこと自体が設計の曖昧さを示すシグナルとして扱う（[roundtrip-verification §8](../2-features/roundtrip-verification.md) と整合）。

#### リトライ発生条件

| Step | 対象エージェント | リトライ発生 |
|---|---|---|
| Step 1 | Test Agent | Red 確認 NG（一部 PASS / コンパイルエラー） |
| Step 2 | Impl Agent | Green 確認 NG（一部 FAIL） |
| Step 6 後 | Impl Agent | Investigation 判定「実装の問題」 |
| Step 6 後 | Test Agent | Investigation 判定「テスト不足」 |

#### 上限設定（初期値、`recipe.json` の `retry_limits` で上書き可）

| カウンター | デフォルト | 超過時の挙動 |
|---|---|---|
| Test Agent 個別 | 3 回 | チャンクを `failed` に遷移、`failed` ラベル付与 |
| Impl Agent 個別 | 3 回 | 同上 |
| Investigation Agent 個別 | 2 回 | 同上（同一 verdict が連続発生するケースを想定） |
| チャンク全体の総リトライ | 7 回 | 無限ループ防止の最終ガード |

上限超過時はチャンクに関する Issue に「収束しなかった理由」をコメントし、人または Planner にエスカレーションする。

#### 死活監視（デッドロックパターンの早期検出）

上限を待たずにエスカレーションするパターン:

| パターン | 検出方法 | 挙動 |
|---|---|---|
| 同じ verdict の連続発生 | Investigation が同一判定を 2 回連続出す | 即 `needs_human_decision` ラベル付与（上限を待たない） |
| 応答タイムアウト | エージェント呼び出しが T 秒以上無応答 | アダプタ層でリトライ or キャンセル |
| 空応答・パース失敗 | 期待フォーマットと不一致 | 1 回は再実行、連続発生で `failed` |
| 修正内容が変化しない | 連続するリトライで diff が空 | `failed` で即時停止（同じ結果を繰り返す意味なし） |

#### プロンプトへの反映

各エージェントのプロンプトに `retry_count` / `max_retries` を動的変数として渡してもよい（任意）。エージェントに「これは N 回目の試行」と伝えることで、根本的な再検討を促せる場合がある。デフォルトでは orchestrator 内部状態にとどめ、プロンプトには含めない。

## 3. Test Agent

### 3.1 役割・守るべき原則

- 設計文書と `test_requirements` から**逆算**してテストを書く
- 実装コードは一切見ない（共有バイアスの排除）
- テストは全て FAIL する状態で提出する（Red フェーズの成立）

根拠: [execution-flow §4.1](../2-features/execution-flow.md), [execution-flow §6 設計判断](../2-features/execution-flow.md)

### 3.2 動的変数

| 変数 | 内容 | 由来 |
|---|---|---|
| `chunk_id` | チャンク ID | recipe.json |
| `chunk_name` | チャンク名 | recipe.json |
| `source_content` | 設計文書の該当セクション | recipe.json |
| `test_requirements` | interface_tests / boundary_tests / integration_refs | recipe.json |
| `test_expected_outputs` | 生成すべきテストファイル一覧 | recipe.json（`expected_outputs` からテストファイルを抽出） |
| `depends_on_types` | 依存チャンクの公開インターフェース（型情報のみ） | 実行状態ファイル |

### 3.3 プロンプトテンプレート

```
あなたは Test Agent です。設計文書とテスト要件から逆算してテストコードを書きます。
実装コードは一切見ていません。これは意図的な分離で、共有バイアスを排除するためです。

## 担当するチャンク
{{chunk_id}}: {{chunk_name}}

## 設計文書（該当セクション）
{{source_content}}

## テスト要件
- インターフェーステスト: {{test_requirements.interface_tests}}
- 境界値テスト: {{test_requirements.boundary_tests}}
- 統合ポイント: {{test_requirements.integration_refs}}

## 依存チャンクの公開インターフェース（型のみ、実装は見せていません）
{{depends_on_types}}

## 生成すべきテストファイル
{{test_expected_outputs}}

## 指示
1. 設計仕様から逆算してテストを書いてください
2. 実装はまだ存在しないので、インポートパスは `expected_outputs` から推測してください
3. 全テストが FAIL する状態で提出してください（Red フェーズ）
4. `assert True` のような空テストは書かないでください — 設計要件を必ず検証してください
```

### 3.4 期待する出力

- テストファイル群（`test_expected_outputs` で指定された各パス）
- 生成したテストは **全て FAIL** することを前提とする

### 3.5 失敗時の差し戻しパターン

| 状況 | 差し戻し内容 |
|---|---|
| 一部 PASS | 「空テストまたは実装非依存のテストが含まれている可能性。設計仕様との対応を再確認せよ」 |
| コンパイルエラー | インポートパス・型定義を修正。必要なら実装型情報を追加で渡す |

リトライ回数の管理とエスカレーション条件は [§2.4](#24-リトライ上限と死活監視) を参照。

### 3.6 関連仕様

- 振る舞い: [execution-flow §4.1](../2-features/execution-flow.md)
- Red フェーズの意義: [execution-flow §6](../2-features/execution-flow.md)
- テスト品質ルール: [test-quality.md](../2-features/test-quality.md)

## 4. Impl Agent

### 4.1 役割・守るべき原則

- Test Agent が書いたテストを全て PASS させる実装を書く
- 実装完了後、**コードの事実だけ**からリファレンス（日本語）を生成する
- リファレンス生成時は設計文書・テストを参照しない（自己参照防止）
- コード規約ダイジェストに従う

根拠: [execution-flow §4.2](../2-features/execution-flow.md), [roundtrip-verification §3](../2-features/roundtrip-verification.md), [coding-standards.md](../2-features/coding-standards.md)

### 4.2 動的変数

| 変数 | 内容 | 由来 |
|---|---|---|
| `chunk_id` | チャンク ID | recipe.json |
| `chunk_name` | チャンク名 | recipe.json |
| `implementation_prompt` | プレースホルダ解決済みの実装指示 | recipe.json |
| `test_code` | Step 1 で Test Agent が生成したテスト | 直前 Step の出力 |
| `expected_outputs` | 生成すべきファイル一覧（テスト除く） | recipe.json |
| `completion_criteria` | 完了条件 | recipe.json |
| `coding_standards_digest` | コード規約ダイジェスト | recipe.json の `coding_standards` から生成 |
| `reference_doc_path` | リファレンスの出力先パス | recipe.json |

### 4.3 プロンプトテンプレート

```
あなたは Impl Agent です。Test Agent が書いたテストを全て PASS させる実装を書き、
実装完了後にリファレンス（日本語文書）を生成します。

## 担当するチャンク
{{chunk_id}}: {{chunk_name}}

## 実装プロンプト（設計文書由来）
{{implementation_prompt}}

## 満たすべきテスト
{{test_code}}

## 生成すべきファイル
{{expected_outputs}}

## 完了条件
{{completion_criteria}}

## コード規約
{{coding_standards_digest}}

## 作業手順
1. テストコードを読んで、何を実装すべきか把握する
2. 実装を書く
3. テストを実行して全 PASS を確認する
4. リファレンスを生成する（詳細は下記）

## リファレンス生成指示

実装完了後、{{reference_doc_path}} に以下を日本語で記述してください:

1. モジュール構成の概要（ファイル構成と各モジュールの役割）
2. 公開インターフェース（関数シグネチャ、入力型・出力型）
3. 実装ロジック（処理の流れ、使用アルゴリズム・ヒューリスティクス）
4. 型定義（主要な型とその関係）

**重要な制約**:
- リファレンスは**実装したコードだけを見て書いてください**
- 設計文書やテストを参照しないでください
- 推測を含めないでください（「こうだろう」ではなく「こうなっている」で書く）

この制約はラウンドトリップ検証の前提（自己参照防止）を守るために必須です。
```

### 4.4 リファレンス生成の根拠

[roundtrip-verification §3](../2-features/roundtrip-verification.md) で定義された「作成方針」「生成の担当とタイミング」「フォーマットと含める項目」をそのままプロンプト化している。設計の変更があった場合は roundtrip-verification §3 が正とし、本書のプロンプトテンプレート §4.3 を追従させる。

### 4.5 期待する出力

- `expected_outputs` で指定された実装ファイル群
- `reference_doc_path` に指定された日本語リファレンス
- 全テストが PASS する状態

### 4.6 失敗時の差し戻しパターン

| 状況 | 差し戻し内容 |
|---|---|
| テスト一部 FAIL | FAIL しているテスト名・エラー内容を付加して実装の修正を指示 |
| リファレンス欠落 | リファレンス生成のみ追加指示（実装は維持） |
| リファレンスに設計文書由来の記述 | 「コードの事実だけで書き直せ」と差し戻し（自己参照検出時） |

リトライ回数の管理とエスカレーション条件は [§2.4](#24-リトライ上限と死活監視) を参照。

### 4.7 関連仕様

- 振る舞い: [execution-flow §4.2](../2-features/execution-flow.md)
- リファレンス位置づけ: [roundtrip-verification §3](../2-features/roundtrip-verification.md)
- コード規約注入: [coding-standards.md](../2-features/coding-standards.md)
- 双方向性の意義: [basic-design §1.5](../basic-design.md)

## 5. Investigation Agent

### 5.1 役割・守るべき原則

- ラウンドトリップ照合 NG 時に起動される
- 乖離の真因を「**実装の問題 / 設計の曖昧さ / テスト不足**」のいずれかに分類
- 「実装の問題」と判断しがちな誤判断を避ける（実装デッドロック防止）
- Impl Agent / Test Agent とは別セッションで動く

根拠: [roundtrip-verification §7](../2-features/roundtrip-verification.md), [execution-flow §4.5](../2-features/execution-flow.md)

### 5.2 動的変数

| 変数 | 内容 | 由来 |
|---|---|---|
| `chunk_id` | チャンク ID | recipe.json |
| `chunk_name` | チャンク名 | recipe.json |
| `verification_result` | 照合結果（`verification-{chunk_id}.md` の内容） | 直前 Step の出力 |
| `source_content` | 設計文書の該当セクション | recipe.json |
| `implementation_code` | Step 2 で生成された実装コード | 実行状態ファイル |
| `test_code` | Step 1 で生成されたテストコード | 実行状態ファイル |

### 5.3 プロンプトテンプレート

```
あなたは Investigation Agent です。
ラウンドトリップ照合で検出された乖離の真因を分類し、差し戻し先を決定します。

## 担当チャンク
{{chunk_id}}: {{chunk_name}}

## 照合結果
{{verification_result}}

## 設計文書（該当セクション）
{{source_content}}

## 実装コード
{{implementation_code}}

## テストコード
{{test_code}}

## 判断材料（必ず全てチェックしてください）

1. 設計文書の記述は一意に解釈できるか
   → 複数解釈が可能なら「**設計の曖昧さ**」
2. テストが設計要件を網羅しているか
   → 網羅不足なら「**テスト不足**」
3. 実装が設計に沿っているか
   → 沿っていなければ「**実装の問題**」

## 重要な注意

「実装の問題」と判断しがちな誤判断を避けてください。
設計が曖昧なのに Impl Agent に繰り返し差し戻すと、実装デッドロックが発生します。
「1. 設計の一意性」を最初に評価し、曖昧なら迷わず「設計の曖昧さ」と判定してください。

## 出力フォーマット

以下の JSON で応答してください:

{
  "verdict": "implementation | design_ambiguity | test_insufficient",
  "reason": "判定理由（日本語、2〜3文）",
  "evidence": {
    "spec_location": "設計文書の該当箇所（§番号や引用）",
    "code_location": "実装コードの該当箇所（ファイル:行）",
    "test_location": "テストコードの該当箇所（ファイル:行、該当時のみ）"
  },
  "next_action": "差し戻し先への具体的な指示"
}
```

### 5.4 期待する出力フォーマット

| verdict 値 | 差し戻し先 | 備考 |
|---|---|---|
| `implementation` | Impl Agent | テストは変更しない |
| `design_ambiguity` | 人 / Planner | `needs_human_decision` ラベルを Issue に付与 |
| `test_insufficient` | Test Agent | テスト追加（Step 1 に戻る） |

同じ verdict を連続して 2 回出したら、上限を待たずに人にエスカレーションする（デッドロック検出、[§2.4](#24-リトライ上限と死活監視) 参照）。

### 5.5 関連仕様

- 詳細仕様: [roundtrip-verification §7](../2-features/roundtrip-verification.md)
- フロー上の位置: [execution-flow §4.5〜§4.6](../2-features/execution-flow.md)
- 分離の設計判断: [roundtrip-verification §9](../2-features/roundtrip-verification.md)

## 6. 実装対応

### 6.1 想定ファイル構成

```
builder/src/
├── prompts/                          # §3.3 / §4.3 / §5.3 のテンプレート本体
│   ├── test-agent.md
│   ├── impl-agent.md
│   └── investigation-agent.md
│
├── execution-engine/
│   ├── prompt-builder.ts             # テンプレート読み込み + 動的変数注入
│   └── agent-output-parser.ts        # 応答パース（§3.4 / §4.5 / §5.4）
│
└── adapters/
    ├── claude-code.ts                # Task サブエージェントで起動
    └── local-llm.ts                  # ローカル LLM 経由で起動
```

### 6.2 関数インターフェース（想定）

```typescript
// prompt-builder.ts
function buildTestAgentPrompt(chunk: Chunk, dependsOnTypes: TypeInfo[]): string;
function buildImplAgentPrompt(chunk: Chunk, testCode: string, codingStandards: string): string;
function buildInvestigationAgentPrompt(
  chunk: Chunk,
  verificationResult: string,
  implCode: string,
  testCode: string
): string;
```

各関数は `prompts/*.md` を読み込んで動的変数を置換した文字列を返す。LLM 呼び出し自体は実行アダプタが担当する（→ [execution-adapter.md](execution-adapter.md)）。

### 6.3 テンプレート更新時のフロー

1. プロンプト仕様の変更が必要になる → 根拠となる上位設計文書（roundtrip / execution-flow 等）を先に更新
2. 本書の該当セクション（§3.3 / §4.3 / §5.3）を更新
3. `prompts/*.md` のテンプレートを更新
4. プロンプトビルダーのテストを更新（期待出力との照合）

上位文書→本書→実装の順で追従させる。本書が実装と設計の中間層として機能する。

## 7. 検証方針

- テンプレートと上位設計文書（roundtrip / execution-flow）の整合性 — 指示の食い違いがないか
- プレースホルダ名の一貫性 — テンプレート・ビルダー関数・動的変数表の3者が一致するか
- 出力フォーマットのパース耐性 — Investigation Agent の JSON 出力が壊れた場合の処理
- 共有バイアス排除の実効性（Test Agent が実装を見ない制約が機能しているか）

## 関連ドキュメント

- [基本設計](../basic-design.md)
- [実行フロー](../2-features/execution-flow.md)
- [ラウンドトリップ検証](../2-features/roundtrip-verification.md)
- [コード規約](../2-features/coding-standards.md)
- [テスト品質](../2-features/test-quality.md)
- [MCP ツール詳細設計](mcp-tools.md)
- [実行アダプタ詳細設計](execution-adapter.md)
