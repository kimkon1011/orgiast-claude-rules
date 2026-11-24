# 受信ルーター

`inbound-router` は、000KimPC で15分ごとに Beeper の全ネットワークと Gmail 2箱の新着を読み、案件担当PC・担当セッションへ引き渡す読み取り専用の入口です。社内外への送信は行いません。`catch-and-act` が日程変更・提出物を処理するのに対し、こちらは受信の振り分け、返信案・次の行動の作成依頼、未着手の再投入を担当し、両方を併用します。

## 運用

- 実行: `node tools/inbound-router.mjs --once`
- 計画確認: `node tools/inbound-router.mjs --dry-run --since-minutes 120`
- 見回り強制出力: `node tools/inbound-router.mjs --digest-now`
- タスク登録: `powershell -NoProfile -File tools/register-inbound-router.ps1`
- 停止: タスク スケジューラの `OrgiastInboundRouter` を無効化する。状態を残すため `~/.claude/inbound-router/state.json` は削除しない。

状態は `~/.claude/inbound-router/state.json`、実行ログは `~/.claude/logs/inbound-router.log`、9時・15時・21時の要判断レポートは `~/gb-reports/latest-inbound-router.md` に置きます。`ORGIAST_HOME` でホームを差し替えられます。取得に失敗したソースの読取位置は進めません。

## 振り分け表

| route | 担当PC | 用途 |
|---|---:|---|
| learning | 000 | あつまる石井塾（指定セッションへ再開） |
| sales | 011 | 新規問い合わせ・見積（ブース以外） |
| booth | 014 | 展示会ブース・Reブース |
| event | 008 | その他イベント |
| gakkai | 018 | 学会出展獲得 |
| minpaku | 004 | 民泊 |
| lahaina | 015 | ラハイナ・カフェ |
| toho | 999 | 東邦鋼業 |
| discord-existing | 配送なし | Discord既存自動応答へ任せ、件数だけ記録 |

一度決まった Beeper chatID / Gmail threadId は state の `threadRoutes` に保存し、次回からAIを呼ばず即決します。ルール不一致だけを同じスレッド単位で1回、`llm-ask` の非Claudeプロバイダで分類し、確信度0.7未満・全滅時は `unknown` として次の見回りに載せます。AI相手の `ChatGPT Dots`、`Grok Bot`、`Muse`、自分の送信、Discord、Gmailの配信メール・noreply・promotions/social は振り分けません。ルールは件名・チャット名・送信者を上から評価し、`matchBody: true` のルールだけ本文も評価します。

配送は route ごとに1通へ束ねます。60分未完了・失敗・期限切れは最大3回まで再投入し、その後は「渡したが未着手」として要判断へ送ります。000自身宛ても fleet-mail の `000KimPC → kim-PC` 自己配送を使い、指定セッションを再開します。
