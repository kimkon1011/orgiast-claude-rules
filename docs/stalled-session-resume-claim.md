# 着手記録
2026-11-05: Codex。Windows の台帳 rename 競合の再試行・一意な一時ファイル・保存チェーン復旧と回帰テストに着手。commit・push・タスク登録は行わない。
同修正完了。指定2ファイルはWSLで52/52 pass、WindowsネイティブNodeの stalled-session-resume は32/32 pass（問題の並列実行テストを含む）。commit・push・タスク登録は未実施。
2026-09-24: Codex / feat/stalled-session-auto-resume。停滞セッションの夜間再開・配布・隔離テストを担当。push / PR は行わない。
実装・検証完了。全体3010 tests: 2999 pass / 0 fail / 11 skip、guards ALL PASS。検証用コピー削除済み。

2026-11-05: Codex / feat/stalled-session-all-nightly。全件確認・締切・cwd排他並列・専用タスク配布の実装とテストに着手。外部送信・登録・push は実行しない。
実装完了。再開処理30件・夜間関連77件はpass。配布/登録系22件も各項目passを確認。追加のsetup全体テストはローカルHTTP fixtureの長時間待機で中断（全体成功とは扱わない）。実登録・通知・push・commit は未実施。

2026-11-06: Codex / fix/wait-deadline-resume。待機期限切れ専用モード・timeout 再試行・実行者記録・15分タスク配布と回帰検証に着手。このブランチ内で commit まで。実再開・タスク登録・push・PR 作成は行わない。

2026-11-06: 実装完了。再開テスト42 pass / 0 fail、関連4ファイルの実行206 pass / 0 fail（再開40件を含む、その後追加2件も上記42件で検証）。PowerShell 5.1構文解析とWindows実データ --overdue --dry-run 成功。選択: 28c97712（X投稿から性能改善）、3577c936（佐藤さん・ClaudeInboxBridge）。実台帳更新・タスク登録・再開・通知・push・PRなし。git add は共有Git管理領域 index.lock の Read-only file system で失敗、commit未実施。
Windows Nodeで selftest-guards 完走: 68 pass / 1 fail。未変更の tool-adoption-check「detached導入は同期的にブロックしない」が上限10000msに対し21456msで失敗。git diff --check 成功。Linux側ガード検査はフック配布テストが長時間化しており全体成功とは扱わない。

2026-11-06: Codex / fix/wait-deadline-resume。Windows Node の runChild 失敗を再現し、期限内の alternate・codex-do 遷移を修正、Windows/WSL の指定2テストを検証する。commit は行わない。

2026-11-06: Windows追加修正の最終検証。同期taskkill/close待ちで予算を消費する経路を除き、Windows終了処理の起動をWorkerへ移動。残り実行者数に応じた予算配分、alternate timeout後のcodex-do、二重close防止、終了コード保持、stdin ignoreを実装。両cheap timeout・全timeoutの予算検証を追加。並列テストの20ms仮定を開始バリアへ変更（期待値は維持）。Windows: auto-session 138 pass / 0 fail / 2既存skip、stalled-session-resume 42 pass / 0 fail。WSL: 合計182 pass / 0 fail / 0 skip。diff --check成功。高負荷時にはWindowsの子プロセス起動が1.5〜2.6秒かかり短い予算の実プロセステストが失敗することも観測。OSのプロセスツリー終了は非同期で継続。診断用コードは削除済み、commitなし。
