# seisaku-mail CLI 実装結果

追加ファイル:
- `tools/seisaku-mail.mjs`: Node 標準ライブラリと gh のみを使う共通 CLI。使い方は先頭コメントに記載。
- `tools/seisaku-mail.test.mjs`: createCli({spawnSync}) による gh の模擬テスト。
- `result-seisaku-mail-cli.md`: 本結果報告。

使い方:
```sh
node tools/seisaku-mail.mjs draft --to info@example.com --subject '件名' --body-file body.txt --attach-drive id1,id2 --json
node tools/seisaku-mail.mjs send --to info@example.com --subject '件名' --body-file body.txt
# 上記の確認表示を確認し、承認後に --yes を付ける
node tools/seisaku-mail.mjs send --to info@example.com --subject '件名' --body-file body.txt --yes
node tools/seisaku-mail.mjs search --query 'is:unread' --max 10 --json
node tools/seisaku-mail.mjs thread --id THREAD_ID --json
node tools/seisaku-mail.mjs message --id MESSAGE_ID --json
node tools/seisaku-mail.mjs drafts --json
node tools/seisaku-mail.mjs delete-draft --id DRAFT_ID --json
```

`--wait` の既定値は600秒。送信は `--yes` 無しでは宛先・件名・本文先頭3行・添付IDを表示し、dispatchせず64で終了する。GH_TOKEN は環境変数を優先し、無ければ ~/.gh-device/token.txt を trim して使用。出力ではトークンを伏せる。

Actions の run を5秒間隔で探索・完了待ちし、artifact の result.json を優先、旧ワークフローはログのJSONへフォールバック。read系は seisaku-mail-read.yml を使用する。終了コードは成功0・失敗1・待機期限切れ2・引数不正64。

検証コマンド:
```sh
node --test tools/seisaku-mail.test.mjs
```

出力（末尾）:
```text
1..14
# tests 14
# suites 0
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

dispatch引数・UTF-8本文のbase64化・sendの確認・添付・run探索と完了待ち・artifact取得と削除・ログフォールバック・read各操作・トークン取得と非表示・環境変数優先・期限切れ・不正引数を検証。実際のActions起動・メール送信は行っていない。commit / push / PR、hook・gate・permissionsの変更は行っていない。
