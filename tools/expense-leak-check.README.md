# 経費漏れチェック（freee は読み取り専用）

`expense-leak-check.mjs` は会社 11975741 の `金立替` 口座の登録待ち明細だけを正本にし、Gmail 2受信箱と Yahoo!メールを検索します。既存明細タブは読みません。出力先は指定ブックの `AI経費漏れチェック` タブだけです。

```powershell
node "C:\Users\uers\orgiast-main\tools\expense-leak-check.mjs" --dry-run --limit 5 --no-yahoo
node "C:\Users\uers\orgiast-main\tools\expense-leak-check.mjs" --weekly
node "C:\Users\uers\orgiast-main\tools\expense-leak-check.mjs" --limit 5 --verification
```

最後のコマンドは本番の Sheet/DM 検証用です。`--verification` は `--limit 5` 以下を必須とし、追記行の「対応状況」に `検証(削除可)` を入れます。通常実行では対応状況を空欄にします。検証コマンドは送信を伴うため反復実行しないでください。

- `--from` / `--to`: YYYY-MM-DD。省略時は JST の今日と90日前。
- `--weekly`: 月曜以外は前回実行から6日以内なら skip。同日再実行も skip。
- `--dry-run`: 結果 JSON のみ保存・表示。Sheet、DM、state は変更しません（同時実行防止ロックだけ一時作成）。
- `--no-yahoo` / `--no-gmail`: 指定した検索を停止。証跡がなく検索未完了なら確定判定を保存せず再試行対象にします。
- `--limit N`: 取引日・id順にN件まで処理。既存cacheもN件に含みます。本番週次には付けません。
- `--out`: 結果 JSON の絶対パス。既定 `~/.claude/logs/expense-leak/YYYY-MM-DD.json`。
- `EXPENSE_LEAK_TODAY=YYYY-MM-DD`: JST日付の検証用上書き。
- `EXPENSE_LEAK_HOME`: state/logの保存ルート上書き。標準は OS のホーム。WSL検証では書込可能な作業ディレクトリ内を指定します。
- `EXPENSE_LEAK_YAHOO_SCRIPT`: Yahooスクリプトの絶対パス上書き。既定はホーム配下の `Downloads/CLAUDE.md配布/yahoo-auction-sniper/yahoo-mail-search.mjs`。

freeeの接続設定はリポジトリ直下 `.env.local` の `PURCHASING_APP_DATABASE_URL`、または同名環境変数を使います。既存 `freee-query.mjs` の OAuth 更新処理を `lib/freee-auth.mjs` へそのまま切り出しました。会計APIはGETのみです。OAuthトークン更新の既存POSTとトークンDB更新は維持しています。トークン値やDB接続文字列は出力しません。

Google認証は既存 `lib/drive-auth.mjs` と同じSA鍵、Sheetsは `kim@orgiast.jp`、Gmailは各受信箱をimpersonateします。Gmailにはreadonly scopeを使い、Yahooは `--open` を付けず検索一覧のみ読みます。Yahooの共有ブラウザプロファイルが使用中ならブラウザ側のロックエラーを記録し、別プロファイルを起動しません。ジョブ自身の検索は必ず直列です。

金額バリアントと正規化した利用先先頭語で検索し、取引日±10日のJST範囲を適用します。GmailのURLは受信箱別のthreadリンクです。Yahoo既存CLIは件名・送信者を構造化せず一覧テキストを260文字で切るため、明示的な日付・利用先・金額が揃う結果のみ証跡に採用します。Yahooの件名欄は一覧テキスト、送信者は空欄、リンクは受信箱トップになります。曖昧なヒット数は `searches.yahooUnverified` に記録します。メール本文の取得・既読化は行いません。

stateの確定verdictは再検索しません。期間外に残ったidも個別GETでstatusを確認し、status≠1と確認できたものだけstateから外します。検索上限（Gmail各300 / Yahoo150）、実行時間（40分、終了処理に90秒確保）、サービス障害の未完了項目は確定verdictを付けず翌週再試行します。未完了行は結果JSONに残し、Sheetへの追記を保留します。Yahooのexit 2だけは依頼仕様通り以後YahooをスキップしてGmailの結果で判定し、DMに再ログイン依頼を付けます。exit 1とexit 2は区別します。

SheetsはRAWで書き込み、数式として解釈されないようにします。id列による重複除外、ヘッダーの一致確認、追記範囲のread-backを行います。人が記入する対応状況や既存行は更新しません。Sheet追記後に処理が止まっても次回id列を確認するため二重追記しません。DMは `notifyKim` を使い、別チャネルへのwebhook fallbackは無効です。DM応答喪失時の送信済み判定はできないため、同一実行内での自動再送は行いません（後日の週次・手動実行は別通知です）。

`nightly-batch.ps1` はジョブを直接呼ぶ固定実装です。`--weekly` の呼び出しをその実行経路に追加済みなので、現在のタスクが当該ファイルを参照していればタスク再登録は不要です。`register-nightly-tools.ps1` のspecにも登録情報を追加しています。この登録スクリプトはタスクの追加Actionを作るため、適用済み環境では同日skipとロックにより二重実行を防ぎます。タスクスケジューラの登録・変更は今回実行していません。2026-10-09の実登録は `~/.claude/tools/nightly-bootstrap.ps1 -Target tools\nightly-batch.ps1` で、実行先は `ORGIAST_NIGHTLY_REPO` または既定 `~/.claude/nightly-repo` です。今回の未pushコミットを同期元へ反映するまで自動ジョブは有効になりません。反映時はその実行先 `.env.local` またはプロセス環境のDB設定も確認してください。

同時実行ロックはstateファイルと同じ場所の `.lock` です。プロセス強制終了後に残った場合は、記載されたpidのプロセスが動いていないことを確認してから当該ロックだけ削除してください。

PDF化とDriveへの保存（Phase E）は未実装です。freeeへの無視・コメント・ファイルボックス書込は実装していません。

テスト:

```powershell
node --test "C:\Users\uers\orgiast-main\tools\expense-leak-check.test.mjs"
```
