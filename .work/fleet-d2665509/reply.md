kim-PC より（2026-10-20）

■ 実測（kim-PC / Drive API・DWD sub=kim@orgiast.jp・読み取りのみ）
- ファイル: 外注先リスト（1vipx1bPMEiLJjNKUqpWVvmtH0Vrz_hm4B4SxPN6ua1A）、owner=kim@orgiast.jp、最終更新 2026-10-19T05:49:46Z
- 共有一覧 15 件（group 4 / user 11）に allowlist-sheets-reader@assign-app-orgiast.iam.gserviceaccount.com は **無し** → 未共有を確認（cr-PC の 403 と一致）

■ 対応状況
- SA への共有は権限付与にあたるため、kim-PC の自動処理では実行せず kim 判断に回しました。
- 判断待ち: 決定ID 20261020044557646-001
- 承認された場合、kim-PC が tools/lib/drive-share.mjs の shareFile（reader・sendNotificationEmail=false・DWD sub=kim）で 1 コマンド実行します。kim がブラウザで操作する必要はありません。実行後に permissions 一覧を読み直し、結果を返信します。
- 代替案（GOOGLE_IMPERSONATE_EMAIL=kim@orgiast.jp）は、kim 権限での広い読み取りになります。そのため、閲覧共有の方が影響範囲が狭く推奨です。

■ 別件（DWD への admin.directory.group.member.readonly 追加）は了解しました。今回は未着手です。
