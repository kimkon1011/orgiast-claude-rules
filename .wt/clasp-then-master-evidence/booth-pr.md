本番 GAS へ clasp push した後に GitHub master が古いまま残り、別PCが drift を検出する問題を防ぐため、CLAUDE.md に同じターンで GitHub へ同期するルールを追加します。

GitHub push 前に隔離ディレクトリで clasp pull し、本番と同期対象 src の差分0を確認します。共通 gas-overlay-push.mjs による隔離 clone 内の commit → HEAD push → master push を使い、fast-forward 不可なら PR で統合します。同期失敗は GAS 成功と区別して記録し、共有 index は触りません。

検証: CLAUDE.md のみの変更を確認、git diff --check 成功。文書のみのためアプリのテスト・本番反映は行っていません。base は master、マージはしません。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
