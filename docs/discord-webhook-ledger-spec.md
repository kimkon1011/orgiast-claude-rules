# Discord Webhook 台帳

共有スプレッドシートの `Webhook` タブには、Webhook名、対象チャンネル、ID、生存状態、保管PC・ファイル、手入力の用途・担当・備考だけを保存する。投稿権限そのものであるWebhook URLは保存しない。

各PCの夜間バッチは `webhook-health.mjs --post-sheet` でローカルのWebhookを検査し、URLを除いた結果を自己申告する。URLの利用は `discord-webhook.mjs` がローカルファイルから解決し、見つからない場合だけ台帳から保管場所を案内する。新規作成にはDiscord Botの「ウェブフックの管理」権限が必要。
