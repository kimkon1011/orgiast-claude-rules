# 未対応フィードバックの毎日プッシュ（ローカル実行・Discord DM）+ 判定定義の統一

## 背景（kim 指示 / 2026-09-06）
「溜まっている要望や不具合を、返答がない場合は毎日プッシュして。kim のパソコンは kim に DM で。」

### なぜ GAS ではなくローカルで送るのか（この設計を変えないこと）
Discord の **DM は webhook では送れず Bot トークンが要る**。Bot トークンを GAS の
Script Properties に入れると認証情報をクラウドへ複製することになるため、**トークンは
この PC のローカルファイルに置いたまま**、ローカルの定期実行から DM する。
即時通知は既存の中継（`FEEDBACK_RELAY_URL`）が担当し、**中継が落ちて通知が飛ばなくても
翌朝のこのプッシュがシートを読んで必ず拾う**、という二段構えにする。

## 実測済み（調べ直さない）
- 既存 API: `~/.claude/booth-feedback.env` の `BOOTH_FEEDBACK_URL` + `BOOTH_FEEDBACK_TOKEN`。
  `GET <URL>?token=<TOKEN>&action=feedback` が下記を返す（実測）:
  ```json
  {"ok":true,
   "sheetUrl":"https://docs.google.com/a/orgiast.jp/spreadsheets/d/<id>/edit",
   "counts":{"open":1,"total":7},
   "items":[{"key":"row2-202608211632","rowNumber":2,"ts":"2026-08-21 16:32",
             "kind":"要望","title":"...","body":"...","status":"new",
             "note":"[2026-08-28] 一部実装済み: ...","source":"パネル","images":[]}]}
  ```
  `items` は既に未完了のみ。`sheetUrl` は `/a/orgiast.jp/` 形式で返ってくる（加工不要）。
- Discord Bot トークン: `~/.claude/orgiast-discord-bot-token.txt`（1行）。
  同じ読み方の先例が `tools/discord-digest.mjs` にある（`process.env.DISCORD_BOT_TOKEN` →
  無ければこのファイル）。**トークン値をコード・ログ・ドキュメントに出さない**
- kim の Discord ユーザーID: `715210673642012733`。DM は
  `POST https://discord.com/api/v10/users/@me/channels`（`{recipient_id}`）→
  `POST /channels/{id}/messages`。実測で両方 200

## 作業 1: `tools/feedback-nag.mjs`（新規）

```
node tools/feedback-nag.mjs [--dry-run] [--json]
```

- `~/.claude/booth-feedback.env` を `parseEnvText`（`./env-kv.mjs`）で読む。
  URL/TOKEN が無ければ stderr に理由を出して **exit 0**（他の定期処理を巻き込まない）
- 上記 API を叩き、`items` を取得
- **プッシュ対象の定義（ここが要）**: `status` が `done` / `完了` / `対応済` / `却下`
  のいずれでもないもの**全部**。`note`（対応メモ）が入っていても**除外しない**。
  代わりに各行へ状態を出す:
  - `note` が空 → `未返答`
  - `note` あり → `返答済・未完了`
  （実測で唯一の未完了1件が「メモ入りだが未完了」だった。メモ空だけに絞ると取りこぼす）
- **0 件なら送信せず exit 0**（毎日の無意味通知を作らない）
- DM 本文:
  ```
  🐛 未対応の不具合・要望 N 件
  ・[要望/未返答] タイトル … 経過 16 日 / 送信元: パネル
  ・[不具合/返答済・未完了] タイトル … 経過 3 日 / 送信元: 印刷物チェックシート / フォーム
  （最大 15 件。超過は「ほか M 件」）
  <sheetUrl>
  ```
  - 経過日数は `ts`（`YYYY-MM-DD HH:mm`）から算出。パースできなければ `経過不明` とし**落とさない**
  - タイトルは 70 文字、送信元は 50 文字で切る。全体は 1900 文字で切る
- 送信先ユーザーIDは `~/.claude/feedback-nag.env` の `FEEDBACK_NAG_DISCORD_USER_ID` を読み、
  無ければ既定値 `715210673642012733`（このPC=kim 用）。**他PCでも使えるよう env で上書き可能にする**
- `--dry-run` は送信せず本文を stdout に出す。`--json` は
  `{ok, count, sent, items}` を JSON で出す
- 例外は握って stderr に出し **exit 0**（定期実行を落とさない）。ただし
  `--json` 指定時は `{ok:false,error}` を出す

### テスト `tools/feedback-nag.test.mjs`
既存テスト（`booth-feedback-intake.test.mjs` 等）の書き方に合わせる。最低限:
- `done` / `完了` / `対応済` / `却下` が除外されること
- `note` ありでも対象に残り `返答済・未完了` と出ること
- 0 件で送信しないこと
- 15 件超で「ほか M 件」が付くこと
- `ts` が壊れていても落ちず `経過不明` になること
fetch と DM 送信は注入（`fetchImpl` 等）でモックし、**実際にネットへ出ない**こと。

## 作業 2: `tools/register-feedback-nag-task.ps1`（新規）

`tools/register-booth-feedback-task.ps1` を雛形にして**毎日 9:00** の Windows タスクを登録する。
- **ASCII のみで書く**（PS 5.1 が BOM なし UTF-8 の日本語を Shift-JIS と誤解して parse error になる）
- `ensure-run-hidden.ps1` / `New-HiddenScheduledTaskAction` / `nightly-bootstrap.ps1 -Target tools\feedback-nag.mjs`
  の流儀をそのまま踏襲（黒いウィンドウを出さない）
- 何度実行しても同じタスクを上書きするだけ（`-Force`）。他のタスクに触れない

## 作業 3: 判定定義を GAS 側にも合わせる（2ファイル）

`FeedbackRelay_nagPending()` の「未対応」判定を上記と同じにする。
1. `C:/Users/uers/Downloads/ブース制作アプリ/src/FeedbackRelay.js`
2. `packages/feedback-gas/templates/FeedbackRelay.js`

現状は「状態が done 系でない **かつ** 対応メモが空」になっている。これを
**「状態が done 系でない」だけ**に変え、行の表示に `未返答` / `返答済・未完了` を付ける。
それ以外（0件なら送らない、最大15件、ヘッダー名で列を引く、URL 形式）は現状維持。

## やってはいけないこと
- Bot トークンやシートトークンの実値をコード・ドキュメント・ログ・コミットに書く
- GAS の Script Properties にトークンを入れる前提の変更を足す
- 0 件でも通知を送る
- 指定した4ファイル（新規2 + GAS2）以外を変更する。このリポジトリには他セッションの
  未コミット差分が大量にあるので触らない
- `git add` / `git commit` をする（監督が verify 後に行う）

## 完了条件
- `node --test tools/feedback-nag.test.mjs` が通る
- `node tools/feedback-nag.mjs --dry-run` が実データで本文を出す（送信しない）
- 変更点を 5 行以内で要約して出力する
