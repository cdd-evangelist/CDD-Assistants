# CDD-Builder リファレンスドキュメント

## 1. モジュール構成の概要

```
builder/src/
  index.ts                          # MCP サーバーエントリポイント（全8ツール登録）
  types.ts                          # 全型定義
  recipe-engine/
    analyze-design.ts               # 設計文書の構造分析
    split-chunks.ts                 # チャンク分割と実行順序算出
    validate-refs.ts                # 設計文書間の参照整合性チェック
    export-recipe.ts                # レシピファイル（recipe.json）出力
  execution-engine/
    index.ts                        # 実行エンジンの再エクスポート
    load-recipe.ts                  # レシピ読み込みと実行状態初期化
    next-chunks.ts                  # 実行可能チャンクの取得とプレースホルダ解決
    complete-chunk.ts               # チャンク完了検証と状態更新
    execution-status.ts             # 実行進捗の集計と可視化
  adapters/
    index.ts                        # アダプタの再エクスポート
    claude-code.ts                  # claude CLI アダプタ
```

### 各モジュールの役割

| モジュール | 役割 |
|---|---|
| `index.ts` | `@modelcontextprotocol/sdk` の `McpServer` を使い、8つのツールを登録して stdio トランスポートで起動する |
| `types.ts` | レシピ、レシピエンジン、実行状態、実行アダプタ、ツール出力の型を一括定義する |
| `analyze-design.ts` | 設計文書群を読み込み、フロントマター解析・レイヤー分類・依存グラフ構築・トークン推定・tech_stack 抽出・ドリフト検出を行う |
| `split-chunks.ts` | `analyze_design` の出力を受け取り、レイヤーマッピング・チャンク候補生成・依存関係決定・execution_order 算出を行う |
| `validate-refs.ts` | 設計文書間の wiki-link 検証・UC/AC 欠番検出・セクション参照チェックを行う |
| `export-recipe.ts` | `DraftChunk[]` を `Recipe` に変換し、設計文書の内容を埋め込んで JSON ファイルとして出力する |
| `load-recipe.ts` | レシピ JSON を読み込み、全チャンクを `pending` 状態で初期化した実行状態ファイルを生成する |
| `next-chunks.ts` | 実行状態とレシピを読み、依存解決済みチャンクの `PreparedChunk` を組み立てる |
| `complete-chunk.ts` | ファイル存在検証・テスト実行・状態更新・後続チャンクのアンロック判定を行う |
| `execution-status.ts` | 全チャンクの進捗を集計し、現在の実行レベルと残りチャンク数を返す |
| `claude-code.ts` | `claude` CLI をサブプロセスで起動し、チャンク単位で実装を実行するアダプタ |

---

## 2. 公開インターフェース

### レシピエンジン

#### `analyzeDesign`

```typescript
export async function analyzeDesign(input: {
  doc_paths: string[]
  project_name: string
  project_dir?: string
}): Promise<AnalyzeDesignResult>
```

#### `splitChunks`

```typescript
export async function splitChunks(input: SplitChunksInput): Promise<SplitChunksResult>
```

`SplitChunksInput` のフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `analysis` | `AnalyzeDesignResult` | `analyzeDesign` の出力 |
| `strategy` | `'bottom_up'` (省略可) | 分割戦略。現状は `bottom_up` のみ |
| `constraints` | オブジェクト (省略可) | `max_input_tokens`(デフォルト 8000), `max_output_tokens`(デフォルト 12000), `max_source_docs`(デフォルト 2), `max_output_files`(デフォルト 5) |
| `docs_dir` | `string` | 文書読み込み用ベースディレクトリ |

#### `validateRefs`

```typescript
export async function validateRefs(docPaths: string[]): Promise<ValidationResult>
```

`ValidationResult` は `validate-refs.ts` 内で定義されたローカル型:

```typescript
interface ValidationResult {
  status: 'ok' | 'warn' | 'error'
  issues: ValidationIssue[]
  summary: { errors: number; warnings: number; info: number }
}

interface ValidationIssue {
  severity: 'error' | 'warn' | 'info'
  type: string
  message: string
  locations: string[]
}
```

#### `exportRecipe`

```typescript
export async function exportRecipe(input: ExportRecipeInput): Promise<ExportRecipeResult>
```

### 実行エンジン

#### `loadRecipe`

```typescript
export async function loadRecipe(
  recipePath: string,
  workingDir?: string
): Promise<LoadRecipeResult>
```

#### `nextChunks`

```typescript
export async function nextChunks(
  executionStatePath: string
): Promise<NextChunksResult>
```

#### `completeChunk`

```typescript
export async function completeChunk(
  executionStatePath: string,
  chunkId: string,
  generatedFiles: string[]
): Promise<CompleteChunkResult>
```

#### `executionStatus`

```typescript
export async function executionStatus(
  executionStatePath: string
): Promise<ExecutionStatusResult>
```

### 実行アダプタ

#### `ClaudeCodeExecutor`

```typescript
export class ClaudeCodeExecutor implements ChunkExecutor {
  constructor(config?: ClaudeCodeConfig)
  async execute(chunk: PreparedChunk): Promise<ExecutionResult>
}
```

`ClaudeCodeConfig`:

| フィールド | 型 | デフォルト |
|---|---|---|
| `model` | `string` | `'sonnet'` |
| `timeout` | `number` | `300000`（5分） |
| `allowedTools` | `string[]` | `['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']` |

---

## 3. レシピエンジンの実装ロジック

### 3.1 analyze_design

`analyzeDesign` 関数は以下の順序で処理を行う。

**ステップ 1: ドリフト検出**

`project_dir` が指定されている場合、`detectDrift` を呼び出す。

- `{project_dir}/docs/ref/` 内の `.md` ファイルを列挙する
- 各リファレンスファイルの `mtime` を取得し、それ以降の git コミットで変更されたファイルを `git log --since {mtime} --name-only --diff-filter=ACMR` で取得する
- `docs/ref/` 配下の変更は除外する
- 変更ファイルがあれば `git log --since {mtime} --oneline` でコミット数をカウントし、`DriftWarning` を生成する
- git コマンドが失敗した場合やリファレンスディレクトリが存在しない場合は空配列を返す

**ステップ 2: 文書読み込み**

`doc_paths` の各ファイルを `readFile` で読み込み、以下を抽出する:

- `parseFrontmatter`: `---` で囲まれた YAML フロントマターを簡易パーサーで解析する。`key: value` 形式と `- item` 形式の配列に対応する。対応フィールドは `status`, `layer`, `decisions`, `open_questions`
- `extractSectionNames`: `##` 〜 `####` レベルの見出しテキストを収集する
- `extractWikiLinks`: インラインコード内を除外した上で `[[target]]` 形式のリンクターゲットを抽出する。`#` 以降のアンカー部分は除去し、`.md` 拡張子も除去する
- `estimateTokens`: CJK 文字は 1 文字 = 2 トークン、ASCII 文字は 1 文字 = 0.25 トークンとして推定する

**ステップ 3: decisions.jsonl 読み込み**

`project_dir` が指定されている場合、`{project_dir}/decisions.jsonl` を読み込む。各行を JSON パースして `Decision[]` を返す。ファイルが存在しない場合は空配列を返す。

**ステップ 4: 依存グラフ構築**

- 各文書の wiki-link から、同一文書群内（`doc_paths` で渡された文書群）に存在するリンクのみを依存として抽出する。自己参照は除外する
- `decisions.jsonl` の各決定事項について、`affected_docs` に複数文書が含まれる場合、それらの文書間に双方向の依存を追加する

**ステップ 5: レイヤー推定**

レイヤー分類は Hybrid Approach C を採用している:

1. フロントマターに `layer` が指定されていればそれを使う
2. なければファイル名に対して `nameHints` のパターンマッチを試みる（例: `usecase` を含むファイル名は `usecase` レイヤー）
3. ファイル名で判定できなければ、文書内容に対して `LAYER_HEURISTICS` のパターンマッチを行う。2 つ以上マッチしたレイヤーを採用し、なければ 1 つマッチでも採用する
4. いずれにも該当しなければデフォルトで `context` レイヤーとする

レイヤーの種類: `foundation`, `specification`, `usecase`, `interface`, `execution`, `context`

**ステップ 6: referenced_by 構築**

依存グラフの逆引きマップを構築する。各文書について、その文書を参照している文書の一覧を生成する。

**ステップ 7: tech_stack 抽出**

全文書の内容を結合し、以下のパターンマッチで技術スタックを抽出する:

- 言語: TypeScript, Python, Rust, Go（最初にマッチしたもの）
- ランタイム: Node.js, Deno, Bun
- データベース: SQLite, PostgreSQL, MySQL
- テスト: vitest, jest, pytest

**ステップ 8: DocumentAnalysis 組み立て**

各文書の分析結果を `DocumentAnalysis` オブジェクトに組み立て、全文書の推定トークン合計とともに `AnalyzeDesignResult` として返す。

### 3.2 split_chunks

`splitChunks` 関数は以下の順序で処理を行う。

**ステップ 1: レイヤーマッピング**

`DocLayer` から実装レイヤー（`ImplLayer`）への変換を行う:

| DocLayer | ImplLayer |
|---|---|
| `foundation` | `data` |
| `specification` | `logic` |
| `usecase` | `skip`（実装対象外） |
| `interface` | `interface` |
| `execution` | `test` |
| `context` | `skip`（実装対象外） |

`skip` に分類された文書はチャンク生成の対象から除外される。

**ステップ 2: チャンク候補生成**

`generateCandidates` 関数で各文書からチャンク候補を生成する:

- 文書の推定トークン数が `max_input_tokens` 以下の場合、その文書全体を 1 チャンクとする。トークン数が `max_input_tokens / 2` 以下なら `include: 'full'`、それ以外は `include: 'partial'` となる
- トークン数が `max_input_tokens` を超過する場合も 1 チャンクとして生成するが、description に「大規模: 要レビュー」を付記する
- 各チャンクに関連ユースケース文書を `findRelatedUsecases` で探索し、`validationDocs` に設定する。`referenced_by` と `references_to` の両方向で `usecase` レイヤーの文書を検索する

**ステップ 3: DraftChunk 変換**

チャンク候補を `DraftChunk` に変換する:

- ID は `chunk-01`, `chunk-02`, ... の形式（ゼロパディング 2 桁）
- `implementation_prompt_template` は `以下の設計に基づき、{name} を実装してください。\n\n{source_content}` の固定テンプレート
- `expected_outputs` は空配列（機械的に決定困難のため）
- `completion_criteria` は `['テストが通る']` 固定
- `reference_doc` は `docs/ref/{id}-{name}.md` 形式。name 中の英数字・CJK 文字以外はハイフンに置換される
- 推定出力トークン数は入力トークン数の 1.5 倍で、`max_output_tokens` を上限とする
- `source_docs` の件数が `max_source_docs` を超過した場合、および推定入力トークンが `max_input_tokens` を超過した場合は `review_notes` に記録される

**ステップ 4: 依存関係決定**

`assignDependencies` 関数で依存関係を設定する:

- 実装レイヤー間の依存: `data` -> `logic` -> `interface` -> `test` の順で、後段のレイヤーのチャンクは前段のレイヤーの全チャンクに依存する（保守的な戦略）
- 文書間の直接依存: wiki-link による参照先文書を含むチャンクを探し、参照先が同一レイヤーまたは下位レイヤーの場合のみ依存に追加する

**ステップ 5: execution_order 算出**

`computeExecutionOrder` 関数でトポロジカルソートを行う:

- 全依存が解決済みのチャンクを同一レベルに配置する
- 各レベル内は ID の辞書順でソートされる
- 循環依存が検出された場合（解決可能なチャンクが見つからない場合）、残りの全チャンクを最後のレベルに押し込む

**ステップ 6: レビューフラグ**

`needs_review` は常に `true` を返す。`review_notes` には以下の 3 項目が必ず含まれる:

- `各チャンクの expected_outputs を設定してください`
- `各チャンクの implementation_prompt_template を具体化してください`
- `各チャンクの completion_criteria を具体化してください`

### 3.3 validate_refs

`validateRefs` 関数は以下の 3 種類のチェッカーを実行する。

**チェッカー 1: wiki-link 検証 (`checkWikiLinks`)**

- 各文書の各行について `[[target]]` 形式の wiki-link を検出する
- インラインコード（バッククォート内）の wiki-link は無視する
- リンクターゲットが渡された文書群のファイル名（拡張子なし）に存在しない場合、severity `warn`、type `broken_wiki_link` の issue を生成する
- locations に `{ファイル名}.md:{行番号}` を記録する

**チェッカー 2: UC/AC 欠番検出 (`checkUsecaseIds`)**

- 全文書から `UC-{数字}` と `AC-{数字}` のパターンを収集する
- 各パターンについて、1 から最大値までの連番を確認し、欠番があれば severity `warn`、type `usecase_gap` の issue を生成する

**チェッカー 3: セクション参照チェック (`checkSectionRefs`)**

- `{ファイル名} §{番号}` 形式の参照を検出する
- 参照先のファイルが文書群に存在しない場合、severity `info`、type `section_ref_unresolved` の issue を生成する

**結果の集計**

- `status` は error が 1 件以上あれば `'error'`、warning が 1 件以上あれば `'warn'`、それ以外は `'ok'`
- `summary` に error / warning / info の件数を集計する

### 3.4 export_recipe

`exportRecipe` 関数は以下の順序で処理を行う。

**ステップ 1: source_content の解決**

`resolveSourceContent` 関数で各 `DraftChunk` の `source_docs` からコンテンツを読み込む:

- `include_source_content` が `false` の場合、`（参照: {path} / セクション: {sections}）` 形式の参照文字列のみ生成する
- `include` が `'full'` の場合、ファイル全体を埋め込む
- `include` が `'partial'` の場合、sections が `['全体']` ならファイル全体を、それ以外なら `extractSections` で指定セクションを抽出して埋め込む
- ファイルが読み込めない場合、warnings に記録し、HTML コメント形式のプレースホルダを挿入する

**ステップ 2: セクション抽出 (`extractSections`)**

- 指定されたセクション名に一致する見出し行を探す（完全一致または前方一致）
- 見出しレベルを記録し、次の同レベル以上の見出しが現れるまでをセクション範囲とする
- セクションが見つからない場合、`<!-- セクション "{name}" が見つかりませんでした -->` を出力する

**ステップ 3: implementation_prompt の生成**

`implementation_prompt_template` 内の `{source_content}` プレースホルダを、解決済みの source_content で置換する。

**ステップ 4: execution_order の算出**

`split-chunks.ts` と同一ロジックの `computeExecutionOrder` 関数で、`DraftChunk[]` の `depends_on` グラフからトポロジカル順のレベル分けを行う。

**ステップ 5: Recipe の出力**

`Recipe` オブジェクトを組み立て、`output_path` に JSON 形式（2 スペースインデント）で書き出す。`builder_version` は `'0.1.0'` 固定。`created_at` は実行時の ISO 8601 タイムスタンプ。

---

## 4. 実行エンジンの実装ロジック

### 4.1 load_recipe

`loadRecipe` 関数は以下の処理を行う:

1. `recipe_path` を絶対パスに解決し、JSON として読み込む
2. `ExecutionState` を初期化する。全チャンクの状態を `pending`、`started_at` / `completed_at` を `null`、`outputs` を空配列、`retry_count` を `0` に設定する
3. `working_dir` が指定されていなければ、レシピファイルのディレクトリを使用する
4. `depends_on` が空配列のチャンクを即座に実行可能（`ready_chunks`）として返す
5. 実行状態ファイルを `{recipe_path から .json を除いた名前}-state.json` のパスに保存する

### 4.2 next_chunks

`nextChunks` 関数は以下の処理を行う:

1. 実行状態ファイルとレシピファイルを読み込む
2. 全チャンクを以下のカテゴリに分類する:
   - `done`: status が `done` のチャンク
   - `failed`: status が `failed` のチャンク。失敗チャンクは `readyIds` にも追加され、再実行可能として扱われる
   - `in_progress`: 何もしない（スキップ）
   - `pending` で全依存が `done`: `readyIds` に追加
   - `pending` で未解決の依存あり: `blocked` に追加
3. ready チャンクについて `PreparedChunk` を組み立てる:
   - `resolvePlaceholders` 関数で `{{file:path}}` 形式のプレースホルダを実際のファイル内容に置換する。ファイルが存在する場合は `// --- {path} ---\n{content}` 形式で埋め込み、存在しない場合は `// --- {path} (未生成) ---` を挿入する
   - `implementation_prompt` と `source_content` の両方でプレースホルダ解決を行い、さらに `implementation_prompt` 内の `{source_content}` を解決済み `source_content` で置換する
4. `progress` を `{done数}/{total} 完了` 形式の文字列で返す

### 4.3 complete_chunk

`completeChunk` 関数は以下の処理を行う:

1. 実行状態ファイルとレシピファイルを読み込む
2. 指定された `chunk_id` のチャンクとその状態を取得する。見つからない場合は `Error` をスローする

**ファイル存在検証**

- `expected_outputs` の各ファイルについて、`{working_dir}/{expected_output}` のパスで `access` を試みる
- アクセスできなかったファイルを `missingFiles` に記録する

**テスト実行**

- `recipe.tech_stack.test` が設定されており、かつファイルが全て存在する場合にテスト実行を試みる
- `generatedFiles` の中から `.test.`, `.spec.`, `__tests__` を含むファイルをテストファイルとして抽出する
- `{working_dir}/node_modules` が存在するか確認し、存在しなければテスト実行をスキップする
- テストファイルが存在し `node_modules` もある場合、`npx {test_framework} run {test_files}` を `timeout: 60000ms` で実行する

**完了判定**

- `filesExist` が `true` かつ `testsPassed` が `undefined`（テスト未実行）または `true` であれば成功とする
- 成功時: status を `done` に設定
- 失敗時: status を `failed` に設定し、`retry_count` を 1 増加させ、`error` にエラー詳細を記録する

**後続チャンクのアンロック**

- 成功時のみ、`depends_on` に当該チャンクを含む全チャンクについて、全依存が `done` になったかを確認する
- 全依存が解決されたチャンクを `newly_unblocked` に記録する

**状態ファイルの保存**

- 更新された実行状態を JSON 形式でファイルに書き戻す

### 4.4 execution_status

`executionStatus` 関数は以下の処理を行う:

1. 実行状態ファイルとレシピファイルを読み込む
2. 全チャンクの状態を集計する:
   - `done`: status が `done`
   - `in_progress`: status が `in_progress`
   - `failed`: status が `failed`
   - `pending`: status が `pending` で全依存が `done`
   - `blocked`: status が `pending` で未解決の依存あり
3. 各チャンクの詳細情報を組み立てる。`blocked_by` には status が `done` でない依存チャンクの ID 一覧を設定する。`retry_count` は 0 より大きい場合のみ設定する
4. `current_level` を判定する: `execution_order` の各レベルについて、そのレベルの全チャンクが `done` であるレベルまでを完了済みとし、次のレベルを現在のレベルとする
5. `estimated_remaining` は `{total - done} chunks` の文字列形式で返す

---

## 5. 実行アダプタ

### 5.1 claude-code

`ClaudeCodeExecutor` クラスは `ChunkExecutor` インターフェースを実装する。

**コンストラクタ**

デフォルト設定:
- `model`: `'sonnet'`
- `timeout`: `300000`（5分、ミリ秒）
- `allowedTools`: `['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']`

**`execute` メソッドの処理フロー**

1. `listFiles` 関数で実装前のファイル一覧（パスと mtime のマップ）を取得する。`node_modules` と `.git` は除外する
2. `buildPrompt` でプロンプトを構築する
3. `claude` CLI を以下の引数で実行する:
   - `-p {prompt}`: プロンプト指定（非対話モード）
   - `--output-format text`
   - `--model {model}`
   - `--max-turns 30`
   - `--allowedTools {tool}`: 各許可ツールについて繰り返し指定
   - `cwd`: `chunk.working_dir`
   - `maxBuffer`: 10MB
4. 実行後に再度 `listFiles` でファイル一覧を取得し、新規ファイルまたは mtime が更新されたファイルを `generatedFiles` として検出する
5. `generatedFiles` の中から `chunk.reference_doc` に一致するパスを `reference_doc` として分離する
6. CLI 実行が失敗した場合は `success: false` と `error` メッセージを返す

**`buildPrompt` のプロンプト構造**

```
# 実装指示: {chunk.name}

{chunk.implementation_prompt}

## 生成するファイル
- {expected_outputs の各項目}

## 完了条件
- {completion_criteria の各項目}

## リファレンスドキュメント

実装が完了したら、以下のパスにリファレンスドキュメントを作成してください: `{chunk.reference_doc}`

リファレンスには以下を日本語で記述してください:
- 実装したモジュール・関数の概要と役割
- 公開インターフェース（型、引数、戻り値）
- 設計文書のどの部分を実装したか
- 実装上の判断や補足事項

重要: 上記のファイルとリファレンスドキュメントを全て生成し、完了条件を満たすコードを書いてください。
テストファイルが含まれる場合は、テストが通ることを確認してください。
```

---

## 6. 型定義

`types.ts` で定義されている主要な型とその関係を以下に示す。

### レシピ関連

```
Recipe
  ├── project: string
  ├── created_at: string
  ├── builder_version: string
  ├── tech_stack: TechStack
  ├── chunks: Chunk[]
  └── execution_order: string[][]

TechStack
  ├── language: string
  ├── runtime?: string
  ├── db?: string
  ├── test?: string
  ├── platforms?: string[]
  ├── platform_notes?: string
  └── directory_structure?: string

Chunk
  ├── id: string
  ├── name: string
  ├── description: string
  ├── depends_on: string[]
  ├── source_docs: SourceDoc[]
  ├── source_content: string          # プレースホルダ含む（{{file:path}} 形式）
  ├── implementation_prompt: string
  ├── expected_outputs: string[]
  ├── completion_criteria: string[]
  ├── reference_doc: string
  ├── validation_context?: string
  ├── estimated_input_tokens: number
  └── estimated_output_tokens: number

SourceDoc
  ├── path: string
  ├── sections: string[]
  └── include: 'full' | 'partial'
```

### レシピエンジン関連

```
DraftChunk                             # split_chunks -> export_recipe の中間型
  ├── (Chunk と同じフィールド、ただし以下が異なる)
  ├── implementation_prompt_template   # {source_content} と {{file:path}} を含むテンプレート
  └── (source_content フィールドなし)

ExportRecipeInput
  ├── project: string
  ├── tech_stack: TechStack
  ├── chunks: DraftChunk[]
  ├── docs_dir: string
  ├── output_path: string
  └── include_source_content?: boolean  # デフォルト true

ExportRecipeResult
  ├── recipe_path: string
  ├── total_chunks: number
  ├── execution_order: string[][]
  └── warnings: string[]
```

### 文書分析関連

```
DocLayer = 'foundation' | 'specification' | 'usecase' | 'interface' | 'execution' | 'context'

DocFrontmatter
  ├── status?: string
  ├── layer?: DocLayer
  ├── decisions?: string[]
  └── open_questions?: string[]

AnalyzeDesignResult
  ├── project_name: string
  ├── drift_warnings: DriftWarning[]
  ├── documents: DocumentAnalysis[]
  ├── dependency_graph: Record<string, string[]>
  ├── layers: Record<DocLayer, string[]>
  ├── tech_stack: Partial<TechStack>
  └── total_tokens: number

DocumentAnalysis
  ├── path: string
  ├── lines: number
  ├── estimated_tokens: number
  ├── layer: DocLayer
  ├── sections: string[]
  ├── references_to: string[]
  ├── referenced_by: string[]
  └── frontmatter?: DocFrontmatter

DriftWarning
  ├── reference: string
  ├── commits_since: number
  ├── changed_files: string[]
  └── message: string

Decision
  ├── id: string
  ├── decision: string
  ├── affected_docs: string[]
  └── decided_at: string

SplitChunksInput
  ├── analysis: AnalyzeDesignResult
  ├── strategy?: 'bottom_up'
  ├── constraints?: { max_input_tokens?, max_output_tokens?, max_source_docs?, max_output_files? }
  └── docs_dir: string

SplitChunksResult
  ├── chunks: DraftChunk[]
  ├── execution_order: string[][]
  ├── needs_review: boolean
  └── review_notes: string[]
```

### 実行状態関連

```
ChunkStatus = 'pending' | 'in_progress' | 'done' | 'failed'

ChunkState
  ├── status: ChunkStatus
  ├── started_at: string | null
  ├── completed_at: string | null
  ├── outputs: string[]
  ├── retry_count: number
  └── error?: string

ExecutionState
  ├── recipe_path: string
  ├── working_dir: string
  ├── started_at: string
  └── chunks: Record<string, ChunkState>
```

### 実行アダプタ関連

```
PreparedChunk
  ├── id: string
  ├── name: string
  ├── implementation_prompt: string     # プレースホルダ解決済み
  ├── expected_outputs: string[]
  ├── completion_criteria: string[]
  ├── reference_doc: string
  └── working_dir: string

ExecutionResult
  ├── success: boolean
  ├── generated_files: string[]
  ├── reference_doc?: string
  └── error?: string

ChunkExecutor                           # インターフェース
  └── execute(chunk: PreparedChunk): Promise<ExecutionResult>
```

### ツール出力関連

```
LoadRecipeResult
  ├── project: string
  ├── total_chunks: number
  ├── ready_chunks: string[]
  └── execution_state_path: string

NextChunksResult
  ├── ready: PreparedChunk[]
  ├── blocked: string[]
  ├── done: string[]
  ├── failed: string[]
  └── progress: string

CompleteChunkResult
  ├── chunk_id: string
  ├── status: 'done' | 'failed'
  ├── verification: { files_exist, missing_files?, tests_passed?, test_errors?, criteria_met? }
  └── newly_unblocked: string[]

ExecutionStatusResult
  ├── progress: { done, in_progress, pending, failed, blocked, total }
  ├── chunks: Array<{ id, name, status, blocked_by?, retry_count? }>
  ├── current_level: number
  └── estimated_remaining: string
```

---

## 7. MCP サーバー構成

`index.ts` で `McpServer`（名前: `cdd-builder`、バージョン: `0.1.0`）に以下の 8 ツールを登録している。トランスポートは `StdioServerTransport` を使用する。

### レシピエンジン（4 ツール）

| ツール名 | 説明 | 入力パラメータ |
|---|---|---|
| `analyze_design` | 設計文書群を構造分析する | `doc_paths: string[]`, `project_name: string`, `project_dir?: string` |
| `split_chunks` | 設計分析結果をもとにチャンクに分割する | `analysis: any`, `docs_dir: string`, `strategy?: 'bottom_up'`, `constraints?: object` |
| `validate_refs` | 設計文書間の参照整合性をチェックする | `doc_paths: string[]` |
| `export_recipe` | チャンク群をレシピファイルとして出力する | `project: string`, `tech_stack: any`, `chunks: any`, `docs_dir: string`, `output_path: string`, `include_source_content?: boolean` |

### 実行エンジン（4 ツール）

| ツール名 | 説明 | 入力パラメータ |
|---|---|---|
| `load_recipe` | レシピファイルを読み込み、実行状態を初期化する | `recipe_path: string`, `working_dir?: string` |
| `next_chunks` | 依存が解決済みのチャンクを返す | `execution_state_path: string` |
| `complete_chunk` | チャンクの完了を検証し、記録する | `execution_state_path: string`, `chunk_id: string`, `generated_files: string[]` |
| `execution_status` | 全体の実行進捗を可視化する | `execution_state_path: string` |

全ツールの戻り値は `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` 形式で統一されている。
