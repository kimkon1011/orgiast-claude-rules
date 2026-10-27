# cdee0672 自動進行の再開結果

対象は2026-10-25の宣言「iter2 の oauth/usage 呼出元実測、Retry-After 対応とキャッシュ共有、回帰テスト、node --test tools/ 基準線取得」。現在の .loop/quota-sweep-claude.md は別案件の契約に置換済みなので、その状態・budget・証拠を更新していない。

checkout: /mnt/c/Users/user/.claude/quota-sweep-repo、branch: quota-sweep/20261027-0951-codex-mvqia4lz、基点 HEAD: ad052f016b762df499e2e9b21ab48733c8644046。変更前の追跡差分なし。既存の未追跡成果物と別セッションの状態は保持。記録時刻・最終ソースSHA256は .loop/resume-cdee0672-manifest.json。

## 実測と呼出経路

既存 .loop/quota-sweep-claude-002-c2.log に2026-10-25T07:11:03Zから約1秒間隔の200応答4回、その後07:11:08Zに429と Retry-After:300 を得た記録がある。今回この負荷実験を再送していない。履歴による測定であり、今回の本番再現ではない。

全 tools/*.mjs の検索ではAPI URLの直接使用は tools/claude-plan-usage.mjs に集中。共通関数の本番呼出元は tools/plan-usage-report.mjs:74、tools/fleet-sheet-report.mjs:130、tools/lib/quota-windows.mjs:56、および同モジュールのCLI。quota-sweep は quota-windows 経由。cost-work-loop にこの関数の直接呼出しは見つからなかった。

Windows側 settings.json:746 は nightly-repo/tools/plan-usage-report.mjs --hook を実行する。ログの読取りでは plan-usage-report.log 95行、quota-sweep.log 1037行中429を含む行62件。サニタイズした入力パス・行数・最新時刻は .loop/resume-cdee0672-callers.json。これらは各呼出元の実在・実行記録であり、特定の2プロセスが同時刻に429を起こしたという因果の証明ではない。

現行 quota-sweep.mjs には既にプロセス内15秒キャッシュと数値Retry-After対応がある。一方、共通関数と実行ツリー nightly-repo/tools/claude-plan-usage.mjs には共有キャッシュ対応が無かった。既存のquota対策を削除せず共通層の残件を修正。

## 変更

- tools/lib/claude-usage-cache.mjs を追加。homeごとの成功結果を15秒ディスク共有し、トークンのSHA256で認証変更を分離。認証情報自体は保存しない。期限切れreset・不正キャッシュ・時計の巻戻りでは成功結果を再利用しない。
- 429の Retry-After は秒数とHTTP日時を解釈し、期限をディスク共有する。期限内はHTTP呼出しを行わず、available:false / reason:HTTP 429 / retryAfterMs を返す。失敗を成功値に置換しない。
- 排他ファイルで同時取得を抑制し、120秒の古いロックは回収。取得中の別読者は一時的な計測不能を返す。APIの既定タイムアウト30秒。キャッシュ保存不能時はAPI結果を返すが、共有・抑制は保証できない。
- quota-windows は now と retryAfterMs を引継ぎ、quota-sweep の読取ラッパーも同じ時計を渡す。既存のstale窓fallbackは維持。
- キャッシュTTL、認証変更、破損、reset期限切れ、Retry-After境界、回復、同時読者、失敗後のロック解放を回帰確認。

## 検証

Node v22.23.4 / Linux。最終変更に対して次の指定ファイル実行は exit 0、4ファイル pass 4 / fail 0 / skip 0（.loop/resume-cdee0672-targeted.log）。

    node --test tools/claude-plan-usage.test.mjs tools/lib/quota-windows.test.mjs tools/quota-sweep.test.mjs tools/plan-usage-report.test.mjs

共通関数の直接テストは12件 pass 12 / fail 0（.loop/resume-cdee0672-unit.log）。独立した4回のNode起動で seed/read/block/blocked-reader を実行し全てexit 0。別プロセスでの成功キャッシュ共有、および readClaudeWindows への待機期限伝達を、ネットワークを使わないfixtureとassertで実測した（.loop/resume-cdee0672-shared-probe.mjs、同.log）。初期の子プロセステストはこのサンドボックスのNode内spawnSyncがEPERMを返すため失敗した。単体テストはfresh importへ修正し、プロセス間の証明はシェルから独立起動した上記probeで取得。skipや期待値緩和で合格にしていない。

git diff --check と新モジュールの node --check はexit 0。未コミットのレビュー用パッチは .loop/resume-cdee0672.patch（追加モジュールを含む）。

指定の全体基準線 node --test tools/ はexit 1、MODULE_NOT_FOUND。TAP tests 1 / pass 0 / fail 1で、tools配下の実テスト群を収集していない（.loop/resume-cdee0672-baseline.log）。ファイル指定テストの成功を全体ゲート合格に置換していない。全体テスト全緑は未確認。

## 保存・実行範囲の制約

要求された /mnt/c/Users/user/.claude/auto-progress-resume-cdee0672.json は、このセッションで許可された書込み先（当checkoutと/tmp）の外。権限変更・別経路の書込みは行わず、代替JSONを .loop/auto-progress-resume-cdee0672.json に保存した。stateはprogressedで、未達をevidenceに明記。

.git は ../nightly-repo/.git/worktrees/quota-sweep-repo を指し、Gitメタデータも読取専用なのでコミットしていない。push・PR・デプロイはこの再開宣言の成果範囲に追加せず未実施。実行ツリー nightly-repo への配布は書込み範囲外で未実施のため、本番hookが修正済みと主張しない。残件は指定パスへの結果保存、全体ゲートの収集可能な環境での検証。本人の判断・操作は要求していない。
