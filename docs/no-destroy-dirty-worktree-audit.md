# 無人Git更新のデータ保護監査（2026-09-22）

対象: `C:/Users/uers/orgiast-main/tools` および `C:/Users/uers/orgiast-claude-rules/tools`。
`rg` で reset / clean / checkout / restore / stash と worktree remove を検索し、実行箇所・コメント・テスト・非Git用途を区別した。
以下の「修正後」はこのPRのソース行。「配布側」は orgiast-claude-rules の監査時点の行であり、まだ更新していない。

| 修正後のファイル:行 | 配布側の行 | 操作・対象ディレクトリ | 保護・判定 |
|---|---|---|---|
| [auto-session-launcher.mjs:25](../tools/auto-session-launcher.mjs#L25) | 25 | sharedRepo: checkout --detach | 直前status、dirty時救済・その実行中は更新禁止 |
| [auto-session-launcher.mjs:26](../tools/auto-session-launcher.mjs#L26) | 26 | sharedRepo: reset --hard | 同上 |
| [auto-session-launcher.mjs:27](../tools/auto-session-launcher.mjs#L27) | 27 | sharedRepo: clean -fd | 同上 |
| [auto-session-launcher.mjs:48](../tools/auto-session-launcher.mjs#L48) | 48 | pinnedTree: checkout --detach | 同上、別fallbackから起動 |
| [auto-session-launcher.mjs:49](../tools/auto-session-launcher.mjs#L49) | 49 | pinnedTree: reset --hard | 同上 |
| [auto-session-launcher.mjs:50](../tools/auto-session-launcher.mjs#L50) | 50 | pinnedTree: clean -fd | 同上 |
| [auto-session-launcher.mjs:98](../tools/auto-session-launcher.mjs#L98) | 97 | 3日超のfallback: worktree remove | dirty時救済・削除禁止。--forceも除去 |
| [nightly-bootstrap.ps1:163](../tools/nightly-bootstrap.ps1#L163) | 新規 | nightly-repo / ORGIAST_NIGHTLY_REPO: checkout --detach | 直前status、dirty時救済・更新禁止。ブランチrefをresetしないためdetachを追加 |
| [nightly-bootstrap.ps1:166](../tools/nightly-bootstrap.ps1#L166) | 120 | 同上: reset --hard | 同上 |
| [nightly-bootstrap.ps1:169](../tools/nightly-bootstrap.ps1#L169) | 122 | 同上: clean -qfd | 同上 |
| [hook-tree-selfheal.mjs:175](../tools/hook-tree-selfheal.mjs#L175) | 169 | settings.json内のhook実体ツリー: ファイルcheckout | ツリー全体がdirtyなら救済し更新禁止。各checkout直前も確認 |
| [hook-tree-selfheal.mjs:229](../tools/hook-tree-selfheal.mjs#L229) | 215 | 同上: checkout --detach origin/main | 同上 |
| [hook-tree-selfheal.mjs:233](../tools/hook-tree-selfheal.mjs#L233) | 218 | 同上: 構文異常時のcheckout --detach旧HEAD | 同上 |
| [hook-tree-selfheal.mjs:237](../tools/hook-tree-selfheal.mjs#L237) | 222 | 同上: 例外時のcheckout --detach旧HEAD | 同上 |
| [session-repo-sync.mjs:111](../tools/session-repo-sync.mjs#L111) | 107 | auto-session-tree / SESSION_REPO_SYNC_TARGET: SHA checkout | 既存のdirtyスキップに救済を追加、fetch後のcheckout直前にも再確認 |
| [cost-improve-loop.mjs:989](../tools/cost-improve-loop.mjs#L989) | 989 | os.tmpdir()/orgiast-cost-improve-PID-time-random: checkout -b | 対象外。新規専用ツリーのブランチ作成。既存ファイルを巻き戻さない |
| [cost-improve-loop.mjs:1007](../tools/cost-improve-loop.mjs#L1007) | 1007 | 同じ専用一時ツリー: worktree remove --force | 対象外。実行ごとに新規ランダムパスを生成し、その修理用ツリーのみ破棄する既存仕様 |
| [nightly-health-remediate.mjs:174](../tools/nightly-health-remediate.mjs#L174) | 174 | ~/.claude/remediate-worktrees/slug-date: worktree remove --force | 対象外。修理専用ツリーのみ。人の作業リポジトリを削除対象に指定する経路はない |

`worktree add --detach` は新規ツリー作成であり既存ツリーのcheckoutではない。実行する `git stash` / `git restore` / `git checkout -- .` は両対象とも無し。auto-session.mjs の一致は作業指示内の禁止例。power-save/restore-claude-from-drive等のrestoreは非Git用途。テストfixture内のGit操作は隔離された一時リポジトリのみ。

## 仕様

- sharedRepoの既定は `~/.claude/nightly-repo`。不存在ならclone。人の作業リポジトリは `ORGIAST_REPO` による明示指定時だけ対象となる。
- status失敗も更新禁止。dirtyを検出したディレクトリは、救済後にcleanになっても同じ呼び出しでは更新しない。
- `rescue/auto-session-YYYYMMDD-HHmmss` を作り、救済実装内だけで `git add -A`、commit、push。名前が衝突したら連番を付ける。push失敗でもローカルcommitは保持する。
- commit失敗時もreset/clean/stashによる巻き戻しをしない。レビューTODOは `.claude/next-session.md` に追記する。追記失敗は専用マーカーをログに残す。
- 各操作直前のstatus確認は、確認直後に他プロセスが書き込む競合まで原子的に防ぐものではない。既定の専用クローン化で共有作業ツリーを対象から外す。

## 検証

`node --test` の関連8ファイルで **78 pass / 0 fail / 0 skip**（リポジトリ全体のテスト件数ではない）。

- dirty-worktree-guard / auto-session-launcher / hook-tree-selfheal / session-repo-sync / no-undistributed-imports: 47件。
- nightly-bootstrap: 24件。Windows PowerShellとWindows Gitを実際に使用し、dirty時のcheckout/reset/cleanが呼ばれないこと、未追跡ファイル残存、救済commitのremoteからの復元、clean時の更新を確認。
- repo-self-resolve / register-nightly-tools: 7件。
- JSでも一時Gitリポジトリでshared/pinned両方を検証。push失敗・commit失敗・status失敗、操作間に発生した新たな編集、古いdirty fallbackの削除回避を確認。

## 反映範囲

このPRは未マージ。配布側 `C:/Users/uers/orgiast-claude-rules` と設置済みの `~/.claude/tools/nightly-bootstrap.ps1` は変更していない。mainを読む夜間実行に反映済みとは扱わない。PRのマージと配布後に実行ログの新マーカー・実行版を確認する必要がある。
