## 実データ

| 項目 | 2026-11-25-8（成功） | 2026-11-26-8（失敗） | 2026-11-27-8（失敗） |
| --- | --- | --- | --- |
| startedAt | 2026-11-24T16:20:52.596Z | 2026-11-25T16:23:44.503Z | 2026-11-26T15:59:20.903Z |
| endedAt | 2026-11-24T16:22:33.954Z | 2026-11-25T16:25:35.844Z | 2026-11-26T15:59:45.769Z |
| 所要 | ~101s | ~111s | ~25s |
| executorUsed | cheap-code:deepseek | cheap-code:deepseek | cheap-code:deepseek |
| exitCode | 0 | 0 | 0 |
| status（JSON） | success | success | success |
| stdout | 作業サマリ本文あり（341文字相当） | `"\n"` のみ | `"\n"` のみ |
| summary / .summary.md | 487文字 / 837バイト | 空 / 0バイト | 空 / 0バイト |
| doneSkippedReason | （無し） | サマリが空（作業の痕跡が無い） | サマリが空（作業の痕跡が無い） |
| stderr の主な行 | openrouter バナー / trust（**entry 単数・1件**） / unrecognized_model | openrouter バナー / unrecognized_model（**trust 無し**） | openrouter バナー / trust（**entries 複数・114件**） / unrecognized_model |
| historyCwd | `d:\CLAUDE.md配布` | `C:\Users\kimko\gb-offload\state` | `C:\Users\kimko` |

引用（失敗日の共通形）:

- 両失敗日とも `"executorAttempts":[{"executor":"cheap-code:deepseek","status":"success"}]`（alternate / codex へのフォールバック無し）
- 両失敗日とも `"stdout":"\n"` かつ `"summary":""`
- 通知が「最新エラー」として出す trust 警告は **11/27 だけ**。11/26 は trust 無しでも同じ空振り

streak-watch の成功条件（`tools/auto-session-streak-watch.mjs` の `evaluateRun`）は `status===success && exitCode===0 && summary 非空 && summary ファイル size>0`。そのため JSON 上は success でも空サマリは連続失敗として通知される。通知本文は stderr 先頭を切るため、trust 警告が「最新エラー」に見える。

## 真因

**cheap-code:deepseek が `unrecognized_model` 付きで exit 0・stdout 空振りしたとき、当時の `auto-session.mjs` が終了コードだけで success とみなし、次レーンへ進まなかったこと。**

根拠:

1. 失敗2日はどちらも exit 0 / status success / executorAttempts が deepseek 1本だけ / stdout `"\n"` / summary 空（上記表）。
2. 実行時の `C:\Users\kimko\.claude\auto-session-repo` は PR #2880 未取り込み（`lane-incompatible.mjs` 無し）。`complete()` は概ね:
   - `status: timedOut ? 'timeout' : code === 0 ? 'success' : 'failure'`
   - フォールバック条件が `cheap && timedOut` のみ
3. 作業ツリー側の修正済み箇所（PR #2880・`tools/auto-session.mjs` 926–946 行付近）は `isLaneIncompatible` で空振りを `incompatible` にし、`(timedOut || laneIncompatible)` で alternate / codex へ進める。全レーン incompatible なら code を 1 にして `status=failure` にする。
4. 11/25 も同じ `unrecognized_model` が出ているが stdout に本文があったため「成功」になった。変化点は「モデルが空を返した」ことと、空振りを次レーンへ回せない当時コードの組み合わせ。

trust 警告は失敗の必要条件ではない（11/26 は trust 無しで同型失敗）。

## 直したこと

- PR #2880 本体（終了コード判定＋`lane-incompatible` 共有）は作業ツリーの `origin/main` に既に入っている。再実装しない。
- 追加で直した穴: `TRUST_WARNING_LINE` が `entries`（複数）専用で、実データ 11/25-8 の `entry`（単数）を残差に残し、**空 stdout + 単数 trust + unrecognized_model** だと `isLaneIncompatible` が false のままになる（実測で確認）。
  - `tools/lib/lane-incompatible.mjs`: `entr(?:y|ies)` に拡張
  - `test/lane-incompatible-auto-session-8.test.mjs`: 3日分の実 stderr で固定
  - `tools/codex-do.test.mjs`: 単数 entry の回帰ケースを追加

## 残る不明点

- **trust 警告とこの失敗の関係**: 直接原因ではない。permissions.allow が無視される環境ノイズ。ただし historyCwd が `C:/Users/kimko` になると 114 件警告が出やすく、通知文言に載って誤認を誘う。`C:\Users\kimko\.claude.json` / cheap-code-worker 設定は本タスクでは触っていない。
- **なぜ 11/25 だけ deepseek が本文を返し、11/26–27 は空だったか**: SDK 側の `unrecognized_model` 挙動・OpenRouter 側・プロンプト差のいずれか。コード側では確定できない。空振り時に次レーンへ回すのが正しい防護。
- **運用**: 失敗時点の実行リポジトリ `auto-session-repo` はまだ #2880 未取り込み。作業ツリー外のため本コミットでは更新していない。main（#2880＋本修正）が実行リポへ反映されるまで、同型の空振りは再現しうる。

## 検証（Windows 実行）

実施日時: 2026-11-27（cwd: `C:\Users\kimko\wt-auto-session-8`）

### テスト

```
$ node --test test/lane-incompatible-auto-session-8.test.mjs
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 234.4001
EXIT:0
```

```
$ node --test tools/codex-do.test.mjs
ℹ tests 310
ℹ suites 0
ℹ pass 309
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 129325.3509
EXIT:0
```

```
$ git diff --check
EXIT:0
（出力なし＝空）
```

### auto-session-repo 実状態（読むだけ）

| 項目 | 実測値 |
| --- | --- |
| ディレクトリ存在 | 有り（`C:\Users\kimko\.claude\auto-session-repo`） |
| `.git` | `gitdir: ../nightly-repo/.git/worktrees/auto-session-repo`（nightly-repo の worktree） |
| `tools/lib/lane-incompatible.mjs` | **MISSING**（作業ツリー HEAD 上に無い） |
| 現在ブランチ | `auto/20261127-stale-check-combined` |
| HEAD | `c7b44df93f1005939e4647cdb53bceb119150e54` |
| `git log --oneline -3` | `c7b44df9 Merge remote-tracking branch 'origin/main' into auto/20261127-stale-check-combined` / `aa657436 fix(next-session-rotate): ... (#2840)` / `31b165ef feat(comms-hub): ... (#2834)` |
| dirty | porcelain 13 行（未コミットの M/D あり） |
| `origin/main` tip | `6291a09df0ec97525f707639470288f670e5d93a` |
| PR #2880 (`98c374fc`) | `origin/main` の祖先ではある（`merge-base --is-ancestor` exit 0）。**現 HEAD の祖先ではない**（exit 1） |
| `origin/main:tools/lib/lane-incompatible.mjs` | 存在する（`git cat-file -e` exit 0） |

### 追従の仕組み: 結論

**有る。** 専用の「auto-session-repo だけを pull し続ける」別ジョブは無いが、夜間起動の `tools/auto-session-launcher.mjs` が pinnedTree（既定で `~/.claude/auto-session-repo`）を `origin/main` へ合わせる。

根拠（コード）:
- `planCommands()`: `fetch origin/main` →（既存なら）`detach pinned worktree` → `reset --hard origin/main` → `clean -fd`
- `main()`: dirty なら `dirty-worktree-guard` の `allowUpdate` が destructive 更新を止め、`fallbackTreePath()` の使い捨て worktree を `origin/main` から作ってそこから起動する
- `syncSharedRepo()` / `planSharedRepoSyncCommands()` は共有クローン（既定 `~/.claude/nightly-repo`）側の追従
- 実行役は別途 `tools/auto-session-executor.mjs` の `planExecutorWorktreeSync`（fetch→reset）で `origin/main` に同期

今回の実測との関係:
- pinnedTree 自体は dirty + 作業ブランチのままなので HEAD は #2880 未取り込み（`lane-incompatible.mjs` 無し）
- 設計上、dirty 時の**実行コード**は fallback tree（main）側へ逃げる想定。ディレクトリ `auto-session-repo` の作業ツリーが常に main 先端になる保証は無い
- `register-auto-session.ps1` は launcher 本体を `auto-session-repo\tools\auto-session-launcher.mjs` から起動するため、dirty で reset できない間は **launcher 自身も古い tree のコード**になりうる

### もし pinnedTree 自体も常に main へ戻したい場合の具体案

現状「実行は fallback で新しいコード」「ディレクトリは dirty のまま」なので、**ディレクトリ自体の自動追従は実質止まっている**。足すなら:

1. `tools/auto-session-launcher.mjs` の `main()` で、fallback 起動に成功したあとに pinnedTree を再同期する処理を追加する（例: `rescueAndResyncPinnedTree()`）。中身は既存の `planCommands({ treeExists: true })` と同じ detach→reset→clean を、dirty を rescue/stash したあとに再実行する。
2. dirty 検出は既存の `createDirtyWorktreeGuard`（`tools/dirty-worktree-guard.mjs` の `allowUpdate`）を流用し、破壊的更新の前にだけ一時退避する分岐を `LOCAL_STATE_LABELS` 処理の直前に置く。
3. 監視: `tools/auto-session-streak-watch.mjs` か launcher boot log に「pinnedTree HEAD ≠ origin/main」を出す行を足すと、今回のような未取り込みを早期検知できる。

（本セッションでは作業ツリー外のため auto-session-repo は変更していない。）
