# CDD-Builder ユースケース

## 概要

Builder MCP がレシピを管理し、サブエージェント（Sonnet/Haiku）が実装を担当する。
Opus はオーケストレーターとして温存する。

---

## ユースケース一覧

| ID | ユースケース | トリガー |
|----|------------|---------|
| B-1 | 会話中に即時実装指示 | 対話 |
| B-4 | 結果レビュー | 対話 |
| B-5 | 失敗チャンクのやり直し指示 | 対話 |

---

## B-1: 会話中に即時実装指示

**アクター:** 人 + Claude Code (Opus) + サブエージェント (Sonnet)

**前提条件:**
- recipe.json が生成済み
- Claude Code セッションが起動中

**フロー:**

```mermaid
sequenceDiagram
    participant H as 人
    participant O as Opus（オーケストレーター）
    participant B as Builder MCP
    participant S as Sonnet（実装担当）

    H->>O: 「chunk-04 と chunk-09 を実装して」
    O->>B: load_recipe()
    O->>B: next_chunks()
    B-->>O: [chunk-04, chunk-09]（依存解決済み）

    par バックグラウンド実行
        O->>S: Agent(sonnet, chunk-04.prompt)
    and
        O->>S: Agent(sonnet, chunk-09.prompt)
    end

    Note over H,O: サブエージェント実行中も<br/>Opus との会話は継続可能

    S-->>O: chunk-04 完了（files: [...])
    O->>B: complete_chunk("chunk-04", files)
    B-->>O: tests passed, newly_unblocked: [chunk-05, chunk-06]

    S-->>O: chunk-09 完了（files: [...]）
    O->>B: complete_chunk("chunk-09", files)
    B-->>O: tests passed, newly_unblocked: [chunk-10, chunk-11]

    O->>H: 「2チャンク完了。4チャンクがアンロックされた」
```

**ポイント:**
- サブエージェントはバックグラウンド実行。Opus との別の会話を続けられる
- 同一レベルのチャンクは並列実行可能
- 完了通知がリアルタイムで届く

---

## B-4: 結果レビュー

**アクター:** 人 + Claude Code (Opus)

**前提条件:**
- 実装が進んだ後

**フロー:**

```mermaid
sequenceDiagram
    participant H as 人
    participant O as Opus
    participant B as Builder MCP

    H->>O: 「おはよう。昨夜の結果は？」
    O->>B: execution_status()
    B-->>O: 進捗レポート

    O->>H: 「3チャンク成功、1チャンク失敗」

    Note over O: 成功チャンクのサマリー表示
    O->>H: chunk-06: セッション要約 MCP ✅<br/>chunk-07: メモリストア MCP ✅<br/>chunk-08: 横断検索 MCP ✅

    Note over O: 失敗チャンクの詳細表示
    O->>H: chunk-10: エピソード抽出 MCP ❌<br/>テスト2件失敗（境界値処理）

    H->>O: 「成功分は LGTM。失敗分は直して」
    Note over H,O: → B-5 のフローへ
```

**ポイント:**
- execution-state.json に全結果が構造化されている
- 人はコードを一行ずつ読まなくても、テスト結果で判断できる
- 成功チャンクの承認と失敗チャンクの対応を分離できる

---

## B-5: 失敗チャンクのやり直し指示

**アクター:** 人 + Claude Code (Opus) + サブエージェント (Sonnet)

**前提条件:**
- complete_chunk で `status: "failed"` になったチャンクがある

**フロー:**

```mermaid
sequenceDiagram
    participant H as 人
    participant O as Opus
    participant B as Builder MCP
    participant S as Sonnet

    H->>O: 「chunk-10 のエラー詳細を見せて」
    O->>B: execution_status()
    B-->>O: chunk-10: failed, test_errors: [...]

    O->>H: 「境界値: min_importance=0.0 で<br/>全エピソードが抽出される想定だが、<br/>空リストが返っている」

    alt 人が方針を指示
        H->>O: 「min_importance=0.0 は<br/>フィルタなしとして扱って」
        O->>S: Agent(sonnet, chunk-10.prompt + 修正指示)
    else Opus が自動修正を提案
        O->>H: 「条件分岐を追加すれば直りそう。やる？」
        H->>O: 「お願い」
        O->>S: Agent(sonnet, chunk-10.prompt + 修正方針)
    end

    S-->>O: 修正完了
    O->>B: complete_chunk("chunk-10", files)
    B-->>O: done, tests passed ✅
    O->>H: 「chunk-10 修正完了。テスト全pass」
```

**ポイント:**
- 失敗原因は execution-state.json に記録されている
- 人が方針を指示するか、Opus に任せるかを選べる
- リトライ時は前回のエラー情報をプロンプトに含める

---

## ユースケース間の関係

```mermaid
graph LR
    B1[B-1: 即時実装] --> B4[B-4: 結果レビュー]
    B4 --> B5[B-5: やり直し]
    B5 --> B1

    style B1 fill:#4a9,color:#fff
    style B4 fill:#d84,color:#fff
    style B5 fill:#c55,color:#fff
```

**緑:** 実装 / **橙:** レビュー / **赤:** リカバリ

---

## 関連ドキュメント

- [Builder 設計書](builder-design.md) — アーキテクチャ・MCP ツール仕様
- [Planner 設計書](planner-design.md) — 設計壁打ち支援
