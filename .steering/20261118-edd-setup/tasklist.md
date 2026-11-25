# EDDセットアップ タスクリスト

> ステータス: ✅ 全完了 (2026-11-18)
> 実装者: Claude Code (auto-session)

## タスク一覧

- [x] ~~Step 1: フォルダ作成~~ ✅ → 2026-11-18 完了
  - `eval-driven/`, `eval-driven/eval-set/`, `.steering/20261118-edd-setup/` を作成
- [x] ~~Step 2: EDD設計書 作成~~ ✅ → 2026-11-18 完了
  - `eval-driven/index.md` — 目的・評価項目・フォルダ構成・EDD実装開始条件を記載
- [x] ~~Step 3: 初期評価データセット (TSV)~~ ✅ → 2026-11-18 完了
  - `eval-driven/eval-set/initial-evaluations.tsv` — 30件、6カテゴリ
- [x] ~~Step 4: 初期評価データセット (JSON)~~ ✅ → 2026-11-18 完了
  - `eval-driven/eval-set/initial-evaluations.json` — 機械処理用、TSVの内容をJSON化
- [x] ~~Step 5: ステアリングファイル作成~~ ✅ → 2026-11-18 完了
  - `.steering/20261118-edd-setup/requirements.html`
  - `.steering/20261118-edd-setup/design.html`
  - `.steering/20261118-edd-setup/tasklist.md` ← これ
- [x] ~~Step 6: コミット・PR作成・マージ~~ ✅ → 2026-11-18 完了 (PR #N)

## 次のセッションへの引継ぎ

以下の作業が残っている:

1. **EDD実装開始条件の充足確認**: `eval-driven/index.md` のゲートチェックリストを確認
2. **自動評価スクリプト (Phase 1)**: 評価データセットを読み込み、エージェントを呼び出してスコアリングするスクリプトの実装
3. **ベースライン計測**: 現在のエージェントで全評価例のスコアを取得
4. **プロンプト改善サイクル**: プロンプト改善→評価→改善のループ

### 課題・注意点

- 実際のエージェントのエンドポイントが未確定。スクリプト実装時に確定する必要あり
- 各評価例のスコアは初期値として期待値を入れている。実際のエージェント応答で上書きする
- EVAL-026/027（ITツール・VPN質問）は範囲外の質問が誤登録される問題を検出するためのテスト。斎藤さんのNote事例を参考にしている