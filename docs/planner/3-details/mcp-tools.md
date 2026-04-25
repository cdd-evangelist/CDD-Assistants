---
status: complete
layer: interface
---

# Planner MCP ツール詳細設計書

更新日: 2026-04-11
対応コード: planner/src/

## 1. 概要

Planner が提供する 6 つの MCP ツールの入出力・処理フローを定義する。

対応する機能設計: [壁打ちフロー](../2-features/wall-hitting.md)

## 2. ツール一覧

| ツール | Phase | 概要 |
|---|---|---|
| `clarify_idea` | 0-1 | 曖昧な構想を受け取り、質問を生成する。規模判定（コンシェルジュ）を兼ねる |
| `design_context` | 3-4 | プロジェクトの設計状況を把握する |
| `suggest_approach` | 2 | 設計の切り口を提案する |
| `track_decision` | 3 | 決定事項を記録する |
| `check_consistency` | 4 | 設計文書群の整合性をチェックする |
| `check_readiness` | 5 | Builder にハンドオフ可能かを判定する |

## 3. ツール詳細

### 3.1 `clarify_idea`

曖昧な構想を受け取り、設計に進むための問いを生成する。Phase 0 の入口であり、**コンシェルジュ**（規模判定・ルート案内）の役割も担う。

**入力:**
```json
{
  "raw_idea": "AIと話してると毎回同じ説明するのがダルい。覚えててほしい",
  "existing_context": null
}
```

**処理ステップ:**
1. 入力テキストから「やりたいこと」「不満」「イメージ」を正規表現で抽出
2. 規模判定: 入力テキストからワンショットか CDD フルコースかを判定する
3. テンプレート質問から、キーワードマッチで未回答の項目を選出
4. 未回答の軸に対応するテンプレート質問を選択（各軸から先頭1問、最大4問）
5. 既知の類似プロダクト・アプローチがあればキーワードマッチで参考として提示（最大3件）

**規模判定（コンシェルジュ）:**

| シグナル | キーワード例 | 判定 |
|---------|------------|------|
| 使い捨て感 | 「とりあえず」「急ぎで」「やっつけ」「試しに」「さっと」 | ワンショット |
| 単機能 | 「スクリプト」「関数」「ワンライナー」「変換」「〜するやつ」 | ワンショット |
| プロジェクト感 | 「システム」「アプリ」「ツール群」「設計」「アーキテクチャ」 | CDD フルコース |
| 長期運用感 | 「チームで」「配布」「メンテ」「運用」「拡張」 | CDD フルコース |

- ワンショットのシグナルが強い → `route: "one-shot"` を返す
- CDD のシグナルが強い、またはどちらとも言えない → `route: "full"` を返す
- 判断に迷う場合は人に聞く（コンシェルジュは案内役であり、門番ではない）

**テンプレート質問（必ず確認する軸）:**

| 軸 | 質問例 |
|----|-------|
| 対象ユーザー | 誰が使う？ 自分だけ？ チーム？ |
| 価値 | 何が嬉しい？ 今の何が不満？ |
| スコープ | 個人用？ 配布する？ |
| 制約 | 技術的な前提や縛りはある？ |

**出力（CDD フルコース）:**
```json
{
  "route": "full",
  "understood": {
    "core_desire": "AI が過去の会話を記憶し、繰り返しの説明を不要にしたい",
    "pain_point": "セッションごとにコンテキストがリセットされる",
    "implied_scope": "会話履歴の永続化、文脈の自動復元"
  },
  "questions": [
    {
      "question": "覚えてほしいのは事実（名前、好み）？ それとも過去の議論の流れ？",
      "why": "記憶の粒度でアーキテクチャが大きく変わる"
    }
  ],
  "similar_approaches": [
    { "name": "mem0", "relevance": "LLM の記憶レイヤー。ただしホスト型" }
  ]
}
```

**出力（ワンショット）:**
```json
{
  "route": "one-shot",
  "understood": {
    "core_desire": "CSV を日付でソートするスクリプトが欲しい",
    "pain_point": null,
    "implied_scope": "スクリプト1本"
  },
  "questions": [],
  "similar_approaches": [],
  "one_shot_suggestion": "壁打ち不要で、そのまま実装に進めそうです。CDD で丁寧に設計しますか？"
}
```

**充足度判定と拡散/収束:**

全軸 ✅ → `mode: "transition"`（suggest_approach に進める）。1つでも ❓ → Phase 0 を継続。

充足度に応じてモードを切り替える:
- 充足度 低（0〜1軸）→ 拡散モード: 選択肢を広く提示し、発想を刺激する
- 充足度 中（2〜3軸）→ 収束モード: 散らばったアイデアを束ね、残りの軸に焦点を絞る
- 充足度 高（4軸）→ 遷移提案

### 3.2 `design_context`

プロジェクトの設計状況を把握する。セッション開始時や、長い壁打ちの途中で呼ぶ。

**入力:**
```json
{
  "project_dir": "path/to/Documents/AI-Ghost-Shell/"
}
```

**処理ステップ:**
1. ディレクトリ内の .md ファイルを列挙
2. 各文書のフロントマター or 先頭セクションからメタデータを抽出
3. 決定事項（Decision）と未決事項（Open Question）を収集
4. 文書間の参照関係を構築
5. 進捗サマリーを生成
6. 設計文書標準のパスを解決（プロジェクト内 `docs/design-doc-standard.md` → バンドル版フォールバックの順）

**設計文書標準パスの解決順序:**

1. プロジェクト内 `docs/design-doc-standard.md` が存在すれば、そのパスを返す（プロジェクト固有のカスタマイズを許容）
2. 存在しなければ、planner パッケージにバンドルされた標準文書（`planner/templates/design-doc-standard.md`）の絶対パスを返す
3. どちらも存在しない（バンドル破損等）場合は `null` を返す

エージェントは `standard_doc_path` を読んで、設計文書のフォルダ構成や品質ルールに従っているか自分で判断できる。

**出力:**
```json
{
  "project": "AI-Ghost-Shell",
  "documents": [
    {
      "path": "BasicDesign.md",
      "status": "complete",
      "summary": "DB スキーマ（5テーブル）、2エディション構成",
      "decisions": ["行番号ポインタで .jsonl を参照"],
      "open_questions": []
    }
  ],
  "overall_progress": {
    "complete": 12,
    "draft": 1,
    "planned": 1,
    "total": 14,
    "readiness": "not_ready"
  },
  "dependency_graph": {
    "BasicDesign.md": [],
    "ghost-security.md": ["BasicDesign.md"]
  },
  "total_tokens": 28500,
  "unresolved_questions": [
    {
      "source": "ghost-security.md",
      "question": "サンドボックス実行の具体的な実装方式",
      "blocking": false
    }
  ],
  "standard_doc_path": "/abs/path/to/docs/design-doc-standard.md"
}
```

### 3.3 `suggest_approach`

構想やアイデアに対して、設計の切り口を提案する。

**入力:**
```json
{
  "idea": "AIの人格設定を管理・配布するツールを作りたい",
  "context": "(design_context の出力)",
  "constraints": ["Obsidian で文書を書く", "実装は Builder に渡す"]
}
```

**アプローチテンプレート:**

コアテンプレート（ほぼ全プロジェクトで提案）:

| 名前 | 攻め方 | 向いている場面 |
|------|--------|--------------|
| ユースケース駆動 | 誰が何をするかから攻める | 要件が曖昧な初期段階 |
| データモデル駆動 | 何を保存するかから攻める | データ構造が核心のシステム |
| インターフェース駆動 | 外から見た振る舞いから攻める | 操作体験が重要なツール |

拡張テンプレート（キーワードマッチで追加提案）:

| 名前 | 攻め方 | 向いている場面 |
|------|--------|--------------|
| ポリシー駆動 | 何を許し何を禁じるかから攻める | 権限・制約が多いシステム |
| 脅威駆動 | セキュリティの観点から攻める | 外部入力を扱うシステム |
| 比較駆動 | 既存プロダクトとの差分から攻める | 類似サービスが存在する領域 |
| イベント駆動 | イベント・トリガーから攻める | リアクティブ・非同期処理が多いシステム |
| ワークフロー駆動 | 業務フロー・手順から攻める | 人間の作業フローを自動化するシステム |

**出力:**
```json
{
  "approaches": [
    {
      "name": "ユースケース駆動",
      "description": "誰が何をするかから攻める。機能の抜け漏れが出にくい",
      "source": "core",
      "suggested_documents": ["ユーザー側ユースケース一覧", "AI側ユースケース一覧"],
      "good_for": "要件が曖昧な初期段階"
    }
  ],
  "recommendation": "ユースケース駆動 → データモデル → ポリシーの順が効果的"
}
```

### 3.4 `track_decision`

壁打ち中の決定事項を記録する。文書への自動反映はしないが、後で文書を書く際の入力になる。

**記録の粒度:**
- 記録する: 他の文書に影響する方針決定（`affects` が1つ以上）
- 記録しない: 影響がその文書内で閉じる修正（見出し変更、サンプル修正等）

`track_decision` は **文書をまたぐ方針変更の専用ツール**。文書内の修正は普通に書き直せばいい。

**入力:**
```json
{
  "decision": "messages テーブルを廃止し、.jsonl を行番号ポインタで参照する",
  "rationale": "DB を軽量に保つため。ログは外部ファイルのままアクセスする",
  "affects": ["BasicDesign.md", "mcp-tools.md", "operation-flows.md"],
  "supersedes": "旧設計: messages テーブルにログを全件格納"
}
```

**処理ステップ:**
1. プロジェクトの決定ログ（`decisions.jsonl`）に追記
2. 影響する文書にフラグを立てる（要更新）

**出力:**
```json
{
  "decision_id": "DEC-012",
  "recorded_at": "2026-02-28T...",
  "affected_documents_status": [
    { "path": "BasicDesign.md", "needs_update": true },
    { "path": "mcp-tools.md", "needs_update": true },
    { "path": "operation-flows.md", "needs_update": true }
  ]
}
```

### 3.5 `check_consistency`

設計文書群の整合性をチェックする。

**入力:**
```json
{
  "project_dir": "path/to/Documents/AI-Ghost-Shell/",
  "focus": ["terminology", "references", "coverage"]
}
```

**チェック項目:**

| カテゴリ | チェック内容 |
|---------|------------|
| terminology | 同じ概念に異なる名称が使われていないか |
| references | 文書間リンクの整合性、存在しないセクションへの参照 |
| coverage | ユースケースに対応する設計文書があるか |
| decisions | 決定ログと文書の内容が一致しているか |
| staleness | 決定後に更新されていない文書がないか |

**出力:**
```json
{
  "status": "warn",
  "issues": [
    {
      "category": "terminology",
      "severity": "warn",
      "message": "episode-extraction.md では 'episodes'、BasicDesign.md では 'episode_memories'",
      "suggestion": "episode_memories に統一"
    }
  ],
  "summary": { "errors": 0, "warnings": 1, "info": 1 }
}
```

### 3.6 `check_readiness`

設計文書群が Builder に渡せる状態かを判定する。

**入力:**
```json
{
  "project_dir": "path/to/Documents/AI-Ghost-Shell/",
  "required_coverage": ["usecases", "data_model", "interfaces", "policies"]
}
```

**チェック項目:**

| 基準 | 内容 |
|------|------|
| 文書完了 | 全文書の status が complete |
| 未決事項 | blocking な open_question が残っていない |
| 整合性 | check_consistency で error がゼロ |
| カバレッジ | 必要な設計領域が全て文書化されている |
| 技術選定 | 言語、フレームワーク、ディレクトリ構成が決まっている |
| フォルダ構成 | 設計文書標準 §5.1 の構成に従っている（後述） |

**フォルダ構成検証:**

設計文書標準 §5.1 に定める標準構成は **Builder ハンドオフ時の必須要件**。`check_readiness` では以下のロジックで検証する。

1. **構成種別の判定**
   - 単一構成: project_dir 直下に `basic-design.md` がある
   - 複数コンポーネント構成: project_dir 直下に `basic-design.md` がなく、サブフォルダの少なくとも 1 つに `basic-design.md` がある（§5.4 のケース）
   - どちらにも該当しない場合は blocker（基本設計が見つからない）

2. **検証対象**
   - 単一構成: project_dir 直下を検証
   - 複数コンポーネント構成: `basic-design.md` を持つ各サブフォルダを検証

3. **判定ルール**

   | 項目 | 検証対象に存在 | 不在時の扱い |
   |---|---|---|
   | `basic-design.md` | ファイル | **blocker**（type: `missing_basic_design`） |
   | `3-details/` | フォルダ | **blocker**（type: `missing_details_dir`、Builder のチャンク化対象） |
   | `1-usecases/` | フォルダ | warning（type: `missing_usecases_dir`） |
   | `2-features/` | フォルダ | warning（type: `missing_features_dir`） |
   | `4-ref/` | フォルダ | 検証なし |

4. **複数コンポーネント構成では、コンポーネントごとに同じ判定を適用**し、blocker / warning には対象コンポーネント名を含める。

**出力:**
```json
{
  "ready": false,
  "blockers": [
    {
      "type": "missing_details_dir",
      "message": "Builder のチャンク化対象フォルダ 3-details/ が存在しない（component: planner）",
      "suggestion": "docs/planner/3-details/ を作成し、詳細設計文書を配置してください（設計文書標準 §5.1 参照）"
    }
  ],
  "warnings": [
    { "type": "missing_features_dir", "message": "推奨フォルダ 2-features/ が存在しない（component: builder）" },
    { "type": "consistency", "message": "用語の揺れが1件" }
  ],
  "handoff_summary": "14文書中13完了、ブロッカー1件を解消すれば Builder に渡せる"
}
```

## 4. データモデル

### 4.1 決定ログ: `decisions.jsonl`

プロジェクトディレクトリに自動生成。壁打ちの記録が蓄積される。

```jsonl
{"id":"DEC-001","decision":"2エディション構成（Git版+Lite版）","rationale":"...","affects":["BasicDesign.md"],"created_at":"2026-02-27T...","supersedes":null}
{"id":"DEC-002","decision":"messages テーブル廃止","rationale":"...","affects":["BasicDesign.md","mcp-tools.md"],"created_at":"2026-02-28T...","supersedes":"旧: messages テーブル"}
```

### 4.2 文書メタデータの埋め込み

各設計文書の先頭にフロントマターを付与（Obsidian 互換）:

```yaml
---
status: complete          # draft | in_progress | complete
layer: foundation         # foundation | specification | usecase | interface | execution | context
last_reviewed: 2026-03-01
decisions: [DEC-001, DEC-003, DEC-005]
open_questions: []
---
```

Planner は既存文書にフロントマターがなくても動作する（本文から推定）。
フロントマターがあれば、より正確な状況把握が可能。

**Obsidian 互換ルール:**
- Planner のカスタムキー（`status`, `layer`, `decisions` 等）は Obsidian の予約キーと衝突しない
- `tags`: 削除禁止、追加は必要に応じて（重複チェックしてから追加）
- `aliases`, `cssclasses`: Planner は触らない

## 5. 実行モデル

### 5.1 サブエージェント化の方針

`clarify_idea`（§3.1）は構想の引き出しと規模判定を担うため、メインモデル（Opus 相当）で実行する。

以下のツールはテンプレートマッチングやルールベース処理が中心のため、ローコストモデル（Haiku 相当）へのサブエージェント委譲が可能:

| ツール | 理由 |
|--------|------|
| `suggest_approach` (§3.3) | テンプレートからのキーワードマッチ選出 |
| `track_decision` (§3.4) | 入力の構造化と JSONL 追記 |
| `check_consistency` (§3.5) | ルールベースの整合性チェック |
| `check_readiness` (§3.6) | チェック項目の機械的な評価 |

`design_context`（§3.2）はファイル走査とメタデータ抽出が主処理のため、同様にローコストモデルで実行可能。

## 関連ドキュメント

- [基本設計](../basic-design.md)
- [壁打ちフロー機能設計](../2-features/wall-hitting.md)
- [Planner リファレンス](../4-ref/planner-reference.md)
