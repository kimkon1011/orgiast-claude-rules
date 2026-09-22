# 本番 next-session.md への適用待ち（2026-09-22）

このセッションの書込許可は作業ディレクトリと `/tmp` に限られるため、本番ホームへの追記は未実施。以下は修正PRの適用後、正規ローテーションを済ませた引き継ぎ票に追加する1行形式。

1. [unattended:rotation] next-session.md が417,735B・過去全文の積み重ねと追記上限なしが原因 — ホーム書込可能な実行環境で修正PRの next-session-rotate.mjs を本番適用し、退避・サイズ・残項目数をread-backする。
2. [unattended:memory] memory-index-split-verify は未分類4件の未掲載でNG — 修正PR適用後に --fallback reference で分類→退避つき再生成→独立検証を本番で実行する（コピーでは648件・4,087BでOK）。
3. [unattended:mobile] ClaudeMobile-WebServer の旧終了値は0xC000013A、3939番サーバーは別起動でHTTP 200 — Windowsタスク履歴と現在の起動元を追える実行環境で管理経路を一本化し確認する。稼働中サーバーの重複起動・強制終了はしない。
4. [unattended:auto-session] OrgiastAutoSession の終了1は15件中「アサイン未完了の制作P通知」1件が35分timeout — ブース制作アプリの共有未コミット差分を分離できた後、既存実装の配布と検証だけを再開する。実送信は別途明示指示があるまで行わない。
5. [unattended:backup] ClaudeDailyDriveBackup は一時ファイル .fleet-mail-poll.json がコピー中に消えてrobocopy exit=11 — 除外修正を適用し、削除を伴う既存 /MIR・世代整理の扱いを解決できる環境で本番再検証する。
6. [unattended:hygiene] OrgiastProcessHygiene はwrapperと本体が同じログを開きEBUSY — 修正PRの別ログ出力を実タスク参照先へ反映できる環境で再実行しLastTaskResultを確認する（Windows隔離再現は1→0）。
7. [unattended:growi] 09-22 Growi列挙失敗の末尾エラーが先頭8行への切詰めで欠落し歴史的原因は未確定 — 末尾ログ・限定再試行の修正適用後の同期結果を待つ。現時点は既存認証で6,880件列挙成功、Drive由来キャッシュ15/15本文あり。
