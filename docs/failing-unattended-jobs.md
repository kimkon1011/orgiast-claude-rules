# 無人ジョブ調査・修正（2026-09-22）

修正ブランチ: `fix/failing-unattended-jobs`。本番適用は未実施。共有の汚れた作業ツリーを切り替えず、独立チェックアウトで作業した。

このセッションの書込許可は元の作業ディレクトリと `/tmp` のみ。`C:/Users/uers/.claude` と本番実行先は読取のみのため、本番の退避・索引再生成・ツール配布・引き継ぎ追記は行っていない。許可外の書込みをWindows経由で迂回していない。

## 原因・対応・検証

|カテゴリ|原因・証拠|対応|再実行結果|
|---|---|---|---|
|next-session|実測417,735B。session-closeの「残TODOを消さない」を過去ブロック全体の再掲で実現し、各追記ツールにも上限なし。既存handoff-compactは完了行を削除し退避しないため要件に不適合|全文のSHA-256つき月次退避を先にread-back、未完了キュー24,000B上限、30日超・完了・重複を退避。超過未完了は別キューへ保全しリンク。8つの追記経路、close-session、auto-sessionの読込前、毎晩のバッチに組込み。FBキーは別台帳に保全して再注入を防ぐ|本番コピー417,735→23,192B。未完了57件＋継続キュー1行、退避先の未完了267件（計324件）。完了203・重複13・30日超0。2回目changed=false、23,192Bで不変。本番は417,735Bのまま|
|memory-index-split-verify|再現exit=1。未掲載4件、うちpin3件。夜間の分類導出が未分類でexit=1となり再生成へ進まない。バイト上限超過ではない|夜間分類に既存の--fallback referenceを指定。不正な相対リンクも元ドメインを保持して再生成。索引は削除せずディレクトリを退避。要手当をokにしない|本番コピーの再生成後exit=0、再適用は「変更なし」。648件・13索引・19pin・4,087B。本番未適用|
|スケジュールタスク|下表の4件を個別に調査|ProcessHygieneの独自イベントログをwrapper出力と分離。Driveバックアップから短命なpoll状態ファイルだけ除外。Mobile・AutoSessionは旧結果/部分失敗を全体停止と区別|ProcessHygieneの実ログ関数をWindows cmdリダイレクト下で再現：旧exit=1 EBUSY→修正exit=0。robocopy隔離fixture：exit=1（コピー成功）、必須ファイルあり・一時ファイル除外。本番タスク再実行は未実施|
|growi-manual|09-22は100→809/6919の進捗まで記録され、先頭8行への切詰めで真の末尾エラーが消失。認証・ネットワークのどちらが当夜の原因かは確定不能|末尾8行を記録。列挙GETの通信/408/429/一時5xxのみ最大3回、各30秒で制限、認証エラーは再試行しない。不完全な列挙ではDrive・キャッシュ更新を止める|既存認証で読取のみの列挙を再実行し成功。固有6,880、API totalCount=6,919、重複39、全行走査完了。Drive書込みは実施していない|

GrowiはWebFetch非依存。`sync-growi`はGrowi APIからDriveへ複製し、利用者のsearch/getはDriveから作成したローカルキャッシュを読む。実測キャッシュは09-21 03:10 JST更新、15Parts・6,880頁、本文15/15あり。今回のエラーを認証切れと断定したり、ユーザーに資格情報を再要求していない。

## スケジュールタスクの最終照会値（JST）

`schtasks /query /fo list /v`で確認後、文字化けとAction文字列の切詰めを避けるためGet-ScheduledTask / Get-ScheduledTaskInfoでも照合した。以下は**再実行後の値ではなく、調査後の再照会値**。

|タスク|LastRunTime|LastTaskResult|原因・0になっていない理由|
|---|---|---|---|
|ClaudeMobile-WebServer|2026-09-17 14:07:12|3221225786（符号付き-1073741510、0xC000013A）|過去の強制終了。終了主体は履歴から確定できず。実際には別プロセスが0.0.0.0:3939で稼働しHTTP 200。二重起動はポート衝突するため行っていない。スマホ端末・外部ネットワークからの疎通は未確認|
|OrgiastAutoSession|2026-09-22 00:30:01|1|15件中14成功・1timeout。「3週間前のアサイン未完了通知」実装はコミット済みだが、共有ブース制作ツリーの未コミット差分で配布未了。既存launcherはreset --hard / clean -fdを含み、今回の禁止事項に抵触するため再実行せず|
|ClaudeDailyDriveBackup|2026-09-22 03:40:01|1|03:40:12 ERROR 2: .fleet-mail-poll.json が消失、robocopy exit=11。fleet-mail.mjsがpoll後に消す一時リクエスト状態と競合。修正未配布。既存バックアップの/MIR・Remove-Item・世代整理が削除を伴うため、本番コマンド再実行せず|
|OrgiastProcessHygiene|2026-09-22 10:02:42|1|run-hidden.vbsのcmdリダイレクトと本体appendLogがprocess-hygiene.logを二重openしてEBUSY。実行参照先はorgiast-main/tools。修正未配布で、実タスクの--killとホーム書込みを伴うコマンドは実行せず|

## 検証ログ

コピー上の独立検証:

```text
生成予定: memory 648件 / sub index 13件 / MEMORY.md 4087B
適用完了: /tmp/unattended-evidence/memory/MEMORY.md
検証 OK: memory 648件 / sub index 13件 / pin 19件 / MEMORY.md 4087B
# 再適用
変更なし
検証 OK: memory 648件 / sub index 13件 / pin 19件 / MEMORY.md 4087B
```

Windows隔離検証:

```text
ProcessHygiene appendLog / cmd redirect: before exit=1 EBUSY; after exit=0 OK
robocopy fixture: exit=1; required copied=True; ephemeral excluded=True
nightly-batch.ps1 parse OK
backup-claude-to-drive.ps1 parse OK
```

Node回帰テスト350件PASS、skillのfrontmatter検証、git diff --checkを実施。完全な本番E2EやタスクのLastTaskResult=0の証明とは区別する。

## 残作業

本番用の1行起票は [適用待ち一覧](failing-unattended-jobs-followup.md) に保存。ホームへの書込可能な実行環境で、PRの修正を適用し、非破壊の退避・索引修復・タスク配布と再検証を行う。マージはしていない。既存タスクやファイルの削除・無効化、mainへの直接pushは実施していない。
