# rescue ブランチ レビュー棚卸し

`node tools/rescue-review-scan.mjs --repo . --main origin/main` の実出力に基づく記録。
rescue 退避は「dirty な作業ツリーを保全する」仕組みなので、内容が後から PR / main に取り込まれても
`next-session.md` の「レビューが必要」TODO は自動では消えない。本スキャナは
**three-dot diff（枝自身の変更のみ）の指紋**で分類し、人間が実際に見るべき枝だけを残す。

| status | 意味 |
|---|---|
| `covered` | main に取り込み済み（枝自身の差分が空） |
| `duplicate` | 他の rescue 枝と同じ変更 |
| `covered-by-branch` | 別名の枝（`feat/*` `fix/*` `auto/*` 等）に同一変更が保全済み |
| `ignored-only` | 差分がすべて `.gitignore` 済みの実行時成果物（例: `.stall-sweeper/`）。レビュー不要 |
| `covered-in-main` | 追加行の 80% 以上が main にあり、削除行の main 残存が 20% 以下＝実質取り込み済み |
| `unique` | どれにも当てはまらない＝人間がレビューすべき枝 |

## 2026-10-18 rescue/auto-session-20261015-042503 のレビュー結果

- 枝の差分は `.stall-sweeper/71f277df19da2eb45c0b-1792005522744.evidence.md` 1ファイル30行のみで、コード変更なし。
- `executor-usage.jsonl` の `2026-10-14T18:13:50.071Z` は codex が `exitCode 3` / `launched:false` / `stderrTail:"WSL ディストリが見つかりませんでした"`。ファイル変更は発生していない。
- `.stall-sweeper/` は #831（2026-10-16T18:16Z）で gitignore 済み。本枝はそれ以前の救済なので混入した。
- 結論: main へ取り込む変更は無く、マージ不要。同型の枝は 20261015-042601 / 043201 / 20261016-041401 / 041502 / 041601。
- 新しい `ignored-only` 判定でこれらはレビュー対象から外れる。

## 2026-10-19 時点の結果

- 対象: `refs/heads/rescue/*` 22 本（`--include-remote` なし）
- `unique: 5 / duplicate: 0 / covered: 12 / covered-by-branch: 2 / covered-in-main: 3 / error: 0 / ignored-only: 0`

前回（10-18）との差分は 1 本のみ:

| branch | status | 内容 |
|---|---|---|
| `rescue/auto-session-20261019-032606` | `covered`（already-upstream） | `tools/autopilot-tick.mjs`(+test) 57+/0-。`git cherry` が全行 `-` で、同内容は main 取り込み済み |

- `unique` 5 本・`covered-by-branch` 2 本・`covered-in-main` 3 本の顔ぶれは 10-18 から不変（詳細は下の 10-18 節）。新しいレビュー対象は発生していない。

### 定期実行レールの実測（2026-10-19）

| 経路 | 実測 |
|---|---|
| nightly-bootstrap（2分間隔） | `2026-10-19 18:02:39 / リポ同期 / ok:origin/main 7ce8e45`、`18:03:25 / 対象実行 / ok:fleet-mail.mjs 終了コード=0` |
| anchor の状態 | detached HEAD = `origin/main` = `7ce8e45`、`git status` clean。bootstrap は `checkout --detach origin/main` で同期する設計（`tools/nightly-bootstrap.ps1:173`） |
| setup --converge | `node tools/setup.mjs --converge` → **EXIT=0**、`classifier-settings [OK]`（hook 登録・allow ルール同期）。`SessionStart` に `setup.mjs --converge` 登録済み（`~/.claude/settings.json`） |
| 残 NG | `cmd:claude` / `env:cerebras` / `task:fleet-mail-watchdog` の 3 件。10-16 時点と同じ既存項目で、EXIT=0 のため収束判定に影響しない（本棚卸しとは無関係） |

### リモート含む棚卸し（`--include-remote`、2026-10-19）

- 対象: local + `refs/remotes/origin/rescue/*` の 72 refs
- `unique: 30 / duplicate: 4 / covered: 16 / covered-by-branch: 2 / covered-in-main: 11 / error: 0 / ignored-only: 9`
- 前回（10-18）の `error: 6` はすべて `origin/rescue/sync-orgiast-main-*` の `spawnSync git ENOBUFS` だったが、#860（256MB 上限）が main に取り込まれたため **error は 0**。当該 6 本は大きな差分を持つ `unique` として分類された（例: `20261010-110502` は 298 files 865,757+/317-）。
- `ignored-only` 9 本は差分が `.stall-sweeper/`（gitignore 済み）のみの枝。新判定でレビュー対象から外れた。
- 内訳: `unique` 30 本 = `sync-orgiast-main-*` 6 本 + その他 24 本。origin-only の unique は 28 本（`rescue/auto-session-20261013-072202` 〜 `20261018-072203`、ローカルに降ろしていない古い退避）。

## 2026-10-18 時点の結果

- 対象: `refs/heads/rescue/*` 21 本（`--include-remote` なし）
- `unique: 5 / duplicate: 0 / covered: 11 / covered-by-branch: 2 / covered-in-main: 3 / error: 0`

covered-by-branch（2026-10-16 から変化なし）:

| branch | coveredBy | 内容 |
|---|---|---|
| `rescue/auto-session-20261010-073803` | `fix/lane-guard-autopilot-tick` | `tools/pretooluse-lane-guard.mjs` 1+/1- |
| `rescue/auto-session-20261010-203202` | `fix/codex-do-curly-apostrophe-usage-limit` | `tools/codex-do.mjs` 18+/4- |

covered-in-main（main に 80% 以上取り込み済み。独立レビュー不要）:

| branch | 変更 | 取り込み状況 |
|---|---|---|
| `rescue/auto-session-20261010-221204` | `tools/feedback-apps.json` `tools/feedback-zero-registry.json` 68+/6- | added 64/68・deleted は main に残存なし |
| `rescue/auto-session-20261011-220002` | `tools/feedback-zero-registry.json` 67+/6- | added 64/67・deleted 1/6 が main に残る |
| `rescue/auto-session-20261017-082104` | 3 files 73+/17- | added 71/71・deleted 3/17 が main に残る |

残った unique 5 本:

| branch | 変更 | 備考 |
|---|---|---|
| `rescue/auto-session-20261011-160002` | `tools/feedback-zero-registry.json`（2+/1-） | `20261010-221204`（covered-in-main）の部分集合。単独では取り込む価値なし |
| `rescue/auto-session-20261016-041803` | `.stall-sweeper/*.json` 7 files + `tools/autopilot-run.mjs`(+test) `tools/autopilot-tick.mjs`（638+/14-） | **`.stall-sweeper/` の実行時成果物が混入**。PR 化時は除外する |
| `rescue/auto-session-20261017-082212` | `skills/autopilot/SKILL.md` `tools/autopilot-run.test.mjs` `tools/autopilot-tick.mjs`(+test)（152+/19-） | autopilot-tick の見張り強化。main 未取り込み |
| `rescue/auto-session-20261017-182603` | `tools/autopilot-run.mjs`（26+/3-） | `resolveSupervisorAuth`（OAuth が空なら `~/.claude/deepseek.env` の鍵へ切替） |
| `rescue/auto-session-20261017-182805` | `tools/autopilot-run.mjs`(+test)（62+/7-） | `182603` の上に積み増し（同一ファイル）。**`182603` と併せて1本でレビュー** |

### リモート含む棚卸し（`--include-remote`、2026-10-18）

- 対象: `refs/remotes/origin/rescue/*` を含む 70 refs
- `unique: 33 / duplicate: 4 / covered: 14 / covered-by-branch: 2 / covered-in-main: 11 / error: 6`
- **同名列の local/origin は別 ref として数える**ため、上の local のみの件数とは単純比較できない。
- ローカル枝を持たない origin-only の unique は **28 本**（`rescue/auto-session-20261013-072202` 〜 `20261018-072203`）。古い auto-session の退避がローカルに降りてこないまま origin に残っているもの。
- `error: 6` はすべて `origin/rescue/sync-orgiast-main-*` の `spawnSync git ENOBUFS`（1MB 超の差分）。**変更なしの証拠ではない**。修正は `auto/20261018-rescue-scan-enobufs`（`a8fff3f`、main 未取り込み）で進行中。


## 2026-10-16 時点の結果（`covered-by-branch` 実装後）

- 対象: `refs/heads/rescue/*` 16 本
- `unique: 4 / duplicate: 0 / covered: 10 / covered-by-branch: 2 / error: 0`

covered-by-branch（＝独立レビュー不要。同一変更が別名の枝に保全されている）:

| branch | coveredBy | 内容 |
|---|---|---|
| `rescue/auto-session-20261010-073803` | `fix/lane-guard-autopilot-tick` | `tools/pretooluse-lane-guard.mjs` 1+/1-（同一コミット `b824392`） |
| `rescue/auto-session-20261010-203202` | `fix/codex-do-curly-apostrophe-usage-limit` | `tools/codex-do.mjs` 18+/4-（同一コミット `1117f3b`） |

残った unique 4 本:

| branch | 変更 | 備考 |
|---|---|---|
| `rescue/auto-session-20261010-221204` | `tools/feedback-apps.json` `tools/feedback-zero-registry.json`（68+/6-） | 倉庫アプリ登録。PR #763 系の先行版 |
| `rescue/auto-session-20261011-160002` | `tools/feedback-zero-registry.json`（2+/1-） | 上記の部分集合 |
| `rescue/auto-session-20261011-220002` | `tools/feedback-zero-registry.json`（67+/6-） | 上記の別版 |
| `rescue/auto-session-20261016-041803` | `.stall-sweeper/*.json` `tools/autopilot-run.mjs` `tools/autopilot-tick.mjs`（638+/14-） | **`.stall-sweeper/` の実行時成果物が混入**。実装本体（autopilot-run / autopilot-tick）と混ざっているので、PR 化時は `.stall-sweeper/` を除外する |

## 2026-10-15 時点の結果

- 対象: `refs/heads/rescue/*` 21 本
- `unique: 19 / duplicate: 2 / covered: 0 / error: 0`

duplicate と判定された枝（＝レビュー不要。内容は canonical 側と同一）:

| branch | duplicateOf | 内容 |
|---|---|---|
| `rescue/auto-session-20261013-103002` | `rescue/auto-session-20261013-100002` | 倉庫アプリの feedback 台帳登録（68+/6-） |
| `rescue/auto-session-20261013-163002` | `rescue/auto-session-20261013-100002` | 同上（同一内容） |

上記 3 枝の変更は **PR #763（`feat(feedback): 倉庫アプリを不具合・要望フォームの台帳と zero 監視に登録`）と
byte 一致**であることを実測で確認済み（`git diff <rescue-tip> <pr763-head> -- tools/feedback-apps.json tools/feedback-zero-registry.json` が空）。
したがって 2026-10-13 の rescue レビュー TODO 2 件は「PR #763 が担当済み＝独立レビュー対象なし」で消化できる。

## `covered-by-branch` 拡張（2026-10-16 実装）

2026-10-15 時点では `unique` が「他の rescue 枝と同一ではない」ことしか意味せず、内容が
別名の枝（`fix/*` `feat/*` 等）に既に保全されている枝までレビュー対象に残っていた。
そこで **照合先 ref（既定: `refs/heads/` と `refs/remotes/origin/`、`rescue/*` は除外）の
three-dot 差分指紋**と突き合わせ、一致した rescue 枝を `covered-by-branch`（`coveredBy` 付き）
に落とす。ネットワークアクセスも書き込みもしない（`git diff` / `for-each-ref` の読み取りのみ）。

- 実装: `tools/rescue-review-scan.mjs`（`compareRefs` オプション。CLI は `--compare-refs <pattern>` / `--no-compare-refs`）
- 回帰テスト: `tools/rescue-review-scan.test.mjs`（10 本、照合先の git 失敗を握りつぶす経路を含む）

## 再実行方法

```
node tools/rescue-review-scan.mjs --repo <repo> --main origin/main                  # 人間向け
node tools/rescue-review-scan.mjs --repo <repo> --main origin/main --json           # 機械向け
node tools/rescue-review-scan.mjs --repo <repo> --main origin/main --no-compare-refs  # 別名枝との照合を切る
node tools/rescue-review-scan.mjs --repo <repo> --main origin/main --include-remote # origin 側だけの rescue 枝も含める
```
