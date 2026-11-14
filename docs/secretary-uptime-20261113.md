# 秘書アプリの復旧と監視修正（2026-11-13）

対象は kim-PC / DESKTOP-2D0R4LI。Funnel → localhost:3939 → /secretary → localhost:3940。

## 実測と原因

- 17:09 JST 外部 `/secretary` は HTTP 502。Tailscale は接続済み、Funnel は3939を向いていた。
- 3940を既存 `.next` の production build で起動後、外部URLはHTTP 200。既存 start-prod.vbs は存在しない `.next-production` を指定していた。
- 外部 `/secretary/api/watches` は最初401。ゲートウェイを現在の `.access-token` と一致する `SECRETARY_TOKEN` で再起動後、17:23 JST に200。ただし対象ラベルは既存APIに含まれず、表示修正は別途適用が必要。
- `funnel-probe.jsonl` は11/12 10:25 JSTまでDNS成功、11:24以降失敗。FunnelProbeは診断してexit1にするのみで復旧・通知がない。
- `line-share-health.log` は11/13 14:15 JSTに3つのfetch失敗とWebServer restart failed。再起動前に6時間cooldownを保存するため、再起動失敗後も再試行しない。Tailscaleと3940は復旧対象外。
- `node.log` に3939のEADDRINUSEが反復。日時がないため、WebServerの14:15の結果1と厳密に対応するかは未確定。
- Windows Systemは11/11 00:01/00:06にWindows更新の再起動を記録。その後の該当停止・スリープイベントはなし。DNS障害開始とは約35時間ずれる。ProgramData/TailscaleはAccessDenied、ユーザー側Tailscaleログは空、TaskScheduler Operationalログは無効。Tailscale停止の契機は未確定。
- LINE監視の14:15/15:15はnotified:true。互換名sendDiscordDmの実体はkim-inboxのinfo保存で、Discord送信ではない。ask限定表示には出ない。

## 変更

`secretary-uptime.mjs` が外部URL、3939、3940をHTTPで検査する。停止したTailscaleを再接続してFunnelを復元し、HTTP不応答のサーバーだけを再起動する。ポート所有者が想定外なら停止しない。外部未復旧、24時間で同じ障害が3回以上の場合はkim-inboxのaskに原因を保存する。連続した1障害を5分ごとに新規障害として数えない。通知保存に失敗した場合は次回再試行する。

`register-secretary-uptime.ps1` は既存OrgiastFunnelProbeを5分周期＋起動時に置き換え、WebServer/LINE監視の競合する再起動を無効にする。アイドル条件なし、電池停止なし、隠し起動、同時実行禁止。S4Uでログアウト後も実行する。S4U登録に必要なWindows権限がない場合は失敗を明示し、変更した旧タスクの有効状態を戻す。ネットワークが壊れていても復旧が走るよう、実行直前のgit同期は行わない。

秘書コードはローカルGit管理のみでremoteがないため、`tools/secretary-progress`に適用する7ファイルとSHA256マニフェストを含める。実データのJSONL台帳とJSON inboxを読み、label・deadlineAt・lastCheckedAt・verdict・lastCheckOutputを表示する。完了/置換済みを進行中に復活させない。対象の「東邦2階HP 使用量把握」は11/13 13:30 JSTにdoneであり、「最近完了した見張り」に出す。未回答askは1112件、進行中は166件を実読取済み。検索とスクロール領域で表示する。APIは既存の認証を必須にし、読み込み失敗・401を空欄にしない。

## 適用と証跡

今回のCodex実行はscratchpadと/tmpだけに書き込み可能。Downloadsと.claudeへのファイル反映・タスク導入は、この環境から実行していない。予定起動の成功も未確認。コードのテスト成功を本番反映成功と扱わない。

書き込み範囲に `C:\Users\uers` が含まれ、S4U登録が可能なWindows実行で、マージ済みリポジトリから実行する。既存のproduction buildが揃っていれば、次の登録だけで予定起動・3経路のHTTP成功まで検証できる。buildがなければ旧タスクを変更する前に停止する。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\uers\.claude\nightly-repo\tools\register-secretary-uptime.ps1
```

一覧表示を適用する場合、または秘書のbuildがない場合は次を実行する。18:33 JSTの追加確認では、外部・3939・3940はいずれもHTTP200だが、秘書の `.next` と `.next-production` に `BUILD_ID` がなく、再起動事前検査は失敗した。下の適用処理でproduction buildを作成してから登録する必要がある。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\uers\.claude\nightly-repo\tools\apply-secretary-progress.ps1
```

適用スクリプトは現在の7ファイルがレビュー時のハッシュまたは適用済みハッシュと一致する場合だけ更新し、変更前をバックアップする。稼働中ビルドに触れず別ディレクトリでテスト・buildを完了してから切り替える。旧起動ショートカットも共通監視のロックを使う。最初の予定起動を待ち、LastRunTimeとLastTaskResult=0を読み戻す。既存コードが並行変更されていたら上書きせず停止する。

最終確認は外部 `/secretary` のHTTP200と、ゲートウェイ用Bearer認証を付けた外部 `/secretary/api/watches` のJSONで行う。`recentCompleted[].label` に「東邦2階HP 使用量把握」が含まれること、`warnings`が空、`inboxAsks`に未回答だけが含まれることを確認する。トークンはURL・ログ・PRに書かない。最後に予定起動の実績を報告する。

## テスト

```text
node --test tools/secretary-uptime.test.mjs tools/secretary-progress-deploy.test.mjs
powershell.exe -NoProfile -NonInteractive -File tools/secretary-uptime-registration.test.ps1
```

登録スクリプトの6ケースはタスク操作・状態ファイルをすべてmockに置き換えて実行する。成功、予定起動なし、結果1、状態ファイルが古い、外部HTTP異常、build欠落を検証し、実タスクには触れない。

秘書側は `node --test tests/watches.test.mjs tests/trip.test.mjs`、`npm run build`、Playwright `tests/e2e/watches.spec.ts`。Playwrightのfixtureテストは画面ロジック検証用であり、本番の対象ラベル表示の証拠ではない。
