着手: 2026-10-25 / Codex / feat/aihaijin-weekly-digest

目的: AI廃人部の週次差分取得・ノウハウ抽出・ルール反映と、対象PCへの定期実行登録を実装する。
対象: Messenger export、aihaijin-digest、登録スクリプトと converge 配布経路。
完了条件: 関連テスト・CI相当の検証とローカルコミット。push・PR作成は監督が行う。

実装: 既知キー20件での差分取得停止、保存ログ保持、週次抽出・PR反映・状態保存・通知、プロファイル設定済PCだけのconverge登録。
検証: 対象47件成功。関連82件成功/1件skip。全体6,965件中6,922件成功/40件skip/3件PowerShell起動タイムアウト（該当ファイル単独再実行5件すべて成功）。ガード全件成功、JavaScript 981ファイル構文成功、PowerShell 5.1構文/BOM成功、keyserve installer 9件成功。
環境制約: 元worktreeのGit管理領域が読み取り専用でgit addがEROFS。変更ファイルはこのworktreeに保持し、同じHEADから作った書き込み可能な一時クローンにコミットと回収用パッチ/bundleを作成する。外部push・PR作成・本番取得・通知・タスク登録はこの実装セッションでは実行しない。
