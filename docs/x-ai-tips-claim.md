着手: 2026-11-03 / Codex / feat/x-ai-tips-collect

目的: X の AI 活用 tips を夜間収集し、既存の ai-news-triage に合流する。
対象: 専用 worktree wt-x-ai-tips の収集ツール・設定・テスト・夜間接続・文書。
完了条件: 関連テスト、キーがあれば dry-run 1 回、コミット・push・PR（マージしない）。
環境確認: 専用ブランチは既存、開始時差分なし。git fetch origin は Git 管理領域の Read-only file system で失敗。

検証: 新規20件と関連既存327件、計347件が成功。変更JS構文と差分空白チェック成功。
実API: Windows側の既存キーを ORGIAST_HOME 経由で参照し、--dry-run --limit 1 を1回実行。
最終行: ok:取得0件 追加0件 重複0件 費用$0.32
公開方法: git add も index.lock の Read-only file system で失敗。作業成果はこのworktreeに直接保持し、GitHub Git Data APIで同じHEADから変更7ファイルだけをコミット・ブランチ公開する。隔離クローンやbundleは作らない。PR作成後はマージせず監督レビュー待ち。
