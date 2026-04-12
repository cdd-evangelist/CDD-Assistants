---
status: complete
layer: foundation
---

# CDD-Builder 基本設計書

更新日: 2026-04-12

## 1. 概要

CDD-Builder は、完成した設計文書群を読み取り、LLM が実装可能な粒度に分割し、自律的に実行する MCP サーバー。
CDD（Chat/Character/Chart Driven Development）の「設計は精密に、実装はシンプルに」という開発思想を実現するための **設計→実装の自動翻訳・実行エンジン**。

### 1.1 解決する問題

設計文書を LLM に一括で渡すと:
- コンテキストウィンドウを圧迫し、後半で精度が落ちる
- 文書間の暗黙的依存を見落とす
- 実装順序を誤り、手戻りが発生する

さらに、実装とテストを同じ LLM が同じコンテキストで生成すると（**共有バイアス問題**）:
- AI が実装ロジックをそのままテストの期待値に転写する
- バグを「正解」として固定し、仕様との乖離を検出できない
- カバレッジは高いが何も守っていないテストが量産される

Builder はチャンク分割で前者を、Dual-Agent TDD で後者を構造的に排除する。

### 1.2 位置づけ

```
人 + Claude: 楽しくおしゃべりしながら設計
                ↓
        【CDD-Planner】壁打ち・設計支援
                ↓
          設計文書群（完成品）
                ↓
        【CDD-Builder】
          ├── レシピエンジン: 設計を分析・分割・レシピ化
          └── 実行エンジン: レシピを読み、実行アダプタ経由で実装
                ↓
          実装コード（テスト済み）
```

**人は設計に集中し、実装は Builder が自動で回す。**
人は途中で口を挟んでもいいし、完全に任せてもいい。

### 1.3 スコープ

| Builder が担う | Builder が担わない |
|---|---|
| 設計文書をチャンクに分割する | 設計文書を書く（→ Planner） |
| チャンク単位で自律的に実装する | 実装方針を人の代わりに決める |
| 実装成果物のテストとリファレンスを生成する | 仕様変更を独断で行う |
| 設計文書と実装の乖離を検出する | 設計文書を自動で書き換える（提案のみ） |
| プロジェクトのコード規約を検出し、各チャンクに伝播する | コード規約自体の策定（組織の既存資産を尊重） |
| 進捗を可視化する（execution_status / Issue 同期） | デプロイする |
| 実行アダプタ経由で LLM を切り替える | LLM 推論そのものを実装する（アダプタに委任） |

### 1.4 設計品質とコード品質の関係

Planner で十分に壁打ちした後に Builder へ渡すと、可読性の高いアウトプットが得られる。

Builder が生成するコードの品質は、入力となる設計文書の品質に直結する。
型定義・処理ステップ・モジュール間の接続が設計で決まっていれば、Builder は「仕様を翻訳する」だけでよく、判断の余地が減る。結果として：

- 命名が一貫する（設計用語がそのままコードに降りてくる）
- テスト名が設計意図を反映する（仕様文 → テストケース名の直訳）
- 過剰な抽象化が起きない（何を作るか明確なので、「念のため」のコードが不要）
- モジュール分割が自然になる（設計のレイヤー構造がそのままディレクトリ構成に反映される）

これは Vibe コーディング（曖昧な指示で AI に一任する方式）との決定的な違いであり、CDD の「設計は精密に、実装はシンプルに」が実際のコードに現れる部分でもある。

対になる Planner 側の記述: [Planner §2.3 設計の精度が実装の品質を決める](../planner/basic-design.md)。

### 1.5 ラウンドトリップ検証の双方向性

Builder の自律性を成立させる鍵は、生成したコードが設計文書と一致しているかを自動検証できること。設計文書とコードは**デジタルツイン**の関係にあり（→ [設計文書標準 §1](../design-doc-standard.md)）、表現型が異なるだけで記述される内容は一致しているべき。

Builder はコードから日本語のリファレンスを生成し、元の設計文書と突き合わせる。この照合は**双方向に働く**:

- **実装が仕様を下回っている（欠落・矛盾）** → 原因を仕分けたうえで Impl Agent に差し戻し、または設計の曖昧さとして人に返す（§2 Investigation Agent 参照）
- **実装が仕様を上回っている（設計の進化・機能拡張）** → 設計文書の改訂を人に提案

後者がこの仕組みの面白いところで、書かれた時点では気づかなかった要件やエッジケースが実装中に浮かび上がる。Builder は「仕様に従うだけ」ではなく「実装からのフィードバックで仕様を洗練する」ループの一部として動き、設計書が活文書（living document）の状態を保つ。

詳細は [ラウンドトリップ検証機能設計](2-features/roundtrip-verification.md) を参照。

## 2. アーキテクチャ

```
Builder
├── レシピエンジン（設計 → レシピ変換）
│   ├── analyze_design   … 設計文書群の構造分析
│   ├── split_chunks     … 実装チャンクへの分割
│   ├── validate_refs    … 参照整合性チェック
│   └── export_recipe    … レシピファイル出力
│
├── 実行エンジン（レシピ → 実装コード）
│   ├── load_recipe      … レシピ読み込み・実行状態初期化
│   ├── next_chunks      … 次の実行可能チャンクを返す
│   ├── complete_chunk   … チャンク完了の検証・記録
│   └── execution_status … 全体進捗の可視化
│
├── 実行エージェント（Dual-Agent TDD + Investigation）
│   ├── Test Agent          … 設計から逆算してテストを生成（Red）
│   ├── Impl Agent          … テストを PASS させる実装 + リファレンスを生成（Green）
│   └── Investigation Agent … 照合 NG 時の原因仕分け（実装 / 設計 / テスト）
│
└── 実行アダプタ（差し替え可能）
    ├── claude-code      … Claude Code の Task エージェント（デフォルト）
    ├── local-llm        … Ollama, llama.cpp 等
    └── (将来)           … 任意の LLM / エージェント
```

### 2.1 設計原則

- **レシピエンジンは LLM に依存しない。** 純粋に「何を、どの順で、どこまでやるか」を管理する
- **実行アダプタは差し替え可能。** インターフェースだけ決め、実装は自由
- **実装プロンプトは素の自然言語。** 特定の API 形式に依存しない。Claude でもローカル LLM でも読める
- **役割を分離する。** テスト生成・実装・原因分析を別エージェントに分け、共有バイアスと誤判断を構造的に排除する

### 2.2 行動原則（人との協調）

§2.1 の設計原則がアーキテクチャ側の取り決めだとすれば、こちらは実行時の姿勢。Planner が「人の判断を待つことは遅延ではなく品質への投資」と位置づけているのと対をなす。

1. **失敗は勝手にリトライし続けない** — 規定回数を超えたら人に判断を仰ぐ。「なぜ失敗しているか」は設計の曖昧さを示すシグナル
2. **照合 NG で独断修正しない** — 仕様と実装の乖離を検出したら、Investigation Agent で原因を仕分けたうえで、実装の問題なら Impl Agent に差し戻し、設計の曖昧さなら人（または Planner）に返す
3. **進捗を隠さない** — `execution_status` と Issue 同期で、人がいつでも全体を把握できる
4. **実行モードは人が選ぶ** — 全自動 / 対話 / ステップ確認の切り替えは人の選択
5. **仕様の改訂を独断しない** — 実装が仕様を上回っていても、設計文書の書き換えは提案にとどめる

## 3. チャンク分割の原則

### 3.1 サイズ制約

| 項目 | 制約 | 根拠 |
|------|------|------|
| 参照設計文書 | 1〜2本 | 3本以上で注意散漫・整合性低下 |
| 入力トークン | 8k 以内 | 設計文書 + 既存コード参照 + プロンプト |
| 出力ファイル数 | 3〜5本 | 多すぎるとファイル間整合性が崩れる |
| 完了条件 | テスト可能 | 次チャンクの前提を保証する |

### 3.2 分割の判断基準

**分割すべき場合:**
- 設計文書の異なるセクションが独立した機能を定義している
- 1チャンクの推定出力が 12k トークンを超える
- 異なるレイヤー（DB / ロジック / API）にまたがる

**分割すべきでない場合:**
- 2つの機能が同じテーブル・同じモジュールを密に共有する
- 分割すると片方のチャンクが小さすぎる（< 1k 出力）
- 分割するとチャンク間のインターフェース定義が必要になり、かえって複雑になる

### 3.3 統合テストチャンクの自動挿入

`split_chunks` は依存関係グラフから、統合テストチャンクを自動挿入する。各チャンクの Dual-Agent TDD で単体テストはカバーされるが、チャンク間の接続は検証されない。

**挿入ルール:**

| 条件 | 挿入位置 | テスト内容 |
|------|---------|-----------|
| 依存グラフで3チャンク以上が合流するノード | 合流ノードの直後 | 合流元チャンクの出力が正しく連携するか |
| レイヤー境界（データ層→ロジック層→API層）をまたぐ箇所 | 境界の直後 | 下位レイヤーの出力を上位レイヤーが正しく消費するか |
| 全チャンク完了後 | 最終チャンクの後 | E2E テスト（主要ユースケースの一気通貫実行） |

統合テストチャンクは `test_requirements` のみで構成され、`implementation_prompt` を持たない。Test Agent がテストを生成し、既存の実装に対して実行する（Red フェーズはスキップ）。

### 3.4 既存コードの扱い

チャンク 02 以降は、前のチャンクで生成されたコードを参照する必要がある。

```
chunk-04 の入力:
  - 設計文書: progressive-disclosure.md（該当セクション）
  - 既存コード: chunk-01 で生成した schema.ts の型定義
  - 既存コード: chunk-02 で生成した policy.ts のインターフェース
  → これらを source_content にまとめて渡す
```

レシピの `source_content` にはファイルパスのプレースホルダを記述し、
`next_chunks` が実行時に実際のコードを差し込む:

```json
{
  "source_content": "{{file:src/db/schema.ts}}\n\n---\n\n## 設計: progressive-disclosure.md\n..."
}
```

### 3.5 コード規約の伝播

プロジェクトにコード規約がある場合、Builder はそれを検出して各チャンクに伝播する。規約がなければ `tech_stack` の慣例に従って「よしなに」処理する。組織・チームの既存資産を上書きせず、存在すれば優先する、というのが基本姿勢。

**検出順序（優先度高→低）:**

1. プロジェクトルートの `AGENTS.md` / `CODING-STANDARDS.md` — 組織・チームの統一規約（人間・AI 共通）
2. `.editorconfig` / `eslint.config.js` / `.prettierrc` / `ruff.toml` 等 — 機械可読な linter・formatter 設定
3. `package.json` / `pyproject.toml` の `scripts` セクション — `lint`, `format`, `test` コマンドの呼び出し方

**伝播と検証:**

- `analyze_design` が規約ファイルを収集し、recipe.json の `coding_standards` に記録
- `next_chunks` が各チャンクの `implementation_prompt` に規約のダイジェストを挿入
- `complete_chunk` の検証レベルに「規約適合性」を追加し、プロジェクトの linter / formatter を実行して結果を照合に含める
- 実装が規約から逸脱した場合は Impl Agent に差し戻し（Investigation Agent 経由で原因仕分け）

**フォールバック:**

- 規約ファイルが存在しない個人開発等では、規約検出ステップはスキップされる
- その場合、Impl Agent は `tech_stack` の言語・フレームワーク慣例（TypeScript なら ESLint 推奨設定、Python なら PEP 8 等）に従う
- 規約ファイルの解釈が困難な場合は警告を出すが処理は止めない

### 3.6 テスト品質の担保

Dual-Agent TDD で共有バイアスを排除してもテストそのものが弱い可能性は残る:

- `assert true` 相当の、何も検証していないテスト
- if/else の片方の分岐しかカバーしていないテスト
- 境界値を踏んでいないテスト

Builder は 2 段階でこれに対処する:

**静的チェック（v0.1 から）** — `complete_chunk` のテスト品質検証で、パラメータ網羅・異常系の存在・Assertion 品質を確認する。詳細は [mcp-tools §4.3](3-details/mcp-tools.md)。

**Mutation Testing（v0.2 以降で検討）** — 実装コードに意図的な変更（ミュータント）を加え、テストが検出できるかを測る。Survived（検出できなかった）ミュータントはテストの弱点を直接示す。ツールは TypeScript なら Stryker、Python なら mutmut を想定。Survived を検出した場合、Builder はそのミュータントを具体的な指示として Test Agent に渡し、テストを強化させる。

**原則: カバレッジ ≠ テスト有効性。** 100% カバレッジでも assert が弱ければ何も守れない。Mutation Testing は「コードが実行されたか」ではなく「検証が機能したか」を測る唯一の自動化手段。

## 4. 技術スタック

| 項目 | 選定 | 理由 |
|------|------|------|
| 言語 | TypeScript | MCP SDK の公式サポート |
| MCP SDK | `@modelcontextprotocol/sdk` | 標準 |
| パーサー | unified + remark | Markdown の構造解析 |
| トークン推定 | tiktoken (cl100k_base) | 精度のある見積もり |
| テスト | vitest | 軽量・高速 |
| 実行状態 | JSON ファイル | シンプル、外部DB不要 |

## 5. 制約・前提

- Builder が生成するコードの言語・プラットフォームは設計文書の `tech_stack` で決まる（Builder 自体は TypeScript）
- Builder が生成・検証する設計文書は [設計文書標準](../design-doc-standard.md) に従う
- レシピエンジンは LLM を内部で呼び出さない。構造解析とルールベースで動作する
- プロジェクトのコード規約ファイル（`AGENTS.md` / `CODING-STANDARDS.md` / 既存 linter 設定等）があれば検出して尊重する。なければ `tech_stack` の慣例に従う（§3.5 参照）

## 6. 未決事項

- `implementation_prompt` のテンプレート最適化（実際に実行して調整）
- ユースケース文書の `validation_context` をどこまで含めるか
- 分割戦略 `strategy` のバリエーション（bottom_up 以外に top_down, by_layer 等）
- 失敗チャンクの最大リトライ回数
- 実行途中でのレシピ修正（チャンク追加・削除・順序変更）への対応
- クロスプラットフォーム対応時の設計ガイドライン策定
- Mutation Testing の導入（`Stryker` / `mutmut` を `complete_chunk` に統合、§3.6 参照）
- `complete_chunk` の多軸レビュー（セキュリティ・保守性・依存の健全性）の追加（Issue #8 より）
- 自律運用時のパイプライン停滞モニター（タイムアウト警告、failed 放置検知、完了忘れ検知、Issue #8 より）
- Test / Impl / Investigation Agent への役割特化エピソードの引き渡し（CDD-Ghost 連携、Issue #10 より）

## 7. AI-Ghost-Shell で検証：分割シミュレーション

14本の設計文書を Builder に通した場合の想定チャンク分割:

```mermaid
graph TD
    C01[chunk-01: DB スキーマ<br/>BasicDesign §3] --> C02[chunk-02: Policy パーサー<br/>ghost-policy-spec]
    C01 --> C03[chunk-03: セッション管理<br/>BasicDesign §3.1 sessions]
    C02 --> C04[chunk-04: メモリ検索<br/>progressive-disclosure<br/>+ memory-access-policy]
    C03 --> C04
    C04 --> C05[chunk-05: MCP memory_search / memory_detail<br/>mcp-tools §1,2]
    C04 --> C06[chunk-06: MCP memory_store<br/>mcp-tools §5<br/>+ memory-access-policy]
    C03 --> C07[chunk-07: MCP session_summarize<br/>mcp-tools §6]
    C05 --> C08[chunk-08: MCP memory_search_global<br/>mcp-tools §4<br/>+ progressive-disclosure §Ring3]
    C01 --> C09[chunk-09: エピソード抽出エンジン<br/>episode-extraction]
    C09 --> C10[chunk-10: MCP episode_extract<br/>mcp-tools §7]
    C09 --> C11[chunk-11: 逆伝播スコアリング<br/>episode-extraction §backprop]
    C02 --> C12[chunk-12: CLI 基盤 + setup/status<br/>ghost-cli §1,14]
    C12 --> C13[chunk-13: CLI backup/restore<br/>ghost-cli §3,4]
    C12 --> C14[chunk-14: CLI logs/log/tag<br/>ghost-cli §6,7,8]
    C12 --> C15[chunk-15: CLI sync/publish/diff<br/>ghost-cli §5,9,10]
    C13 --> C16[chunk-16: CLI export/import/forget<br/>ghost-cli §11,12,13]
    C08 --> C17[chunk-17: セキュリティ検証<br/>ghost-security]

    style C01 fill:#4a9,color:#fff
    style C02 fill:#4a9,color:#fff
    style C03 fill:#4a9,color:#fff
    style C04 fill:#59d,color:#fff
    style C05 fill:#d84,color:#fff
    style C06 fill:#d84,color:#fff
    style C07 fill:#d84,color:#fff
    style C08 fill:#d84,color:#fff
    style C09 fill:#59d,color:#fff
    style C10 fill:#d84,color:#fff
    style C11 fill:#59d,color:#fff
    style C12 fill:#e6a,color:#fff
    style C13 fill:#e6a,color:#fff
    style C14 fill:#e6a,color:#fff
    style C15 fill:#e6a,color:#fff
    style C16 fill:#e6a,color:#fff
    style C17 fill:#c55,color:#fff
```

**凡例:** 緑: データ層 / 青: ロジック層 / 橙: MCP層 / 紫: CLI層 / 赤: セキュリティ

### チャンク一覧

| ID | チャンク名 | 参照設計書 | 推定入力 | 依存 |
|----|-----------|-----------|---------|------|
| 01 | DB スキーマ | BasicDesign §3 | ~2.5k | なし |
| 02 | Policy パーサー | ghost-policy-spec | ~3.5k | 01 |
| 03 | セッション管理 | BasicDesign §3.1 | ~2.0k | 01 |
| 04 | メモリ検索コア | progressive-disclosure + memory-access-policy | ~4.0k | 02, 03 |
| 05 | MCP memory_search / detail | mcp-tools §1,2 | ~3.0k | 04 |
| 06 | MCP memory_store | mcp-tools §5 + memory-access-policy | ~2.5k | 04 |
| 07 | MCP session_summarize | mcp-tools §6 | ~2.0k | 03 |
| 08 | MCP memory_search_global | mcp-tools §4 + progressive-disclosure §Ring3 | ~2.5k | 05 |
| 09 | エピソード抽出エンジン | episode-extraction | ~4.0k | 01 |
| 10 | MCP episode_extract | mcp-tools §7 | ~2.0k | 09 |
| 11 | 逆伝播スコアリング | episode-extraction §backprop | ~3.0k | 09 |
| 12 | CLI 基盤 + setup/status | ghost-cli §1,14 | ~3.0k | 02 |
| 13 | CLI backup/restore | ghost-cli §3,4 | ~3.0k | 12 |
| 14 | CLI logs/log/tag | ghost-cli §6,7,8 | ~3.0k | 12 |
| 15 | CLI sync/publish/diff | ghost-cli §5,9,10 | ~3.0k | 12 |
| 16 | CLI export/import/forget | ghost-cli §11,12,13 | ~3.0k | 13 |
| 17 | セキュリティ検証 | ghost-security | ~2.0k | 08 |

**並列実行レベル:**
```
Lv.0: [01]
Lv.1: [02, 03]
Lv.2: [04, 09]
Lv.3: [05, 06, 07, 10, 11, 12]
Lv.4: [08, 13, 14, 15]
Lv.5: [16, 17]
```

最大5レベル、Lv.3 で6並列。Builder が並列実行すれば大幅に短縮可能。

## 関連ドキュメント

- [設計文書標準](../design-doc-standard.md)
- [実行フロー機能設計](2-features/execution-flow.md)
- [ラウンドトリップ検証機能設計](2-features/roundtrip-verification.md)
- [MCP ツール詳細設計](3-details/mcp-tools.md)
- [実行アダプタ詳細設計](3-details/execution-adapter.md)
- [Builder リファレンス](4-ref/builder-reference.md)
