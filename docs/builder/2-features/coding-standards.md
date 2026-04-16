---
status: complete
layer: specification
---

# コード規約伝播機能設計書

更新日: 2026-04-15

## 1. 概要

プロジェクトにコード規約（AGENTS.md・linter 設定・スクリプト等）がある場合、それを **検出・注入・検証** の 3 点で一貫して扱う。組織・チームの既存資産を上書きせず、**存在すれば優先する、無ければ `tech_stack` の慣例にフォールバック**、が基本姿勢。

規約の扱いは 3 つのツールに分散するが、責務は明確に分離されている:

| タイミング | 担当ツール | 役割 |
|---|---|---|
| 分析時 | `analyze_design` | プロジェクト内の規約資産を検出し、`recipe.json` に記録 |
| 実行時 | `next_chunks` | 規約からダイジェストを生成し、Agent プロンプトに注入 |
| 完了検証 | `complete_chunk` | linter/formatter を実行し、規約違反を検出 |

## 2. 構成要素

### 2.1 バウンダリ（外部との接点）

- **規約文書** — `AGENTS.md` / `CODING-STANDARDS.md`（人間・AI 共通規約）
- **機械可読な設定** — `.editorconfig` / `eslint.config.*` / `.prettierrc*` / `ruff.toml` / `pyproject.toml` の linter セクション
- **スクリプト** — `package.json` / `pyproject.toml` の `scripts`（`lint`, `format`, `test`）
- **recipe.json の coding_standards** — 分析結果の永続化領域
- **Agent プロンプト** — 実行時にダイジェストを注入する対象

### 2.2 エンティティ（扱うデータ）

- **coding_standards** — `{ docs, linters, scripts }` の 3 フィールド構造
- **ダイジェスト** — プロンプトに注入するための短縮表現（規約ファイル名 + 主要ルール + コマンド）

### 2.3 コントローラー（主要な処理）

- **規約検出** — `project_dir` を優先度順に走査
- **ダイジェスト生成** — `coding_standards` から Agent に読ませる短縮表現を組み立てる
- **プロンプト注入** — `implementation_prompt` の末尾にダイジェストを自動付加
- **規約検証** — linter/formatter を実行し、結果を `complete_chunk` の照合に含める
- **フォールバック** — 規約なしの場合、`tech_stack` の言語慣例に切り替え

## 3. 規約の検出（analyze_design）

### 3.1 検出順序（優先度高 → 低）

1. **`AGENTS.md` / `CODING-STANDARDS.md`** — 組織・チームの統一規約（人間・AI 共通）
2. **機械可読な linter・formatter 設定** — `.editorconfig` / `eslint.config.js` / `.prettierrc` / `ruff.toml` / `pyproject.toml` の linter セクション
3. **スクリプト定義** — `package.json` / `pyproject.toml` の `scripts`（`lint`, `format`, `test` コマンドの呼び出し方）

### 3.2 出力構造

```json
{
  "coding_standards": {
    "docs": ["AGENTS.md"],
    "linters": [".editorconfig", "eslint.config.js", ".prettierrc"],
    "scripts": {
      "lint": "npm run lint",
      "format": "npm run format",
      "test": "npm test"
    }
  }
}
```

いずれも存在しない場合、`coding_standards` は `null`。

## 4. 規約の注入（next_chunks）

`implementation_prompt` の末尾に、規約ダイジェストを自動挿入する。ダイジェストは `recipe.json` の `coding_standards` から機械的に生成されるため、レシピ作成後に規約ファイルを更新しても、次回 `load_recipe` で反映される。

**ダイジェスト生成の例:**

```
--- コード規約（プロジェクト遵守） ---
- AGENTS.md のルールに従うこと
- ESLint / Prettier の既存設定を遵守すること
- 実装完了後、以下のコマンドが通ること: npm run lint && npm run format:check
```

Agent は規約文書の本文全てを読むのではなく、**「どのファイルを参照すべきか」+「最低限通すべきコマンド」** だけ受け取る。文書の詳細な解釈は Agent 側の責務。これにより、規約が大きい場合もトークン消費を抑えられる。

## 5. 規約の検証（complete_chunk）

`coding_standards.scripts.lint` / `format` が定義されていれば、`complete_chunk` の検証レベルの 1 つとして実行する。

| レベル | 内容 | 自動化 |
|---|---|---|
| 規約適合性 | `coding_standards.scripts.lint` / `format` が pass するか | 完全自動（規約定義時のみ） |

違反が検出された場合:

- Investigation Agent が「実装が規約に沿っていない」と判定 → Impl Agent に差し戻し
- 差し戻し時は違反箇所と linter 出力を付与する
- リトライ超過時は人に判断を仰ぐ（規約自体が現実と乖離している可能性）

テストと同様に、規約違反は「動くが受け入れられない」失敗として扱い、`complete_chunk` を成功させない。

## 6. フォールバック

規約ファイルが存在しない個人開発等では、以下の挙動になる:

- `analyze_design`: `coding_standards: null` を記録
- `next_chunks`: ダイジェストの代わりに `tech_stack` の言語慣例を注入（例: TypeScript なら「ESLint 推奨設定相当、2 スペースインデント」等）
- `complete_chunk`: 規約適合性の検証はスキップ（他のレベルは通常どおり実行）

規約ファイルは存在するが解釈が困難な場合（未対応の linter 等）は、警告を出すが処理は止めない。

## 7. 設計判断

### なぜ 3 つのツールにまたがる設計にするか

規約は「設計時に分析 → 実行時に注入 → 完了時に検証」という時系列で一貫して扱わないと、検出漏れ・注入漏れ・検証漏れのいずれかで実効性が落ちる。3 箇所に責務を分散させることで、**「分析した規約は必ず Agent に届き、完了判定で違反が残らない」** ことが構造的に保証される。

### なぜダイジェスト方式か（規約本文をそのまま渡さない）

AGENTS.md が数千トークン規模のプロジェクトでは、本文を全チャンクに注入するとトークン消費が膨れ上がる。ダイジェストは「どこを見るか + 何を通せばいいか」のポインタに絞るため、規模に関わらずトークンコストが一定に収まる。文書の詳細解釈は Agent が必要な分だけ読み込めばよい。

### なぜ規約なしでも動くようにするか

個人開発や新規プロジェクトでは規約ファイルがないことが普通。規約を必須にすると Builder の適用範囲が狭まる。`tech_stack` の言語慣例で「よしなに」生成するフォールバックを用意することで、**規約がなくてもそれなりに整ったコードが出る**状態を保つ。

### なぜ規約違反で差し戻すか

lint 違反を許容すると、「Builder の出力は毎回手修正が必要」な運用になる。手修正を前提にすると、Builder が本来目指す「設計 → 実装の自動化」のループが閉じない。規約違反もテスト失敗と同じく差し戻しループに載せて、Builder 内で収束させる。

## 8. 検証方針

- 規約ファイルが複数存在する場合、優先度順に正しく収集されるか
- ダイジェストが Agent プロンプトの末尾に確実に注入されるか
- lint/format コマンドが規約違反を検出できるか（意図的に違反コードを生成して確認）
- 規約なしプロジェクトでフォールバックが正しく動作するか
- 未対応 linter のプロジェクトで警告が出るが処理が止まらないか

## 関連ドキュメント

- [基本設計](../basic-design.md)
- [設計文書分析](design-analysis.md)
- [チャンク分割](chunk-splitting.md)
- [実行フロー](execution-flow.md)
- [テスト品質](test-quality.md)
- [MCP ツール詳細設計 §3.1 analyze_design / §4.2 next_chunks / §4.3 complete_chunk](../3-details/mcp-tools.md)
