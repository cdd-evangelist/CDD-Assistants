---
status: complete
layer: specification
---

# テスト品質担保機能設計書

更新日: 2026-05-09

## 1. 概要

Dual-Agent TDD で共有バイアスを排除しても、**テストそのものが弱い可能性は残る**（`assert True` のような無意味な検証、分岐網羅不足、境界値の踏み漏れ等）。Builder は静的チェックと Mutation Testing の 2 段階でこれに対処する。

**原則: カバレッジ ≠ テスト有効性。** 100% カバレッジでも assert が弱ければ何も守れない。「コードが実行されたか」ではなく **「検証が機能したか」** を測ることがテスト品質担保の要点。

検証は `complete_chunk` に組み込まれるが、段階によって完了判定への効き方が異なる。**v0.1 の静的チェックは informational 扱い**で、指摘を `verification.test_quality_issues` として返すのみで `status` / `commit_hint` には影響させない。**失敗判定の本命は v0.2 の Mutation Testing** で、Mutation Score が閾値未達なら完了扱いにしない。理由は §7「なぜ静的チェックを informational にとどめるか」を参照。

## 2. 構成要素

### 2.1 バウンダリ（外部との接点）

- **生成テストファイル** — Test Agent が出力した `.test.*` / `.spec.*` ファイル
- **実装コード** — Impl Agent が出力したソースファイル（Mutation Testing の対象）
- **Mutation Testing ツール** — Stryker（JS/TS）/ mutmut（Python）等、言語依存
- **test_requirements** — 設計文書から抽出したテスト観点（network/boundary/integration）

### 2.2 エンティティ（扱うデータ）

- **テスト品質メトリクス** — パラメータ網羅率、異常系カバー数、assertion 品質スコア
- **Mutation Score** — 注入したミュータントのうちテストが検出できた割合
- **Survived Mutants** — テストが見逃したミュータント群（Test Agent への強化指示の材料）

### 2.3 コントローラー（主要な処理）

- **静的チェック** — テストコードを解析し、assertion の形・網羅性を評価
- **Mutation Testing** — 実装にミュータントを注入してテストを実行、検出率を測る
- **結果フィードバック** — Survived mutants を Test Agent への追加指示に変換
- **完了判定への統合** — Mutation Score が閾値未達なら `complete_chunk` を失敗扱いにする（v0.1 の静的チェックは informational で完了判定に効かない）

## 3. 原則: カバレッジ ≠ テスト有効性

カバレッジは「コードが実行されたか」を測る指標にすぎず、「テストが何かを検証したか」は保証しない。以下のテストは 100% カバレッジでも何も守っていない:

```typescript
test("parse returns value", () => {
  const result = parse("abc");
  expect(result).toBeDefined();  // 何でも通る
});
```

Builder が測るべきは **「実装を壊したらテストが落ちるか」**。これを直接測るのが Mutation Testing であり、それを静的にプロキシするのが assertion 品質のチェック。

## 4. 検証項目

### 4.1 v0.1: 静的チェック（informational）

`complete_chunk` が実装から呼び出される自動検証項目。Mutation Testing より軽量で、全チャンクに常時適用できる。**v0.1 では結果を `verification.test_quality_issues` として返すのみで、`status` / `commit_hint` には影響させない**（Issue #32）。

| 検証項目 | 内容 |
|---------|------|
| パラメータ網羅 | 設計文書の入力パラメータが全てテストされているか |
| 異常系の存在 | エラーケース・境界値のテストが 1 つ以上あるか |
| 統合ポイント | 依存チャンクとの接続テストがあるか |
| Assertion 品質 | `assert True` や例外不発生のみのテストを検出 |

`test_requirements` の `interface_tests` / `boundary_tests` / `integration_refs` をそれぞれの検証項目と対応付ける。

パラメータ網羅・統合ポイントの照合は、設計文書の要件文から識別子っぽいキーワードを抽出し、テストファイル本文に含まれるかをヒューリスティックに判定する: **prefix match**（右側の word boundary を外して `mockMermaidRender` のような camelCase / 接尾辞にも対応）と **半数以上ヒットで pass の閾値マッチ**（日本語化された英単語などで一部キーワードが落ちても拾える）の組み合わせ。設計文書と実装の表記揺れを許容しつつ、真の漏れ（マッチ率 < 50%）は警告する。

このヒューリスティックは表記揺れに対して **false positive を出しやすい**（#28 / #32）。そのため v0.1 では完了判定に直結させず、エージェント・ユーザーが参考にする情報として返すにとどめる。

### 4.2 v0.2 以降: Mutation Testing

実装コードに機械的な変更（ミュータント）を加え、テストがそれを検出できるかを測る。

| 項目 | 内容 |
|---|---|
| ツール | Stryker（JS/TS）/ mutmut（Python）等、`tech_stack` で切り替え |
| タイミング | `complete_chunk` の検証レベル最終段 |
| 閾値 | Mutation Score が一定値未満なら失敗扱い（初期値 75% 想定、プロジェクトで調整可能） |
| 出力 | Survived mutants の一覧 + 該当コード箇所 |

### 4.3 テスト実行の前提条件

- `generated_files` にテストファイル（`.test.`, `.spec.`, `__tests__` 等）を含む
- `{working_dir}/node_modules` 等、テスト実行環境が揃っている（なければスキップ）
- テスト実行タイムアウト: 60 秒
- Mutation Testing は通常のテストより実行時間が長い（数倍〜数十倍）ため、v0.2 でタイムアウト値を別途設定する

## 5. フィードバックループ

Mutation Testing で検出された Survived mutants は、**「このテストでは実装の X を書き換えても落ちなかった」** という具体的な弱点情報。これを Test Agent への次のテスト生成指示に変換する。

```
Step 1: complete_chunk が Mutation Testing を実行
         → Survived mutants をリスト化

Step 2: Investigation Agent が「テスト不足」と判定
         → Survived mutants をそのまま Test Agent への指示に含める

Step 3: Test Agent がテストを追加
         → 「X のミュータントを検出するテスト」という具体的な指示に沿って書く

Step 4: 再度 complete_chunk で Mutation Score を測る
         → 閾値を超えれば完了、未達なら再度差し戻し
```

**なぜ Survived mutants をそのまま渡すか:** 「テストの網羅性が足りない」という抽象的な指示だと、Test Agent は何を足せばいいか判断できない。具体的なミュータントをペアで渡すことで、**「このコード変更を検出するテスト」** という明確なターゲットができる。

## 6. Dual-Agent TDD との関係

共有バイアスの排除（Dual-Agent TDD）と、テスト自体の強度担保（Mutation Testing）は **別々の失敗モード**を防ぐ。両方が揃って初めて「テストが仕様を守っている」状態になる。

| 失敗モード | 対策 | 詳細 |
|---|---|---|
| 実装バグと同じ誤解でテストが書かれる | Dual-Agent TDD | [実行フロー §4.2](execution-flow.md) |
| テスト自体が何も検証していない | 静的チェック + Mutation Testing | 本書 §4 |

Dual-Agent TDD があっても assert が弱いテストは書ける。Mutation Testing があっても同一コンテキストで書くと共有バイアスは残る。両者は独立の防御層として共存する。

## 7. 設計判断

### なぜ「カバレッジ ≠ テスト有効性」を原則に据えるか

カバレッジは測りやすく自動化しやすいため、多くのプロジェクトで品質指標として採用されている。しかし LLM が生成するテストは特にカバレッジは通るが assert が弱いパターンが頻出する。**カバレッジに満足して止まると、Builder の出力は「テスト通過したが壊れていない保証がない」** 状態になるため、原則から明確に除外する。

### なぜ静的チェックと Mutation Testing を 2 段階に分けるか

Mutation Testing は実行時間が重く、全チャンクに常時適用するとフィードバックループが遅くなる。静的チェック（assertion 品質・パラメータ網羅）は軽量で、全チャンクに適用できる。**軽い網で多くを拾い、重い検証で残りを拾う** 二段構えが現実的。

### なぜ静的チェックを informational にとどめるか

静的チェックは設計文書の要件文とテスト本文をキーワードでヒューリスティックに突き合わせる。表記揺れ・日本語化・camelCase などで **false positive が避けられない**（#28 で prefix match + 閾値マッチに緩和したが、要件文の表現次第で依然発生する）。

これを完了判定に直結させると、`tests_passed: true` でテストが実際に通っているチャンクが `status: "failed"` になり、`commit_hint` も抑止される。結果として「テストは通っているのにコミット支援フローに乗らない」という矛盾したシグナルをユーザーに返し、dogfooding で「Builder が壊れている」と誤認させる（#32）。

ヒューリスティックの精度には原理的な上限があるため、v0.1 の静的チェックは **完了判定のゲートではなく、エージェント・ユーザーへの参考情報** と位置づける。実装を壊したらテストが落ちるかを直接測る Mutation Testing（v0.2）が、完了判定に使える精度を持つ本来のゲート。

### なぜ Mutation Score を失敗判定に使うか

Mutation Score を「参考値」にとどめると、テストが弱いまま `complete_chunk` が通る。完了条件に組み込んで **失敗扱い → 差し戻し** ループに載せることで、Builder 内で品質が収束する。閾値の調整余地は `recipe.json` に持たせる。

### なぜ Survived mutants を Test Agent にそのまま渡すか

抽象的な品質指示より、具体的なコード変更を見せる方が Test Agent の改善精度が上がる。「この変更を検出できるテストを書け」は Red フェーズの失敗確認と同じ構造で、Agent にとって解きやすい問題設定になる。

## 8. 検証方針

- 静的チェックで `assert True` のような無意味なテストが検出されるか
- 意図的に実装にバグを入れても、静的チェックをすり抜けるテストが検出されるか（Mutation Testing の動作確認）
- Survived mutants のフィードバックで Test Agent が実際に改善できるか
- Mutation Testing のタイムアウト値が実プロジェクトで現実的か
- 閾値調整の仕組みがプロジェクトごとに機能するか

## 9. 導入ロードマップ

| フェーズ | 対応内容 |
|---|---|
| v0.1 | 静的チェック 4 項目（パラメータ網羅・異常系・統合ポイント・Assertion 品質） |
| v0.2 | Mutation Testing の統合（Stryker / mutmut）、閾値設定、フィードバックループ |
| v0.3 以降 | プロジェクトごとの閾値調整、言語別ツール追加 |

## 関連ドキュメント

- [基本設計](../basic-design.md)
- [実行フロー §4.2 Dual-Agent TDD](execution-flow.md)
- [ラウンドトリップ検証](roundtrip-verification.md)
- [コード規約](coding-standards.md)
- [MCP ツール詳細設計 §4.3 complete_chunk](../3-details/mcp-tools.md)
