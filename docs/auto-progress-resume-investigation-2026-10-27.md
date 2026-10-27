# auto-progress resume 起動失敗の調査（初回）

2026-10-27 19:12 JST（10:12 UTC）。調査環境はLinux、Node.js v22.23.3。
対象checkoutは `/mnt/c/Users/user/.claude/quota-sweep-repo`、branchは
`quota-sweep/20261027-0951-codex-mvqia4lz`、基点revisionは
`5f631d1d1712f1c8a7060f4fddc2e92bc289fc47`。開始時の追跡差分なし。
本変更は調査記録のみ。実セッション再開・通知送信・本番変更は行っていない。

## 確認できた入力

Linux側 `/root/.claude/auto-progress-ledger.jsonl` は存在せず、
Windows側 `/mnt/c/Users/user/.claude/auto-progress-ledger.jsonl` が実在する。
JSONLを全行読み、sessionIdのprefix `677e8433` で抽出した。
360行目に `resumeCount=6`、`resumeOutcome="error: failure"`、
`resumedAt=2026-10-27T07:00:01.345Z` がある（JSTでは16:00:01.345）。
cwdはWindows側の `.claude/wt-notify-toast`。
これは累積値であり、6回それぞれの実行時刻・引数・実装revisionの証明ではない。
入力の「02:00〜07:00」をJSTと断定できない。
現在cwdの実在は確認したが、当時の存在や実行成功を示さない。

watchログにはEBUSYと集計JSONがあり、今回の検索では対象sessionIdを確認できない。
通知ログで確認したtoast記録はresume成功の証拠にしない。
サニタイズ済みの抽出値はローカル `.loop/resume-v1-001-ledger.json` に保存。
原ログは変更していない。

## 識別実験

仮説: `error: failure` だけでは、起動失敗と起動後の異常終了を区別できない。
`node .loop/resume-v1-001-probe.mjs` を実行（exit 0）。
一時ディレクトリ内の副作用のない実行ファイルを、実際の `runChild` 経由で起動。
executorRootを当checkoutに固定し、model指定でClaude側のspawn分岐を選択した。
Claude本体は起動していない。fixtureはstdinを消費し固定のstderrを出してexit 23する。
別ケースは存在しない実行ファイルを指定した。

| ケース | runChildの直接結果 | resumeSessionの結果 |
| --- | --- | --- |
| fixture異常終了 | exitCode 23、launchFailed false、stderr fixture-exit-23 | error / failure |
| 存在しない実行ファイル | exitCode -2、launchFailed true、stderr ENOENT | error / failure |

両ケースについてassertで直接結果と返却値を照合した。
証跡は `.loop/resume-v1-001-probe.json`（10:11:39.751 UTC）と同名stderr。
`tools/auto-session.mjs` のrunChildはexitCode・stderr・launchFailedを返すが、
`tools/auto-progress-watch.mjs` のresumeSessionは非success結果をstatus文字列のみに縮約する。
観測情報の欠落は再現できた。しかし過去6回の根本原因は依然unknownである。
この実験は修復のRED/GREENでもWindows実行の再現でもない。

## 受入と残件

`node --test tools/` はexit 1。Node.jsがtoolsをモジュールとして解決し、
`MODULE_NOT_FOUND` となった。TAPはtests 1 / pass 0 / fail 1、
実テスト群の収集なし。`.loop/resume-v1-001-gate.log` に保存。
別コマンドでの代替合格扱いはしていない。

未達: 6回の個別履歴、当時の実装revision・起動引数・cwd・環境・stderrの対応、
原因に対応する最小修復と子プロセス境界の成功/失敗回帰、指定ゲートの成功、
通知・dry-run・予約・回数制限の確認、独立した人間レビュー。
次手は当時のタスク実行記録・ledgerバックアップ・子プロセス出力保存先を絞って調べ、
6件を直接証拠で復元する。根拠が揃うまで特定原因の修復を断定しない。
