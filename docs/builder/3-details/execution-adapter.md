---
status: complete
layer: interface
---

# 実行アダプタ詳細設計書

更新日: 2026-04-12
対応コード: builder/src/adapters/

## 1. 概要

実行アダプタのインターフェース定義と各アダプタの実装仕様を定義する。
Builder のレシピエンジン・実行エンジンは LLM に依存せず、アダプタだけが LLM を知っている。

対応する機能設計: [実行フロー](../2-features/execution-flow.md)、[ラウンドトリップ検証](../2-features/roundtrip-verification.md)

## 2. インターフェース

### 2.1 ChunkExecutor

```typescript
interface ChunkExecutor {
  /**
   * テスト生成（Red フェーズ）。
   * 設計文書と test_requirements のみをコンテキストに、テストコードを生成する。
   * 実装コードは渡さない（共有バイアスの排除）。
   */
  generateTests(chunk: PreparedChunk): Promise<TestGenerationResult>

  /**
   * 実装 + リファレンス生成（Green フェーズ）。
   * テストコード + 設計文書をコンテキストに、実装コードとリファレンスを生成する。
   */
  implement(chunk: PreparedChunk, testFiles: string[]): Promise<ExecutionResult>

  /**
   * 照合 NG 時の原因仕分け（Investigation フェーズ）。
   * 乖離内容・設計文書・実装・テストを渡し、「実装 / 設計 / テスト」のいずれが原因かを判定する。
   */
  investigate(chunk: PreparedChunk, divergence: DivergenceReport, artifacts: Artifacts): Promise<InvestigationResult>
}
```

### 2.2 PreparedChunk

```typescript
interface PreparedChunk {
  id: string
  name: string
  implementation_prompt: string   // プレースホルダ解決済みの自然言語プロンプト
  expected_outputs: string[]      // 生成すべきファイルパス
  completion_criteria: string[]   // 完了条件（自然言語）
  test_requirements: {            // 設計文書から抽出したテスト観点
    interface_tests: string[]
    boundary_tests: string[]
    integration_refs: string[]
  }
  reference_doc: string           // リファレンスドキュメントの出力先パス
  working_dir: string             // 実装先ディレクトリ
  coding_standards_digest?: string // コード規約のダイジェスト（next_chunks がプロンプトに付加済み）
}
```

### 2.3 結果型

```typescript
interface TestGenerationResult {
  success: boolean
  test_files: string[]            // 生成されたテストファイルパス
  error?: string
}

interface ExecutionResult {
  success: boolean
  generated_files: string[]       // 実際に生成されたファイルパス（テスト除く）
  reference_doc?: string          // 生成されたリファレンスのパス
  error?: string                  // 失敗時のエラー内容
}

interface DivergenceReport {
  items: Array<{
    severity: 'critical' | 'update_needed' | 'minor'
    category: string              // '機能の欠落' | '型の不一致' | 'ロジックの矛盾' | '設計の進化' | ...
    description: string
  }>
}

interface Artifacts {
  design_doc: string              // 設計文書の該当セクション
  implementation: string[]        // 実装ファイルパス
  tests: string[]                 // テストファイルパス
  reference: string               // リファレンスのパス
}

interface InvestigationResult {
  verdict: 'implementation' | 'design_ambiguity' | 'test_insufficient'
  reasoning: string               // 判定の根拠（人にエスカレーションする場合の説明）
  suggested_action: string        // 次のアクションの提案
}
```

## 3. アダプタ実装

### 3.1 claude-code アダプタ（デフォルト）

Claude Code のサブエージェント（Agent ツール）を利用。Dual-Agent TDD + Investigation と並列実行が可能。

```
next_chunks() → [chunk-02, chunk-03]

par チャンクごとに並列
  ── chunk-02 ─────────────────────────────────
  Step 1 Red:   Agent(Sonnet, test_prompt)  → テスト生成 → FAIL 確認
  Step 2 Green: Agent(Sonnet, impl_prompt)  → 実装 + リファレンス → PASS 確認
  Step 3:       Opus(オーケストレーター): リファレンス vs 設計文書の照合
  Step 4 [NG時]: Agent(Sonnet, investigation_prompt) → 原因仕分け
                  → 実装 → Impl Agent 差し戻し
                  → 設計 → 人にエスカレーション
                  → テスト → Test Agent 差し戻し
  ── chunk-03 ─────────────────────────────────
  （chunk-02 と同様）
end

complete_chunk("chunk-02") ──→ 検証
complete_chunk("chunk-03") ──→ 検証
```

**Test Agent、Impl Agent、Investigation Agent はそれぞれ別セッション** で実行する。これによりコンテキストが完全に分離され、共有バイアスと誤差し戻しが構造的に排除される。同一チャンク内の Step 1 → Step 2 → Step 3 → Step 4 は直列だが、チャンク間は並列実行可能。

**実装詳細:**

- `claude` CLI を `-p`（非対話モード）で起動し、`--max-turns 30` で実行
- 許可ツール: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`
- タイムアウト: 5分（300,000ms）、出力バッファ上限: 10MB
- 生成ファイルの検出: 実行前後で `working_dir` 内の全ファイルの mtime を比較し、新規または更新されたファイルを `generated_files` として返す（`node_modules`, `.git` は除外）
- コード規約の伝播: `PreparedChunk.coding_standards_digest` が存在する場合、Test/Impl Agent のプロンプト冒頭に付加する。Agent は AGENTS.md や linter 設定を自力で Read してから生成を始める

### 3.2 local-llm アダプタ

ローカル LLM（Ollama 等）の API を呼び出す。

```
next_chunks() → [chunk-02]

→ HTTP POST ollama:11434/api/generate
  { model: "codellama", prompt: chunk-02.implementation_prompt }
→ レスポンスからコードブロックを抽出
→ ファイルに書き出し

complete_chunk("chunk-02") ──→ 検証
```

### 3.3 アダプタの選択

recipe.json またはコマンドライン引数で指定:

```json
{
  "executor": {
    "type": "claude-code",
    "config": {}
  }
}
```

```json
{
  "executor": {
    "type": "local-llm",
    "config": {
      "endpoint": "http://localhost:11434",
      "model": "codellama:34b"
    }
  }
}
```

## 4. モデルルーティング

アダプタはチャンクのメタデータに基づき、内部でモデルを振り分けることができる。
Builder 本体はモデル選択を関知しない。ルーティングはアダプタの中で閉じる。

### 4.1 ルーティングの判断材料

| シグナル | 例 | 示唆 |
|---------|-----|------|
| `estimated_output_tokens` | 4000 / 12000 | 出力規模 → 大きいほど高性能モデル |
| `source_docs` の数 | 1本 / 2本 | 参照設計の量 → 多いほど文脈理解力が必要 |
| レイヤー | データ層 / ロジック層 | ロジック層は判断が多い → 高性能モデル |
| `completion_criteria` の複雑さ | テスト通過 / 整合性検証 | 複雑な基準 → 高性能モデル |

### 4.2 設定例

**claude-code アダプタ:**

Opus をオーケストレーターとして温存し、Test Agent / Impl Agent / Investigation Agent は Sonnet / Haiku に委託する。Investigation は判断の質が収束速度を決めるため、原則 Sonnet 以上を推奨。

```json
{
  "executor": {
    "type": "claude-code",
    "config": {
      "routing": {
        "default": "sonnet",
        "agents": {
          "test": "sonnet",
          "impl": "sonnet",
          "investigation": "sonnet"
        },
        "rules": [
          { "when": "estimated_output_tokens < 3000 && agent == 'test'", "use": "haiku" },
          { "when": "estimated_output_tokens < 3000 && agent == 'impl'", "use": "haiku" },
          { "when": "source_docs_count >= 2", "use": "sonnet" },
          { "when": "layer == 'specification'", "use": "sonnet" },
          { "when": "agent == 'investigation'", "use": "sonnet" }
        ]
      }
    }
  }
}
```

**ルーティングの原則:**
- Test / Impl は出力サイズで Haiku 降格可
- Investigation は常に Sonnet 以上（誤判断が収束を遅らせるため降格しない）

**local-llm アダプタ:**

```json
{
  "executor": {
    "type": "local-llm",
    "config": {
      "endpoint": "http://localhost:11434",
      "routing": {
        "default": "codellama:7b",
        "rules": [
          { "when": "estimated_output_tokens > 8000", "use": "codellama:34b" }
        ]
      }
    }
  }
}
```

ルーティングルールは上から順に評価し、最初にマッチしたモデルを使用する。どれにもマッチしなければ `default` を使用する。

## 5. 未決事項

- local-llm アダプタのコード抽出ロジック（レスポンス形式が LLM ごとに異なる）
- Dual-Agent TDD の Red フェーズでコンパイルエラーが出た場合の型情報提供範囲
- Test Agent のテスト生成プロンプトの最適化
- Investigation Agent のプロンプト設計（判定精度を上げるための設計文書の前処理方法）
- local-llm アダプタで Investigation Agent を動かす場合の最小モデルサイズ

## 関連ドキュメント

- [基本設計](../basic-design.md)
- [実行フロー機能設計](../2-features/execution-flow.md)
- [ラウンドトリップ検証機能設計](../2-features/roundtrip-verification.md)
- [MCP ツール詳細設計](mcp-tools.md)
