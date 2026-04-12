---
status: complete
layer: interface
---

# Builder MCP ツール詳細設計書

更新日: 2026-04-12
対応コード: builder/src/

## 1. 概要

Builder が提供する 8 つの MCP ツールの入出力・処理フローを定義する。

対応する機能設計: [実行フロー](../2-features/execution-flow.md)、[ラウンドトリップ検証](../2-features/roundtrip-verification.md)

## 2. ツール一覧

### レシピエンジン

| ツール | 概要 |
|---|---|
| `analyze_design` | 設計文書群を読み取り、構造を分析する |
| `split_chunks` | 分析結果を元に、実装チャンクに分割する |
| `validate_refs` | 設計文書間の参照整合性をチェックする |
| `export_recipe` | チャンク群をレシピファイルとして出力する |

### 実行エンジン

| ツール | 概要 |
|---|---|
| `load_recipe` | レシピファイルを読み込み、実行状態を初期化する |
| `next_chunks` | 依存が解決済みのチャンクを返す |
| `complete_chunk` | チャンクの完了を検証し、記録する |
| `execution_status` | 全体の実行進捗を可視化する |

## 3. レシピエンジン — ツール詳細

### 3.1 `analyze_design`

設計文書群を読み取り、構造を分析する。

**入力:**
```json
{
  "doc_paths": ["path/to/BasicDesign.md", "path/to/mcp-tools.md", "..."],
  "project_name": "AI-Ghost-Shell",
  "project_dir": "path/to/Documents/AI-Ghost-Shell/"
}
```

`project_dir` を指定すると、ディレクトリ内の `decisions.jsonl` も自動で読み込む。

**処理ステップ:**
1. **ドリフト検出（既存実装がある場合）** — `project_dir` 内にリファレンス（`docs/ref/*.md`）があれば、リファレンス生成日時以降の git コミット履歴を取得し、変更ファイルとリファレンスの機能範囲を照合。乖離があれば `drift_warnings` として警告（処理は止めない）
2. 各文書を読み取り、メタデータを抽出（行数、セクション構成）
3. Planner が付与したフロントマター（`status`, `layer`, `decisions`, `open_questions`）があれば優先使用。なければ本文から推定
4. Markdown リンクやセクション参照から文書間の依存グラフを構築
5. `decisions.jsonl` があれば、決定事項と影響文書の関係を依存グラフに反映
6. 各文書をレイヤーに分類
7. 技術選定に関する記述を設計文書から抽出（→ recipe.json の `tech_stack` に反映）
8. **コード規約の検出** — `project_dir` で以下を優先度順に探索し、見つかったものを `coding_standards` に記録（[基本設計 §3.5](../basic-design.md) 参照）:
   - `AGENTS.md` / `CODING-STANDARDS.md`（人間・AI 共通規約）
   - `.editorconfig` / `eslint.config.*` / `.prettierrc*` / `ruff.toml` / `pyproject.toml` の linter セクション
   - `package.json` / `pyproject.toml` の `scripts`（`lint`, `format`, `test` コマンド）
   - いずれも存在しない場合は `coding_standards: null`（tech_stack の慣例フォールバック）
9. 推定トークン数を算出

**ドリフト検出の出力例:**
```json
{
  "drift_warnings": [
    {
      "reference": "docs/ref/chunk-01-db-schema.md",
      "commits_since": 3,
      "changed_files": ["src/db/schema.sql", "src/db/connection.ts"],
      "message": "リファレンス生成後にデータ層のコードが変更されています。設計文書が最新の実装を反映しているか、Planner で確認してください"
    }
  ]
}
```

乖離がない場合、`drift_warnings` は空配列。続行するかどうかの判断は人に委ねる。

**出力:**
```json
{
  "project_name": "AI-Ghost-Shell",
  "drift_warnings": [],
  "documents": [
    {
      "path": "BasicDesign.md",
      "lines": 484,
      "estimated_tokens": 3200,
      "layer": "foundation",
      "sections": ["ER図", "テーブル定義", "エディション構成"],
      "references_to": ["episode-extraction.md", "ghost-policy-spec.md"],
      "referenced_by": ["mcp-tools.md", "ghost-cli.md", "operation-flows.md"]
    }
  ],
  "dependency_graph": { "..." : "..." },
  "layers": {
    "foundation": ["BasicDesign.md"],
    "specification": ["ghost-policy-spec.md", "episode-extraction.md"],
    "usecase": ["ai-ghost-backup-usecases.md"],
    "interface": ["mcp-tools.md", "ghost-cli.md"],
    "execution": ["operation-flows.md"],
    "context": ["prior-art-comparison.md", "ToDo.md"]
  },
  "coding_standards": {
    "docs": ["AGENTS.md"],
    "linters": [".editorconfig", "eslint.config.js", ".prettierrc"],
    "scripts": {
      "lint": "npm run lint",
      "format": "npm run format",
      "test": "npm test"
    }
  },
  "total_tokens": 33000
}
```

`coding_standards` が `null` の場合、Builder は `tech_stack` の言語慣例にフォールバックする。

### 3.2 `split_chunks`

分析結果を元に、実装チャンクに分割する。

**入力:**
```json
{
  "analysis": "（analyze_design の出力）",
  "strategy": "bottom_up",
  "constraints": {
    "max_input_tokens": 8000,
    "max_output_tokens": 12000,
    "max_source_docs": 2,
    "max_output_files": 5
  }
}
```

**分割ロジック:**

```
Step 1: 依存グラフをトポロジカルソート
         → 被依存が多い文書から実装順序を決定

Step 2: 実装レイヤーにマッピング
         設計レイヤー          実装レイヤー
         ──────────          ──────────
         foundation     →    データ層（DB, スキーマ）
         specification  →    ビジネスロジック層
         usecase        →    （実装には直接使わない。検証基準として参照）
         interface      →    API / CLI 層
         execution      →    （テスト・ベンチマーク用）
         context        →    （実装対象外）

Step 3: 各レイヤー内でチャンクに分割
         分割基準:
         - 1チャンク = 1つの凝集した機能単位
         - 参照する設計文書は 1〜2 本
         - 生成するファイルは 3〜5 本
         - 完了条件がテスト可能
```

**出力:**

`split_chunks` は機械的に分割可能な範囲でチャンク候補を生成する。
`expected_outputs` や `completion_criteria` は人がレビューで具体化する前提のため、初期値は汎用的な内容になる。

```json
{
  "chunks": [
    {
      "id": "chunk-01",
      "name": "データベーススキーマ",
      "description": "BasicDesign.md に基づく実装",
      "source_docs": [
        {
          "path": "BasicDesign.md",
          "sections": ["3. ER図", "3.1 テーブル定義"],
          "include": "partial"
        }
      ],
      "expected_outputs": [],
      "completion_criteria": [
        "テストが通る",
        "設計文書の入力パラメータが全てテストされている",
        "エラーケースのテストが1つ以上ある",
        "depends_on チャンクの出力との接続が検証されている"
      ],
      "test_requirements": {
        "interface_tests": ["5テーブルが全て作成される", "マイグレーションが冪等"],
        "boundary_tests": ["DB ファイルが存在しない場合に新規作成される"],
        "integration_refs": []
      },
      "implementation_prompt_template": "以下の設計に基づき、データベーススキーマ を実装してください。\n\n{source_content}",
      "reference_doc": "docs/ref/chunk-01-データベーススキーマ.md",
      "depends_on": [],
      "estimated_input_tokens": 2500,
      "estimated_output_tokens": 3750,
      "validation_context": "UC-1: 初期セットアップで ghost.db が作成される"
    }
  ],
  "execution_order": [["chunk-01"], ["chunk-02", "chunk-03"], ["chunk-04"]],
  "needs_review": true,
  "review_notes": [
    "各チャンクの expected_outputs を設定してください",
    "各チャンクの implementation_prompt_template を具体化してください",
    "各チャンクの completion_criteria を具体化してください"
  ]
}
```

`execution_order` は DAG のレベル順。同一レベルのチャンクは並列実行可能。
`needs_review` は常に `true` を返す。

**`test_requirements` の構造:**

| フィールド | 内容 |
|-----------|------|
| `interface_tests` | 設計文書に記載された入出力パラメータ・公開 API の動作検証 |
| `boundary_tests` | エラーケース・境界値・異常系の検証 |
| `integration_refs` | `depends_on` チャンクとの接続検証 |

**DraftChunk → Chunk 変換:**

```
DraftChunk（split_chunks の出力）
  ├── implementation_prompt_template  … {source_content} プレースホルダを含む
  ├── test_requirements               … 設計文書から抽出したテスト観点
  └── source_content なし            … まだ設計文書の内容は埋め込まれていない

        ↓ export_recipe で変換

Chunk（recipe.json の最終形）
  ├── implementation_prompt           … プレースホルダ解決済みの完全なプロンプト
  ├── test_requirements               … そのまま引き継ぎ
  └── source_content                  … 設計文書の該当セクションが埋め込み済み
```

### 3.3 `validate_refs`

設計文書間の参照整合性をチェックする。

**Planner の `check_consistency` との違い:**
- Planner `check_consistency`: 設計フェーズ中の壁打ちで使う。用語の揺れや決定ログとの乖離など、設計内容の品質を検出する
- Builder `validate_refs`: レシピ化の直前に使う。**チャンク分割に必要な参照の構造的整合性**（リンク切れ、ID欠番、カバレッジ）に絞ってチェックする

**入力:**
```json
{
  "doc_paths": ["..."]
}
```

**チェック項目:**

| チェック | 内容 | v0.1 |
|---------|------|------|
| 未解決参照 | Markdown リンクのリンク切れ | 実装済み |
| ユースケース欠番 | UC-1〜13 / AC-1〜7 に抜け漏れがないか | 実装済み |
| セクション参照 | `{ファイル名} §{番号}` 形式の参照先が存在するか | 実装済み |
| テーブル名不一致 | 文書間で同じ概念に異なる名称が使われていないか | 未実装 |
| フロー図カバレッジ | operation-flows が主要ユースケースを網羅しているか | 未実装 |
| ポリシー設定漏れ | ポリシー文書に記載のキーが他文書で言及されているか | 未実装 |

**出力:**
```json
{
  "status": "warn",
  "issues": [
    {
      "severity": "warn",
      "type": "table_name_mismatch",
      "message": "episode-extraction.md L42: 'episodes' → BasicDesign.md では 'episode_memories'",
      "locations": ["episode-extraction.md:42", "BasicDesign.md:128"]
    }
  ]
}
```

### 3.4 `export_recipe`

チャンク群を実行エンジンが読めるレシピファイルとして出力する。

**入力:**
```json
{
  "chunks": "（split_chunks の出力）",
  "output_path": "path/to/recipe.json",
  "include_source_content": true
}
```

**処理:**
- 各チャンクの `source_docs` で参照されるセクションを**実際に抽出**し、レシピに埋め込む
- チャンク単体で実装に必要な情報が揃うようにする（外部参照不要）
- ユースケース文書は `validation_context` として添付（実装指示には使わない、検証用）
- `tech_stack` は `analyze_design` が設計文書から抽出した技術選定情報をそのまま載せる
- `coding_standards` は `analyze_design` が検出した規約ファイルへの参照とコマンド定義をそのまま載せる（ダイジェスト化は `next_chunks` が実行時に行う）

**出力: recipe.json の構造**
```json
{
  "project": "AI-Ghost-Shell",
  "created_at": "2026-03-02T...",
  "builder_version": "0.1.0",
  "tech_stack": {
    "language": "TypeScript",
    "runtime": "Node.js",
    "db": "SQLite",
    "test": "vitest",
    "platforms": ["linux", "macos"],
    "directory_structure": "src/ + tests/"
  },
  "coding_standards": {
    "docs": ["AGENTS.md"],
    "linters": [".editorconfig", "eslint.config.js", ".prettierrc"],
    "scripts": { "lint": "npm run lint", "format": "npm run format", "test": "npm test" }
  },
  "chunks": [
    {
      "id": "chunk-01",
      "name": "データベーススキーマ",
      "depends_on": [],
      "source_content": "## 3. ER図\n...(実際の設計文書の該当セクション)...",
      "implementation_prompt": "以下の設計に基づき、SQLite データベースのスキーマとマイグレーションを実装してください。\n\n{source_content}",
      "expected_outputs": ["..."],
      "completion_criteria": ["..."],
      "test_requirements": { "interface_tests": [], "boundary_tests": [], "integration_refs": [] },
      "reference_doc": "docs/ref/chunk-01-db-schema.md",
      "validation_context": "UC-1: 初期セットアップで ghost.db が作成される"
    }
  ],
  "execution_order": ["..."]
}
```

## 4. 実行エンジン — ツール詳細

### 4.1 `load_recipe`

レシピファイルを読み込み、実行状態を初期化する。

**入力:**
```json
{
  "recipe_path": "path/to/recipe.json"
}
```

**処理ステップ:**
1. recipe.json を読み込み、構造を検証
2. 各チャンクの状態を `pending` で初期化
3. 依存グラフから即座に実行可能なチャンクを特定
4. 実行状態ファイルを生成（`execution-state.json`、recipe.json と同じディレクトリに配置）

**出力:**
```json
{
  "project": "AI-Ghost-Shell",
  "total_chunks": 17,
  "ready_chunks": ["chunk-01"],
  "execution_state_path": "path/to/execution-state.json"
}
```

**execution-state.json の構造:**
```json
{
  "recipe_path": "path/to/recipe.json",
  "started_at": "2026-03-03T...",
  "chunks": {
    "chunk-01": { "status": "pending", "started_at": null, "completed_at": null, "outputs": [] },
    "chunk-02": { "status": "pending", "started_at": null, "completed_at": null, "outputs": [] }
  }
}
```

### 4.2 `next_chunks`

依存が解決済みのチャンクを返す。プレースホルダを実際のコードに差し込み済みの、**そのまま実行可能な実装指示**を組み立てる。

**入力:**
```json
{
  "execution_state_path": "path/to/execution-state.json"
}
```

**処理ステップ:**
1. 実行状態から `pending` かつ依存が全て `done` のチャンクを抽出
2. 各チャンクの `source_content` 内の `{{file:...}}` プレースホルダを、実際のファイル内容に置換
3. `coding_standards` のダイジェスト（規約ファイル名 + 主要ルール + lint/format コマンド）を `implementation_prompt` の末尾に自動挿入
4. 実装プロンプトを組み立てる

**プレースホルダ解決の例:**
```
chunk-04 の source_content に含まれる:
  {{file:src/db/schema.ts}}
  → chunk-01 で生成された実際の schema.ts の内容に置換
```

**コード規約ダイジェストの例:**
```
--- コード規約（プロジェクト遵守） ---
- AGENTS.md のルールに従うこと
- ESLint / Prettier の既存設定を遵守すること
- 実装完了後、以下のコマンドが通ること: npm run lint && npm run format:check
```

`coding_standards` が `null` の場合、ダイジェストは `tech_stack` の言語慣例（「TypeScript 標準のコーディング規約に従う」等）にフォールバックする。

**出力:**
```json
{
  "ready": [
    {
      "id": "chunk-02",
      "name": "ghost-policy.toml パーサー",
      "implementation_prompt": "（プレースホルダ解決済みの完全な実装指示）",
      "expected_outputs": ["src/policy/parser.ts", "src/policy/types.ts", "tests/policy/parser.test.ts"],
      "completion_criteria": ["TOML パースが成功する", "不正な設定でエラーを返す", "テストが通る"]
    }
  ],
  "blocked": ["chunk-04", "chunk-05"],
  "done": ["chunk-01"],
  "progress": "1/17 完了"
}
```

### 4.3 `complete_chunk`

チャンクの完了を検証し、記録する。

**入力:**
```json
{
  "execution_state_path": "path/to/execution-state.json",
  "chunk_id": "chunk-01",
  "generated_files": ["src/db/schema.sql", "src/db/connection.ts", "tests/db/schema.test.ts"]
}
```

**処理ステップ:**
1. `expected_outputs` に対してファイルの存在を確認
2. テストファイルがあればテストを実行
3. `completion_criteria` を可能な範囲で自動検証
4. `coding_standards.scripts.lint` / `format` が定義されていれば実行し、違反があれば記録
5. 状態を `done` に更新、後続チャンクをアンロック

**検証レベル:**

| レベル | 内容 | 自動化 |
|--------|------|--------|
| ファイル存在 | expected_outputs が全て存在するか | 完全自動 |
| テスト通過 | テストファイルが pass するか | 完全自動（条件付き） |
| 基準照合 | completion_criteria を満たすか | 一部自動 |
| テスト品質 | test_requirements の観点が網羅されているか | 一部自動 |
| 規約適合性 | `coding_standards` の linter/formatter が pass するか | 完全自動（規約定義時のみ） |

**テスト品質の検証項目:**

| 検証項目 | 内容 | 実装フェーズ |
|---------|------|------------|
| パラメータ網羅 | 設計文書の入力パラメータが全てテストされているか | v0.1 |
| 異常系の存在 | エラーケース・境界値のテストが1つ以上あるか | v0.1 |
| 統合ポイント | 依存チャンクとの接続テストがあるか | v0.1 |
| Assertion 品質 | `assert True` や例外不発生のみのテストを検出 | v0.1 |
| Mutation Score | 実装にミュータントを注入し、テストが検出できるかを測る（Stryker / mutmut） | v0.2 以降 |

**Mutation Testing の位置づけ:**
Dual-Agent TDD で共有バイアスを防いでも、テストの assert が弱い問題は残る（[基本設計 §3.5](../basic-design.md)）。Mutation Testing は「カバレッジ ≠ テスト有効性」への唯一の自動化対策。Survived（検出されなかった）ミュータントは Test Agent に具体的な強化指示として渡す。

テスト実行の前提条件:
- `generated_files` にテストファイル（`.test.`, `.spec.`, `__tests__`）を含む
- `{working_dir}/node_modules` が存在する（なければテスト実行をスキップ）
- テスト実行タイムアウト: 60秒
- テストコマンド: `npx {tech_stack.test} run {テストファイル}`

**出力（成功時）:**
```json
{
  "chunk_id": "chunk-01",
  "status": "done",
  "verification": {
    "files_exist": true,
    "tests_passed": true,
    "criteria_met": ["5テーブルが作成される: OK", "マイグレーションが冪等: OK"]
  },
  "newly_unblocked": ["chunk-02", "chunk-03", "chunk-09"]
}
```

**出力（失敗時）:**
```json
{
  "chunk_id": "chunk-01",
  "status": "failed",
  "verification": {
    "files_exist": false,
    "missing_files": ["src/db/migrations/001_initial.sql"],
    "tests_passed": false,
    "test_errors": ["..."]
  },
  "action": "retry"
}
```

失敗したチャンクは `failed` 状態に。再実行時は `next_chunks` が再度返す。

### 4.4 `execution_status`

全体の実行進捗を可視化する。

**入力:**
```json
{
  "execution_state_path": "path/to/execution-state.json"
}
```

**出力:**
```json
{
  "progress": {
    "done": 5,
    "in_progress": 2,
    "pending": 8,
    "failed": 1,
    "blocked": 1,
    "total": 17
  },
  "chunks": [
    { "id": "chunk-01", "name": "DB スキーマ", "status": "done" },
    { "id": "chunk-02", "name": "Policy パーサー", "status": "in_progress" },
    { "id": "chunk-04", "name": "メモリ検索コア", "status": "blocked", "blocked_by": ["chunk-02"] },
    { "id": "chunk-09", "name": "エピソード抽出", "status": "failed", "retry_count": 1 }
  ],
  "current_level": 1,
  "estimated_remaining": "12 chunks"
}
```

## 関連ドキュメント

- [基本設計](../basic-design.md)
- [実行フロー機能設計](../2-features/execution-flow.md)
- [ラウンドトリップ検証機能設計](../2-features/roundtrip-verification.md)
- [実行アダプタ詳細設計](execution-adapter.md)
- [Builder リファレンス](../4-ref/builder-reference.md)
