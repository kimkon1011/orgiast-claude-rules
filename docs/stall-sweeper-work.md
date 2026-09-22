# 停滞スイーパー: 実装と検証記録

担当: Codex / 着手日: 2026-09-22。実装・単体検証済み。実運用の登録は未完了。

## 追加ファイル

- [スイーパー](../tools/stall-sweeper.mjs): 7種類の独立した検出関数、既定dry-run、最大5件、3回連続失敗で停止、結果報告とhuman通知。
- [テスト](../tools/stall-sweeper.test.mjs): 検出境界、完了除外、成功status、失敗回数、排他、実Gitでのコミット、テスト失敗、他作業の混入、PR処理の再開、委譲証拠、重複起票を検証。
- [Windows登録](../tools/register-stall-sweeper.ps1): 毎日04:10、`--apply`、既存タスク更新、重複起動抑止、登録後の読戻し。`-ValidateOnly` は登録しない検証モード。

## 実装上の判断

- 自動マージ、mainへの直接push、force push、ブランチ削除、ファイル削除、スケジュールタスク削除は行わない。実行委譲は `codex-do.mjs`。Claude CLIを起動しない。
- `git add -A` で他セッションの新しい変更を取り込まないため、全変更が2日以上経過し、検出時と内容が一致する場合だけ進める。競合、削除、秘密情報を疑う未追跡ファイルは自動コミット対象外。
- テスト失敗はコミットせず、原因を1行にまとめてGitHub issueに起票。同じ項目の既存issueがあれば再利用する。通信失敗時もローカル報告に残す。
- コミット後にpush/PR作成で失敗しても、保存済みコミットから次回再開する。
- `stale_branch` は報告のみ。ユーザーがこのカテゴリの変更操作を指定していないため、整理・削除はしない。
- TODOは初回観測を保存し、毎日ファイルが再生成されても残存期間を追跡する。古い日付の記載や初回観測がない新しいファイルでは、3日経過の確証が得られるまで待つ。
- 委譲はexit=0だけで成功にせず、完了結果と検証ファイルのSHA256を読戻す。ただしハッシュは証拠ファイルの整合性の確認であり、外部業務の正しさ自体を保証するものではない。委譲先には対象システムの直接検証を指示する。
- 実行台帳にjob識別子がない場合はprovider/cwd単位で最新実行を判定する。別ジョブを完全に識別するには元の台帳にjob名が必要。
- 対応コミットの照合情報や終了コードがないCodexログは「未確認」とする。テスト結果の文中に出るexit=0は、委譲自体の成功と扱わない。
- auto-sessionの既存登録スクリプトは03:20ではなく00:30開始・07:30締切だった。時刻だけでは衝突を防げないため、実行中タスク・既存ロックの確認でも保留する。照会不能時も実行を保留する。

## 再利用

`codex-do.mjs`、`notify-kim.mjs`、`auto-session.mjs`のTODO解析・除外・リポジトリ名解析、`session-triage.mjs`の会話読取りを使用。既存`open-work.md`を入力にして、生成元`open-work.mjs`のDrive照会やgit fetchは重複実行しない。登録は`ensure-run-hidden.ps1`と`resolve-synced-repo.ps1`を使用する。

## 権限と実運用検証

このセッションの書込み可能範囲は作業ディレクトリと`/tmp`のみ。`.git`およびユーザーホームは書込み不可。

- `node tools/stall-sweeper.mjs --dry-run` を実環境で実行。既定の `~/.claude/stall-sweeper-report.md` への保存は `EROFS: read-only file system`。検出結果はstdoutから回収した。
- `--dry-run --output-dir /tmp/stall-sweeper-validation` は終了コード0で実行し、報告ファイルの生成を確認した。
- `node tools/stall-sweeper.mjs --apply --max 1 --kind uncommitted` を実行。ホーム配下のロック作成で停止した。実環境のコミット・push・PR作成・通知は実施していない。
- 既知リポジトリの再確認では、開発ツリーに332ファイル、ブース制作アプリに135ファイルの変更があり、どちらも2026-09-21の新しい変更が混在。安全な実コミット対象はない。`orgiast-claude-rules` とDownloadsの同名ツリーは同じ実体として重複除外される。
- 登録スクリプトは `-ValidateOnly` で実行成功。`schtasks /query /tn OrgiastStallSweeper` は終了コード1。その後 `Get-ScheduledTask` の直接照会でも登録済み件数0を確認。**登録済みとは扱わない。**
- 実登録はユーザーホームへhidden runnerを配置し、Windowsタスクを更新する。許可範囲外なので、PowerShell経由で書込み制約を迂回していない。
- 同時進行で現れた `tools/claude-cost-reporter.mjs` と既存 `.fleet-mail-work/` の変更は本作業の対象外。変更・ステージしていない。

## 監督側の残作業（kimの手作業は依頼しない）

登録可能な監督セッションで、実装をレビュー・保存した後に以下を実行する。登録は同名タスクを更新するため冪等。

```powershell
powershell.exe -NoProfile -File C:\Users\uers\orgiast-main\tools\register-stall-sweeper.ps1
schtasks.exe /query /tn OrgiastStallSweeper
```

登録後は04:10の実行ログと報告を読戻す。初回検証で安全な未コミット対象がなければ、実コミット検証を無理に行わない。現時点で、この作業を続ける別エージェントや登録済みスケジュールはない。

## 最終検出結果とテスト

2026-09-22 10:34 JST の実環境照会。未確認の範囲は件数に含めない。

| カテゴリ | 検出件数 |
|---|---:|
| uncommitted | 2 |
| open_pr | 4 |
| stale_branch | 398 |
| open_todo | 38 |
| failed_job | 11 |
| stalled_session | 2 |
| unverified_delegation | 1 |

進行0件・自動処理失敗0件（dry-run）・human候補9件。通知は送っていない。ブース制作アプリはmain参照とoriginリモートの照会が失敗したため、ブランチとPRは未確認。Codexログ169件は委譲自体の終了コードを取得できず未確認。

CI通過済みでマージ待ちのPR（自動マージなし）:

- [PR #462: auto-session連続失敗の監視](https://github.com/kimkon1011/orgiast-claude-rules/pull/462)
- [PR #420: low_delegation改善](https://github.com/kimkon1011/orgiast-claude-rules/pull/420)
- [PR #404: keyserveのpcId不一致修正](https://github.com/kimkon1011/orgiast-claude-rules/pull/404)
- [PR #322: gpage-fetch配布](https://github.com/kimkon1011/orgiast-claude-rules/pull/322)

`node --test tools/stall-sweeper.test.mjs`: **21件成功、0件失敗**。

実git検証（隔離fixture）: /tmp/stall-sweeper-test-Ef3yB1/repo / git log -1: 9fd8ad7 停滞作業を保存: file.txt / mainとの差: 1コミット

これは一時ディレクトリ内の実Git検証であり、業務リポジトリの実コミット検証とは区別する。

完全な読取り結果: [検出stdout](/tmp/stall-sweeper-final.txt)、[テスト出力](/tmp/stall-sweeper-tests.txt)、[登録スクリプトの検証出力](/tmp/stall-sweeper-registration.txt)。
