# CDD-Planner リファレンスドキュメント

## 1. モジュール構成の概要

### ファイル構成

```
planner/src/
  index.ts                    # MCP サーバーのエントリポイント（ツール登録・起動）
  types.ts                    # 全モジュール共有の型定義
  tools/
    clarify-idea.ts           # clarify_idea ツール実装
    suggest-approach.ts       # suggest_approach ツール実装
    design-context.ts         # design_context ツール実装
    track-decision.ts         # track_decision ツール実装
    check-consistency.ts      # check_consistency ツール実装
    check-readiness.ts        # check_readiness ツール実装
  utils/
    frontmatter.ts            # YAML フロントマター解析
    markdown.ts               # Markdown 構造解析・トークン推定・レイヤー推定
    decisions.ts              # decisions.jsonl の読み書き・ID 生成
```

### 各モジュールの役割

| モジュール | 役割 |
|---|---|
| `index.ts` | MCP サーバー (`cdd-planner` v0.1.0) を構築し、6 つのツールを登録して stdio トランスポートで起動する |
| `types.ts` | 全ツールの入出力型、共有型（`DocLayer`, `DocStatus`, `Issue` 等）を定義する |
| `clarify-idea.ts` | ユーザーの曖昧な構想を 4 軸で分析し、深掘り質問と類似アプローチを返す |
| `suggest-approach.ts` | アイデアに対して設計の切り口（アプローチ）をコア 3 種 + 拡張 5 種から提案する |
| `design-context.ts` | プロジェクトディレクトリの `.md` ファイルをスキャンし、進捗・参照関係・未決事項のスナップショットを生成する |
| `track-decision.ts` | 決定事項を `decisions.jsonl` に構造化記録し、影響文書のステータスを返す |
| `check-consistency.ts` | 設計文書群の整合性を 5 カテゴリでチェックし、問題を報告する |
| `check-readiness.ts` | 設計文書群が Builder にハンドオフ可能かを総合判定する |
| `frontmatter.ts` | `---` で囲まれた YAML フロントマターを簡易パースする |
| `markdown.ts` | セクション抽出、wiki-link 抽出、トークン推定、ステータス推定、未決事項抽出、レイヤー推定を行う |
| `decisions.ts` | `decisions.jsonl` の読み込み・追記・ID 連番生成を行う |

---

## 2. 公開インターフェース

### 2.1 clarify_idea

```typescript
function clarifyIdea(input: ClarifyIdeaInput): ClarifyIdeaResult
```

- **入力**: `ClarifyIdeaInput`
  - `raw_idea: string` -- ユーザーの生のアイデアテキスト
  - `existing_context?: string | null` -- 既存のコンテキスト情報（任意）
- **出力**: `ClarifyIdeaResult`
  - `understood: { core_desire: string | null, pain_point: string | null, implied_scope: string | null }`
  - `axes: AxisStatus[]` -- 4 軸の充足状態
  - `fulfillment: number` -- 充足軸数 (0-4)
  - `mode: 'diverge' | 'converge' | 'transition'`
  - `questions: TemplateQuestion[]` -- 深掘り質問
  - `similar_approaches: SimilarApproach[]` -- 類似アプローチ

### 2.2 suggest_approach

```typescript
function suggestApproach(input: SuggestApproachInput): SuggestApproachResult
```

- **入力**: `SuggestApproachInput`
  - `idea: string` -- 設計対象のアイデア
  - `context?: string | null` -- 既存の design_context 出力など（任意）
  - `constraints?: string[]` -- 技術的制約条件（任意）
- **出力**: `SuggestApproachResult`
  - `approaches: Approach[]` -- 提案されたアプローチ群
  - `recommendation: string` -- 推奨順序の説明テキスト

### 2.3 design_context

```typescript
async function designContext(input: DesignContextInput): Promise<DesignContextResult>
```

- **入力**: `DesignContextInput`
  - `project_dir: string` -- 設計文書が格納されたディレクトリパス
- **出力**: `DesignContextResult`
  - `project: string` -- ディレクトリ名から推定したプロジェクト名
  - `documents: DocumentSummary[]` -- 各文書のサマリー
  - `overall_progress: OverallProgress` -- 全体進捗
  - `unresolved_questions: UnresolvedQuestion[]` -- 未解決質問一覧
  - `dependency_graph: Record<string, string[]>` -- 文書間の依存グラフ
  - `total_tokens: number` -- 全文書の推定トークン合計

### 2.4 track_decision

```typescript
async function trackDecision(input: TrackDecisionInput): Promise<TrackDecisionResult>
```

- **入力**: `TrackDecisionInput`
  - `project_dir: string` -- プロジェクトディレクトリパス
  - `decision: string` -- 決定内容
  - `rationale: string` -- 決定の理由
  - `affects: string[]` -- 影響を受ける文書ファイル名の配列
  - `supersedes?: string | null` -- 置き換える旧方針（任意）
- **出力**: `TrackDecisionResult`
  - `decision_id: string` -- 生成された決定 ID (例: `DEC-001`)
  - `recorded_at: string` -- 記録日時 (ISO 8601)
  - `affected_documents_status: AffectedDocStatus[]` -- 影響文書の存在チェック結果

### 2.5 check_consistency

```typescript
async function checkConsistency(input: CheckConsistencyInput): Promise<CheckConsistencyResult>
```

- **入力**: `CheckConsistencyInput`
  - `project_dir: string` -- プロジェクトディレクトリパス
  - `focus?: ConsistencyCategory[]` -- チェック対象カテゴリ（省略時は全 5 カテゴリ）
- **出力**: `CheckConsistencyResult`
  - `status: 'ok' | 'warn' | 'error'` -- 総合ステータス
  - `issues: Issue[]` -- 検出された問題一覧
  - `summary: { errors: number, warnings: number, info: number }` -- 集計

### 2.6 check_readiness

```typescript
async function checkReadiness(
  input: CheckReadinessInput,
  deps?: ReadinessDeps
): Promise<CheckReadinessResult>
```

- **入力**: `CheckReadinessInput`
  - `project_dir: string` -- プロジェクトディレクトリパス
  - `required_coverage?: string[]` -- 必要な設計領域（任意）
- **DI 引数**: `ReadinessDeps`（省略時はデフォルト実装を使用）
  - `getDesignContext: (projectDir: string) => Promise<DesignContextResult>`
  - `getConsistency: (projectDir: string) => Promise<CheckConsistencyResult>`
- **出力**: `CheckReadinessResult`
  - `ready: boolean` -- Builder に渡せる状態か
  - `blockers: Blocker[]` -- ブロッカー一覧
  - `warnings: Warning[]` -- 警告一覧
  - `handoff_summary: string` -- ハンドオフサマリーテキスト

---

## 3. 各ツールの実装ロジック

### 3.1 clarify_idea

#### 処理の流れ

1. `extractFromInput` で入力テキストから `core_desire`, `pain_point`, `implied_scope` を抽出する
2. `checkAxisFulfillment` で 4 軸の充足状態を判定する
3. 充足軸数を数えて `determineMode` でモードを決定する
4. `selectQuestions` で未充足軸に対応する質問を選択する
5. `findSimilarApproaches` で類似アプローチを検索する

#### テンプレート質問の 4 軸

| 軸キー | ラベル | キーワード（正規表現） | 質問例 |
|---|---|---|---|
| `target_user` | 対象ユーザー | `/自分/`, `/チーム/`, `/誰/`, `/ユーザー/`, `/使う人/`, `/個人/`, `/組織/` | 「誰が使いますか？ 自分だけ？ チームで共有？」「技術者向け？ 非技術者も使う？」 |
| `value` | 価値 | `/嬉しい/`, `/不満/`, `/面倒/`, `/ダルい/`, `/困/`, `/解決/`, `/楽/`, `/便利/`, `/効率/` | 「今の何が一番不満ですか？」「これができたら何が嬉しいですか？」 |
| `scope` | スコープ | `/個人用/`, `/配布/`, `/公開/`, `/OSS/`, `/プロダクト/`, `/MVP/`, `/最小/`, `/まず/` | 「個人用ツール？ それとも配布・公開する？」「まず最小限でいいなら、どこまでが「最小」？」 |
| `constraints` | 制約 | `/技術/`, `/言語/`, `/TypeScript/`, `/Python/`, `/Obsidian/`, `/SQLite/`, `/既存/`, `/前提/`, `/縛り/` | 「技術的な前提や縛りはありますか？」「既に決まっていること・変えられないことはありますか？」 |

#### キーワードマッチングのロジック

- `checkAxisFulfillment`: `raw_idea` と `existing_context` を結合したテキストに対し、各軸の `keywords` 配列の正規表現でマッチを試行する。いずれか 1 つでもマッチすれば、その軸は `filled: true` となる。マッチした場合、テキストを `。` または `\n` で分割した文のうち、最初にマッチしたものを `extracted` フィールドに格納する。

#### モード判定のロジック

`determineMode` 関数は充足軸数 (`fulfillment`) に基づく:

| 充足軸数 | モード | 意味 |
|---|---|---|
| 0-1 | `diverge` | 拡散フェーズ（情報がまだ少ない） |
| 2-3 | `converge` | 収束フェーズ（ある程度情報がある） |
| 4 | `transition` | 遷移フェーズ（全軸充足、次のステップへ） |

#### 質問選択のロジック

`selectQuestions`: 未充足の軸について、各軸の `questions` 配列の先頭 1 問を選択する。最大 4 問まで返す。

#### 類似アプローチ検索

`findSimilarApproaches`: `raw_idea` と `existing_context` の結合テキストに対し、8 件の `SIMILAR_APPROACHES` エントリのキーワードでマッチを試行する。マッチしたエントリを最大 3 件まで返す。

登録されている類似アプローチ: `mem0`, `Claude の auto-memory`, `Obsidian + Dataview`, `LangChain Memory`, `llama-index`, `Letta (MemGPT)`, `OpenAI Assistants API`, `Notion API`

#### 入力テキスト抽出ロジック (`extractFromInput`)

テキストを `。` または `\n` で文に分割し、以下の正規表現で最初にマッチした文を抽出する:

- `core_desire`: `/したい|ほしい|欲しい|作りたい|できたら|want/i` -- マッチなしの場合は最初の文を使用
- `pain_point`: `/不満|面倒|ダルい|困|つらい|問題|毎回|繰り返し/i`
- `implied_scope`: `/個人|チーム|配布|公開|ローカル|サーバー/i`

---

### 3.2 suggest_approach

#### 処理の流れ

1. `idea`, `context`, `constraints` を空白区切りで結合する
2. コア 3 テンプレートは常に結果に含める
3. 拡張 5 テンプレートは結合テキストに対するキーワードマッチで選択する
4. `generateRecommendation` で推奨テキストを生成する

#### コア 3 テンプレート（常時返却）

| アプローチ名 | source | 推奨文書 | 適用条件 |
|---|---|---|---|
| ユースケース駆動 | `core` | ユーザー側ユースケース一覧、AI側ユースケース一覧 | 要件が曖昧な初期段階 |
| データモデル駆動 | `core` | ER図 / テーブル定義、データフロー図 | データ構造が核心のシステム |
| インターフェース駆動 | `core` | API / CLI 仕様書、操作フロー図 | 操作体験が重要なツール |

#### 拡張 5 テンプレート（キーワードマッチで選択）

| アプローチ名 | source | キーワード（正規表現） | 推奨文書 | 適用条件 |
|---|---|---|---|---|
| ポリシー駆動 | `extended` | `/ポリシー/`, `/権限/`, `/セキュリティ/`, `/制限/`, `/許可/`, `/禁止/`, `/アクセス制御/`, `/認証/`, `/認可/` | ポリシー定義書、アクセス制御仕様 | 権限・制約が多いシステム |
| 脅威駆動 | `extended` | `/脅威/`, `/攻撃/`, `/セキュリティ/`, `/脆弱/`, `/サンドボックス/`, `/外部入力/`, `/バリデーション/` | 脅威モデル、セキュリティ設計書 | 外部入力を扱うシステム |
| 比較駆動 | `extended` | `/既存/`, `/比較/`, `/差別化/`, `/競合/`, `/類似/`, `/代替/`, `/との違い/` | 既存ツール比較表、差別化ポイント整理 | 類似サービスが存在する領域 |
| イベント駆動 | `extended` | `/イベント/`, `/トリガー/`, `/リアクティブ/`, `/非同期/`, `/Webhook/`, `/通知/`, `/サブスクリ/` | イベントカタログ、状態遷移図 | リアクティブ・非同期処理が多いシステム |
| ワークフロー駆動 | `extended` | `/ワークフロー/`, `/業務/`, `/手順/`, `/フロー/`, `/パイプライン/`, `/自動化/`, `/ステップ/` | 業務フロー図、ステップ定義書 | 人間の作業フローを自動化するシステム |

#### レコメンデーション生成ロジック (`generateRecommendation`)

- 拡張テンプレートのマッチなし、かつ制約に `Obsidian` を含む場合:
  - `"ユースケース駆動 → データモデル → インターフェースの順がおすすめ。Obsidian で文書を管理するなら、ユースケース一覧から始めると全体像を把握しやすい"`
- 拡張テンプレートのマッチなし、Obsidian なしの場合:
  - `"ユースケース駆動 → データモデル → インターフェースの順がおすすめ"`
- 拡張テンプレートのマッチありの場合:
  - `"ユースケース駆動で全体像を掴んだ後、${マッチした拡張名}で深掘りするのが効果的"`

---

### 3.3 design_context

#### 処理の流れ

1. **ディレクトリスキャン**: `readdir` で `project_dir` 内の `.md` ファイルをソートして列挙する
2. **文書パース**: 各ファイルについて `parseFrontmatter` でフロントマターを解析し、`ParsedDocument` オブジェクトを構築する。`extractSectionNames`, `extractWikiLinks`, `estimateTokens` をそれぞれ適用する
3. **依存グラフ構築**: 各文書の wiki-link から、プロジェクト内に実在する文書への参照を `dependencyGraph` として構築する。自己参照は除外する。キーは `ファイル名.md`、値は参照先の `ファイル名.md` の配列
4. **逆参照マップ構築**: `dependencyGraph` を反転して `referencedByMap` を構築する
5. **決定事項の文書割り当て**: `loadDecisions` で `decisions.jsonl` を読み込み、各決定の `affects` フィールドに基づいて文書ごとの決定 ID リストを構築する
6. **DocumentSummary 組み立て**: フロントマターの `status` / `layer` がある場合はそれを使い、ない場合は `inferDocStatus` / `inferLayer` でヒューリスティックに推定する。`decisions` と `open_questions` はフロントマター由来と本文抽出の和集合（重複排除）
7. **進捗サマリー計算**: 各ステータス (`complete`, `in_progress`, `draft`) の文書数を集計する
8. **readiness 判定**:
   - 全文書が `complete` → `ready`
   - `draft` が 0 件、かつ `complete` でない文書に未解決質問がない → `nearly_ready`
   - それ以外 → `not_ready`
9. **未解決質問収集**: 各文書の `open_questions` をフラット化し、`blocking` フラグはその文書の `status` が `complete` でなければ `true`
10. **プロジェクト名**: `basename(project_dir)` から推定する

---

### 3.4 track_decision

#### 処理の流れ

1. `loadDecisions` で既存の決定事項を読み込む
2. `generateDecisionId` で次の連番 ID を生成する（例: 既存最大が `DEC-003` なら `DEC-004`）
3. `Decision` オブジェクトを構築する（`created_at` は `new Date().toISOString()`）
4. `appendDecision` で `decisions.jsonl` に 1 行追記する（JSON 文字列 + 改行）
5. `affects` に指定された各文書について `fs.access` で存在チェックを行う
6. 全影響文書の `needs_update` は常に `true` として返す

---

### 3.5 check_consistency

#### 処理の流れ

1. `focus` が指定されていればそのカテゴリのみ、指定なしなら全 5 カテゴリを実行する
2. 各カテゴリのチェッカー関数を `switch` で呼び出し、結果の `Issue[]` を集約する
3. severity の集計から総合ステータスを決定する: `error` が 1 件以上あれば `'error'`、`warn` が 1 件以上あれば `'warn'`、それ以外は `'ok'`

#### 5 つのチェックカテゴリの検出ロジック

##### terminology（用語の揺れ）

- 全文書のバッククォート (`` ` ``) 内の用語を収集する（2 文字未満は除外）
- 用語を小文字化し、`_`, `-`, 空白を除去して正規化する
- 正規化後の同一キーに対して 2 つ以上のバリアントが存在する場合、severity `warn` で「用語の揺れ」として報告する
- 各バリアントの出現文書名と行番号を `locations` に含める

##### references（参照の整合性）

2 種類のチェックを行う:

1. **wiki-link リンク切れ**: 各文書の `[[wiki-link]]` のリンク先が、プロジェクト内の `.md` ファイル名（拡張子なし）として存在するか確認する。存在しない場合、severity `warn` で報告する
2. **UC/AC 欠番**: 全文書から `UC-N` / `AC-N` パターンの ID を収集し、1 から最大値までの連番に欠番がないか確認する。欠番がある場合、severity `warn` で報告する

##### coverage（カバレッジ）

1. `UC-N` または `AC-N` を含む文書を「ユースケース文書」として特定する
2. ユースケース文書がない場合（かつ文書が 2 件以上ある場合）、severity `info` で報告する
3. ユースケース文書がある場合、ユースケース文書の wiki-link から参照されていない設計文書を severity `info` で報告する

##### decisions（決定事項の整合性）

3 種類のチェックを行う:

1. `decisions.jsonl` の各決定の `affects` に記載された文書がプロジェクト内に存在するか確認する。存在しない場合、severity `warn`
2. 影響文書のフロントマター `decisions` に、対応する決定 ID が記載されているか確認する。記載がない場合、severity `info`
3. 文書のフロントマター `decisions` に記載された ID が `decisions.jsonl` に存在するか確認する。存在しない場合、severity `warn`

##### staleness（鮮度）

- 各文書のフロントマター `last_reviewed` の日付と、その文書に影響する決定事項の `created_at` を比較する
- `last_reviewed` より後に記録された決定事項がある場合、severity `warn` で「更新が必要」として報告する

---

### 3.6 check_readiness

#### 処理の流れ

1. `designContext` と `checkConsistency` を `Promise.all` で並列実行する
2. 以下の 5 項目をチェックし、`blockers` と `warnings` を収集する
3. `blockers` が 0 件なら `ready: true`
4. ハンドオフサマリーテキストを生成する

#### チェック項目

| 順序 | チェック | 種別 | 条件 |
|---|---|---|---|
| 1 | 文書完了チェック | blocker | `status` が `complete` でない文書がある場合 |
| 2 | 未決事項チェック | blocker | `blocking: true` の未解決質問がある場合 |
| 3 | 整合性エラーチェック | blocker | `check_consistency` の結果に severity `error` がある場合 |
| 3 | 整合性警告チェック | warning | `check_consistency` の結果に severity `warn` がある場合 |
| 4 | カバレッジチェック | blocker | `required_coverage` に指定された領域が、文書のレイヤー・セクション名・ファイルパスのいずれにも見つからない場合 |
| 5 | 技術選定チェック | warning | 文書が 3 件以上あり、セクション名に `/技術|tech|言語|language/i` を含む文書も、ファイル名に `/TypeScript|Python|Rust|Go|Java/i` を含む文書もない場合 |

#### DI パターン

`checkReadiness` の第 2 引数 `deps: ReadinessDeps` で `designContext` と `checkConsistency` の実装を差し替えられる。デフォルトでは実際のツール実装が使われる。テスト時にモック注入が可能。

```typescript
export interface ReadinessDeps {
  getDesignContext: (projectDir: string) => Promise<DesignContextResult>
  getConsistency: (projectDir: string) => Promise<CheckConsistencyResult>
}
```

---

## 4. ユーティリティ

### 4.1 frontmatter.ts

#### `parseFrontmatter(content: string): { frontmatter: DocFrontmatter | null; body: string }`

YAML フロントマター（`---` で囲まれた部分）を簡易パースする。

- コンテンツが `---` で始まらない場合、または閉じ `---` が見つからない場合は `frontmatter: null` を返す
- YAML ブロック内の各行を `:` で分割し、キーと値を取得する
- `status`: `draft`, `in_progress`, `complete` のいずれかの場合のみ格納する
- `layer`: `foundation`, `specification`, `usecase`, `interface`, `execution`, `context` のいずれかの場合のみ格納する
- `last_reviewed`: 値をそのまま文字列として格納する
- `decisions`, `open_questions`, `tags`: `- ` で始まるリスト項目を配列として格納する
- パース結果のオブジェクトにキーが 1 つもなければ `null` を返す

### 4.2 markdown.ts

#### `extractSectionNames(content: string): string[]`

`##` 〜 `####` レベルの見出し行からセクション名を抽出する。`#`（h1）は対象外。

#### `extractWikiLinks(content: string): string[]`

`[[リンク名]]` 形式の wiki-link を抽出する。重複排除あり。

- インラインコード（`` ` `` で囲まれた部分）は事前に除去する
- `[[リンク名#セクション]]` のセクション指定は無視し、リンク名部分のみ取得する
- `[[リンク名|表示名]]` のパイプ前部分（リンク名）のみ取得する
- 末尾 `.md` は除去する

#### `estimateTokens(text: string): number`

テキストのトークン数を推定する。

- CJK 文字 (U+3000-U+9FFF, U+F900-U+FAFF): 1 文字 = 2 トークン
- その他の文字: 1 文字 = 0.25 トークン
- 結果は `Math.ceil` で切り上げ

#### `inferDocStatus(content: string, sections: string[]): DocStatus`

フロントマターに `status` がない場合のフォールバック推定。

- `TBD`, `TODO`, `WIP`, `未定`, `要検討` のいずれかが含まれる → `draft`
- セクション数が 1 以下 → `draft`
- それ以外 → `complete`

#### `extractOpenQuestions(content: string): string[]`

本文から未決事項を抽出する。以下のパターンにマッチした行の内容を返す:

- `- [ ]` で始まる行（チェックボックス未チェック）
- `Q:` または `Q：` で始まる行
- `- ` で始まり、`未決`, `要検討`, `TBD`, `TODO` を含むリスト項目

#### `inferLayer(docName: string, content: string): DocLayer`

ファイル名と内容からレイヤーを推定する。3 段階で判定する:

1. **ファイル名ヒント** (`NAME_HINTS`): ファイル名が以下のパターンにマッチすれば即決定

   | パターン | レイヤー |
   |---|---|
   | `/usecase/i` | `usecase` |
   | `/cli/i` | `interface` |
   | `/mcp.*tool/i` | `interface` |
   | `/spec/i` | `specification` |
   | `/security/i` | `specification` |
   | `/policy/i` | `specification` |
   | `/basic.*design/i` | `foundation` |
   | `/todo/i` | `context` |
   | `/comparison/i` | `context` |
   | `/prior.*art/i` | `context` |
   | `/operation/i` | `execution` |
   | `/benchmark/i` | `execution` |
   | `/flow/i` | `execution` |

2. **内容ヒューリスティック（2 パターン以上マッチ）**: 本文に対して各レイヤーの正規表現パターンを試行し、2 つ以上マッチしたレイヤーを返す

3. **内容ヒューリスティック（1 パターン以上マッチ）**: 1 つ以上マッチしたレイヤーを返す

4. **デフォルト**: いずれもマッチしなければ `context` を返す

   各レイヤーのパターン:

   | レイヤー | パターン |
   |---|---|
   | `usecase` | `/\bUC-\d+\b/`, `/\bAC-\d+\b/`, `/ユースケース/i`, `/use\s*case/i` |
   | `interface` | `/\bMCP\b.*ツール/`, `/\bCLI\b/`, `/\bAPI\b.*エンドポイント/`, `/コマンド一覧/` |
   | `execution` | `/操作フロー/`, `/ベンチマーク/`, `/デプロイ/`, `/運用/` |
   | `context` | `/比較/`, `/ToDo/i`, `/参考/`, `/prior.*art/i`, `/バックログ/` |
   | `specification` | `/仕様/`, `/spec/i`, `/プロトコル/`, `/ポリシー/`, `/セキュリティ/` |
   | `foundation` | `/基本設計/`, `/アーキテクチャ/`, `/ER図/`, `/テーブル定義/`, `/データモデル/` |

### 4.3 decisions.ts

#### `loadDecisions(projectDir: string): Promise<Decision[]>`

`{projectDir}/decisions.jsonl` を読み込み、各行を `JSON.parse` して `Decision[]` として返す。ファイルが存在しない場合は空配列を返す。

#### `generateDecisionId(existing: Decision[]): string`

既存の決定 ID から次の連番を生成する。`DEC-NNN` 形式（3 桁ゼロパディング）。

- 既存が空の場合は `DEC-001`
- 既存の ID から `DEC-(\d+)` パターンで数値を抽出し、最大値 + 1 を返す

#### `appendDecision(projectDir: string, decision: Decision): Promise<void>`

`{projectDir}/decisions.jsonl` に `JSON.stringify(decision) + '\n'` を追記する。`appendFile` を使用する。

---

## 5. 型定義

### 5.1 共有型

| 型名 | 種別 | 説明 |
|---|---|---|
| `DocLayer` | union | `'foundation' \| 'specification' \| 'usecase' \| 'interface' \| 'execution' \| 'context'` -- 文書レイヤー 6 種 |
| `DocStatus` | union | `'draft' \| 'in_progress' \| 'complete'` -- 文書ステータス 3 種 |
| `DocFrontmatter` | interface | フロントマターの構造。全フィールド optional: `status`, `layer`, `last_reviewed`, `decisions`, `open_questions`, `tags` |
| `Decision` | interface | 決定事項。`id`, `decision`, `rationale`, `affects`, `supersedes`, `created_at` |
| `IssueSeverity` | union | `'error' \| 'warn' \| 'info'` |
| `Issue` | interface | 問題報告。`category`, `severity`, `message`, `suggestion?`, `locations?` |
| `ParsedDocument` | interface | パース済み文書。`path`, `name`, `content`, `body`, `frontmatter`, `lines`, `sections`, `wikiLinks`, `estimatedTokens` |

### 5.2 ツール固有型

| 型名 | 所属ツール | 説明 |
|---|---|---|
| `ClarifyIdeaInput` | clarify_idea | 入力: `raw_idea`, `existing_context?` |
| `ClarifyIdeaResult` | clarify_idea | 出力: `understood`, `axes`, `fulfillment`, `mode`, `questions`, `similar_approaches` |
| `AxisKey` | clarify_idea | `'target_user' \| 'value' \| 'scope' \| 'constraints'` |
| `AxisStatus` | clarify_idea | 軸の充足状態: `axis`, `label`, `filled`, `extracted?` |
| `TemplateQuestion` | clarify_idea | テンプレート質問: `question`, `why`, `axis` |
| `SimilarApproach` | clarify_idea | 類似アプローチ: `name`, `relevance` |
| `SuggestApproachInput` | suggest_approach | 入力: `idea`, `context?`, `constraints?` |
| `SuggestApproachResult` | suggest_approach | 出力: `approaches`, `recommendation` |
| `ApproachSource` | suggest_approach | `'core' \| 'extended'` |
| `Approach` | suggest_approach | アプローチ: `name`, `description`, `source`, `suggested_documents`, `good_for` |
| `DesignContextInput` | design_context | 入力: `project_dir` |
| `DesignContextResult` | design_context | 出力: `project`, `documents`, `overall_progress`, `unresolved_questions`, `dependency_graph`, `total_tokens` |
| `DocumentSummary` | design_context | 文書サマリー: `path`, `status`, `layer`, `estimated_tokens`, `sections`, `decisions`, `open_questions`, `references_to`, `referenced_by`, `last_reviewed?` |
| `OverallProgress` | design_context | 進捗: `complete`, `in_progress`, `draft`, `total`, `readiness` |
| `UnresolvedQuestion` | design_context | 未解決質問: `source`, `question`, `blocking` |
| `TrackDecisionInput` | track_decision | 入力: `project_dir`, `decision`, `rationale`, `affects`, `supersedes?` |
| `TrackDecisionResult` | track_decision | 出力: `decision_id`, `recorded_at`, `affected_documents_status` |
| `AffectedDocStatus` | track_decision | 影響文書: `path`, `needs_update`, `exists` |
| `CheckConsistencyInput` | check_consistency | 入力: `project_dir`, `focus?` |
| `CheckConsistencyResult` | check_consistency | 出力: `status`, `issues`, `summary` |
| `ConsistencyCategory` | check_consistency | `'terminology' \| 'references' \| 'coverage' \| 'decisions' \| 'staleness'` |
| `CheckReadinessInput` | check_readiness | 入力: `project_dir`, `required_coverage?` |
| `CheckReadinessResult` | check_readiness | 出力: `ready`, `blockers`, `warnings`, `handoff_summary` |
| `Blocker` | check_readiness | ブロッカー: `type`, `message`, `suggestion` |
| `Warning` | check_readiness | 警告: `type`, `message` |

### 5.3 型の関係

- `DocFrontmatter` は `DocStatus` と `DocLayer` を参照する
- `Issue` は `IssueSeverity` を使用する
- `ClarifyIdeaResult` は `AxisStatus`, `TemplateQuestion`, `SimilarApproach` を含む
- `DesignContextResult` は `DocumentSummary`, `OverallProgress`, `UnresolvedQuestion` を含む
- `DocumentSummary` は `DocStatus` と `DocLayer` を使用する
- `CheckConsistencyResult` は `Issue` を使用する
- `CheckReadinessResult` は `Blocker` と `Warning` を含む
- `check-readiness.ts` は `DesignContextResult` と `CheckConsistencyResult` に依存する（DI 経由）

---

## 6. MCP サーバー構成

### サーバー情報

- **サーバー名**: `cdd-planner`
- **バージョン**: `0.1.0`
- **SDK**: `@modelcontextprotocol/sdk`
- **トランスポート**: `StdioServerTransport`（標準入出力）
- **バリデーション**: `zod`

### ツール登録一覧

| ツール名 | 説明 | Zod スキーマ |
|---|---|---|
| `clarify_idea` | 曖昧な構想を4軸で分析し、深掘り質問を生成する | `raw_idea: z.string()`, `existing_context: z.string().nullable().optional()` |
| `design_context` | 設計文書群をスキャンし、進捗・参照関係・未決事項のスナップショットを返す | `project_dir: z.string()` |
| `suggest_approach` | 設計の切り口を提案する | `idea: z.string()`, `context: z.string().nullable().optional()`, `constraints: z.array(z.string()).optional()` |
| `track_decision` | 決定事項を decisions.jsonl に構造化記録する | `project_dir: z.string()`, `decision: z.string()`, `rationale: z.string()`, `affects: z.array(z.string())`, `supersedes: z.string().nullable().optional()` |
| `check_consistency` | 設計文書群の整合性を5カテゴリでチェックする | `project_dir: z.string()`, `focus: z.array(z.enum([...5カテゴリ])).optional()` |
| `check_readiness` | 設計文書群が Builder に渡せる状態かを判定する | `project_dir: z.string()`, `required_coverage: z.array(z.string()).optional()` |

### 起動方法

`index.ts` の `main()` 関数がエントリポイントとなる。`StdioServerTransport` を生成し、`server.connect(transport)` でサーバーを起動する。エラー時は `console.error` に出力する。

### 各ツールの応答形式

全ツール共通で、ツール実装の返り値を `JSON.stringify(result, null, 2)` でフォーマットし、`{ content: [{ type: 'text', text: ... }] }` の形式で返す。
