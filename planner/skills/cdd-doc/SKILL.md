---
name: cdd-doc
description: CDD 設計文書（基本設計 / 機能設計 / 詳細設計 / ユースケース）を design-doc-standard に沿って作成・編集する。フロントマター・フォルダ配置・現在形・CHANGELOG 追記・UC/AC 連番・status 遷移ルールを一貫適用する。「設計文書を書いて/直して」「ユースケースを追加」「機能設計を起こす」「詳細設計に分割」などで使う。
---

# CDD 設計文書の作成・編集

CDD プロジェクトの設計文書を design-doc-standard に従って作成・編集するための手順。設計文書とコードはデジタルツインの関係にあり、表現型が違うだけで内容は一致しているべき。

## 0. 標準を読む

作業前に標準文書を読む。優先順位:

1. 作業対象プロジェクト内に `design-doc-standard.md`（または `docs/design-doc-standard.md`）があれば、それを使う。
2. 無ければ、このスキルの出自である CDD-Assistants リポジトリの `docs/design-doc-standard.md` を既定とする。

## 1. 置き場所を決める（フォルダ＝階層）

| 階層 | layer | フォルダ |
|---|---|---|
| 基本設計（1本） | foundation | `Documents/`（ルート）|
| ユースケース | usecase | `Documents/1-usecases/` |
| 機能設計 | specification | `Documents/2-features/` |
| 詳細設計 | interface | `Documents/3-details/` |
| 運用（非コード）| operation | 運用文書 |
| 参考・標準 | context | `Documents/4-ref/` |

フォルダ名は変えない（Builder の tier 推定が効かなくなる）。ファイル名のケースはプロジェクトで統一する（C# / .NET は PascalCase 可。基本設計と README は固定名）。

## 2. フロントマターを必ず付ける

```yaml
---
status: draft         # draft / in_review / complete / archived
layer: specification  # foundation / usecase / specification / interface / operation / context
decisions:            # 任意: track_decision の決定ID
  - DEC-00X
open_questions:       # 任意: 未解決の論点
  - OQ-X
---
```

## 3. テンプレートに従う（標準 §9）

- **基本設計**: 目的/スコープ → アーキテクチャ → 技術選定 → データモデル → 制約。技術選定には理由を必ず添える。
- **機能設計**: 概要 → 構成要素（バウンダリ/エンティティ/コントローラー）→ ユースケース → 受け入れ基準（EARS）→ 設計判断 → 検証方針。
- **詳細設計**: 概要 → 一覧（サマリ表）→ 詳細仕様（入力/出力/処理ステップ/エラー処理）。**500行・5,000トークン以下**、超えたらモジュール単位で分割。対応コードを明記。
- **ユースケース**: UC-ID/AC-ID、基本コース/代替コース/受け入れ基準/図（mermaid）。アクター別にファイル分離。

## 4. 記述の品質ルール

- **現在形**で書く（「〜する」「〜である」）。「追加した」「修正した」は書かない。
- **文書単体で完結**。他文書/Issue を読まないと意味が通らない記述は避け、参照はリンク＋要約を添える。
- 禁止: 編集痕（「以下を追加」）・作業ログ（「前回の議論を踏まえ」）・TODO/TBD・過剰な経緯説明。
- セクションの役割を守る（テンプレが求める内容だけ書く）。

## 5. UC / AC の連番

- `UC-1, UC-2…` / `AC-1, AC-2…` を連番・欠番なしで。途中挿入したら後続を振り直す。
- 受け入れ基準は EARS 記法を推奨（When/While/Where … the system shall …）。必須ではなく、自然言語の方が明確ならそちらで。
- mermaid 図は、ダークテーマ環境で見えないことがあるので必要なら `%%{init: {"theme":"dark"}}%%` を先頭に付ける。participant 別名に半角カッコ `()` を入れない（パースエラー）。

## 6. 編集後に CHANGELOG を追記（毎回・忘れない）

`Documents/CHANGELOG.md`（複数コンポーネントなら各フォルダ直下）に1行追記:

```
## YYYY-MM-DD

- {ファイル名}: {変更内容の要約}（{コミットハッシュ}）
```

git 管理外ならコミットハッシュは省略してよい。

## 7. status 遷移は人間承認

- `draft → in_review`: check_readiness 合格 または人間。
- `in_review → complete`: **人間の明示承認が必須**。勝手に complete にしない。
- 迷ったら draft のまま、`open_questions` に論点を残す。

## 8. design-first を守る

設計文書に無い機能を実装しない。新機能・新パラメータ・新テーブルは、先に該当文書を更新してユーザー承認を得てから実装に着手する。バグ修正・リファクタ・テストは例外。

## 9. 仕上げ

- `[[wiki-link]]` で関連文書へ相互リンクする。
- `validate_refs` 相当で UC/AC の欠番が無いか確認する。
