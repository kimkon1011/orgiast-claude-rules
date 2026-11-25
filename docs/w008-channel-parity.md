# 作業用008・共有チャネル

ナレッジ受信は以前、各席でSA鍵を読もうとして失敗していた。鍵なしの場合は既存のenroll認証で memoryserve の `/api/gws` に操作を依頼する。Googleアクセストークンは返さない。制作チーム名義に固定し、別アカウントへの指定はエラーにする。既存のGmailトークン配布リレーはこの経路で使用しない。

通常の onboarding-sync / setup --converge でCLI・hook・ナレッジを配布する。日次成功記録があっても索引ファイルを失った席は再取得する。ビーコンは knowledge の有無とバイト数を報告する。

```text
node tools/gmail-search.mjs --query "newer_than:7d" --body
node tools/gmail-draft.mjs --to customer@example.com --subject 件名 --body-file 本文.txt
node tools/gmail-draft.mjs --send 下書きID
node tools/drive-read.mjs --query "trashed=false"
node tools/drive-read.mjs --id ファイルID --out 保存先
node tools/drive-upload.mjs --file 保存先 --folder フォルダID
node tools/line-channel.mjs --history --limit 20
node tools/line-channel.mjs --contacts
node tools/line-channel.mjs --to 連絡先名 --body-file 本文.txt --dry-run
node tools/line-channel.mjs --to 連絡先名 --body-file 本文.txt --send
node tools/line-channel.mjs --body-file 本文.txt --dry-run
```

LINE は既存オージャスト連携bot（@154sqrqs）だけを使う。最後の宛先なしdry-runは公式のメッセージ検証だけを実行する。宛先ありの送信では共有連絡先を照合する。`--retry-key` に前回表示されたUUIDを渡すと同一送信の再試行キーを維持できる。送信結果が不明な時、新しいキーで自動再送しない。

LINE共有受信履歴は kim-PC の既存 line-openchat と line-oa の月次ログから、毎時Googleシートへ同期する。設定 `.claude/line-history-sync.json` はシートIDだけを持つ。setup の kim-only タスク `OrgiastLineHistorySync` は非表示で実行し、008/cafe015-PCは共有APIから読む。履歴の時刻と同期時刻を区別し、2時間超の同期遅れはselfcheckを失敗にする。

Gmail送信は従来のCLIを継続し、内部宛・古い下書き・スレッド整合性のゲートを通す。LINE CLIは outbound-claim-evidence-gate の対象。API側でも固定送信者・送信先・許可操作を検証する。selfcheckは読み取りのみで送信を試さない。

GWS中継の要求・応答は本文2.8MBまで。大きいファイルでは明示的なエラーになる。Drive共有権限の変更や削除はこのAPIの範囲に含まない。ナレッジは既存のハッシュ検証後に配布する。
