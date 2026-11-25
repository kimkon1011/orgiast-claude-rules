---
name: global-rule-rollout
description: 「組織指示に入れて」「全体ルールに追加」「全体配布して」「全パソコン」「全アカウント」「全プロジェクト」「全PC」「全てのPCで」「全部に適用」「rollout」など全体適用の合図が来たら必ず使う。既実装の確認からルール変更のレビュー・各PCの配布確認までを扱う。
---

# 全PC・全アカウントへルールを適用する

実測: 2026-10-27 08:11〜08:17に同一文面を5セッションが受領。4セッションがPR #1180/#1182で反映済みと気づくまで計72回の重複調査、1セッションは別経路でDrive投稿した。出典: `~/.claude/skill-and-loop-redesign-20261028.md` §1。

## 1. 既実装を先に確認する

対象ルール・ゲート・適用範囲を特定し、rules repo の変更・PR、memory、share-knowledge の投稿記録、rules-sync の配布記録を先に読む。同一セッションや前セッションの結果（PR番号・状態・確認日時）があればそれを起点にする。同じ文面を再受領しても調査を最初から繰り返さず、未確認の状態だけ更新する。

既にレビュー・配布まで済んでいれば **「✅ 反映済み」＋根拠（PR番号・配布日・対象範囲）** を出して終える。PR作成済み・main取込済み・全PC同期済みは別の状態として扱い、PRだけで全体反映済みとしない。配布未確認なら手順4へ進む。

## 2. 組織指示の追記文を Google ドキュメントにする

既実装確認の後、組織指示への追記文を番号付き・1項目1〜2行でまとめ、Google ドキュメントとして Drive に作成する。書き込み後に本文を読み戻し、`https://docs.google.com/document/d/<documentId>/edit?authuser=kim@orgiast.jp` のURLを渡す。既存の同じ追記案があれば再利用する。ローカルMarkdownやClaude Docsを納品先にしない。

## 3. 未実装の変更だけを rules repo へ

hook・定期ジョブで強制できる指示は、判定・テスト・登録・rollout・解除手順までPRに含める。実行ツリーや settings.json を直接編集して配布の代わりにしない。

既存PRがあれば再利用する。未実装部分を rules repo へ変更し、検証後にPRを作る。**ゲート・ルールはレビュー必須**。`workflow` / keyserve / secrets / fleet に触る変更には `automerge` ラベルを付けず、PR冒頭に手動マージが必要な理由を書く。その他もレビューと適格条件を確認してから [GitHub CLI の pr-land](../../playbooks/GitHub%20CLI.md) に従う。

push/PR/merge禁止レーンでは禁止を優先し、ローカル変更・検証結果と制約を報告する。配布を名目に別経路から禁止操作を行わない。

## 4. 各PCの同期を実測する

[既存 rules-sync skill](../rules-sync/SKILL.md) のpullと [ONBOARDING §3.0](../../ONBOARDING.md) の自動取込・巡回を使う。本repoには `tools/rules-sync.mjs` が無いため、`node tools/rules-sync.mjs pull` 相当の実在経路は、対応環境での `node scripts/drive-hub-sync.mjs pull`、または同skillのDrive MCP pull。古いハブで新しい手元を上書きしない。

各PC・対象アカウントについて、同期版・確認日時・結果を記録する。1台のpull成功を全PC成功にしない。取り込み待ちは **「取り込み予定日: <日付と定期実行等の根拠>」** を書く。次回起動依存など日付が確定しなければ「取り込み予定日: 未定（次回セッション起動時）」と明記し、予定を捏造しない。取得できないPCの状態は「未確認」。

このskillは全体適用の判断・重複防止を担当する。投稿は [share-knowledge](../share-knowledge/SKILL.md)、同期の具体的操作は rules-sync に委ね、同じ変更を別経路へ重複投稿しない。
