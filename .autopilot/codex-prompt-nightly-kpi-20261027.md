# Codex 指示書: OrgiastNightlyKpi 夜間バッチ失敗調査（第2周: パッチの PR 化と stderr 採取）

## 目的
OrgiastNightlyKpi（タスクスケジューラの夜間バッチ）が毎日 exit 0 なのに内部で 6 処理 13 件が失敗している。真因を特定し、再発防止パッチを PR にする。

## 完了条件
- 失敗している各処理の真因が記録され、診断ログを保持する修正が PR として open になっている
- 最多失敗の feedback-zero-sweep の Issue 照会（gh issue list 相当）について、実際の stderr / exit code が採取されている

## 対象 cwd
C:\Users\uers\.claude\nightly-repo
（HEAD は feat/pc-hardware-spec。**この共有ツリーの index・作業ツリーは触らない**。作業は必ず新しい worktree で行う）

## 直近成果（前周）
- 4 日分の夜間ログを調査。プロセスは毎日 exit 0 だが内部で 6 処理 13 件の失敗。最多は feedback-zero-sweep の Issue 照会が 4 日連続失敗、stderr 未記録で原因未確認
- Codex が「診断ログ保持」の修正を作業コピー `.wt/nightly-kpi-investigate-20261026` にコミット済み（commit ad363df）。テスト 60 件 pass
- ただしその作業コピーは WSL 側で作られたため、`.wt/nightly-kpi-investigate-20261026/.git/objects/info/alternates` が `/mnt/c/Users/uers/.claude/nightly-repo/./.git/objects` という WSL パスになっており、Windows の git からは親コミットが読めない（`git log` が "unable to normalize alternate object path" で失敗する）

## 今回の 1 施策（この順で実行）
1. `.wt/nightly-kpi-investigate-20261026/.git/objects/info/alternates` の内容を Windows パス `C:/Users/uers/.claude/nightly-repo/.git/objects` に書き換え、`git -C <その作業コピー> log --oneline -3 --stat` で ad363df とその親が読めることを確認する。読めなければ `git -C <作業コピー> show ad363df` の差分を `git format-patch` 相当で取り出す。
2. `git -C C:\Users\uers\.claude\nightly-repo fetch origin main` のうえ、`git -C C:\Users\uers\.claude\nightly-repo worktree add .wt\nightly-kpi-pr-20261027 -b fix/nightly-kpi-diag-log-20261027 origin/main` で新 worktree を作る。
3. 新 worktree に ad363df を cherry-pick する（直接 cherry-pick できなければ、手順 1 で取り出した差分を apply して同内容でコミットする）。コミットメッセージは日本語で、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` を付ける。
4. 新 worktree でその修正に関係するテストを実行し、pass を確認する（前周は 60 件 pass）。
5. `git push -u origin fix/nightly-kpi-diag-log-20261027` のあと `gh pr create` で PR を作る。タイトル・本文は日本語。本文に「真因（分かっている範囲）／変更点／テスト結果」を書き、末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)` を付ける。**main への直接 push・force push は禁止。マージはしない。**
6. nightly-repo 内で feedback-zero-sweep が Issue 照会に使っているコマンド（`gh issue list` 等。`grep -rn "feedback-zero-sweep"` と `grep -rn "gh issue list"` で特定）を、**読み取りだけ**で同じ引数・同じ環境で 1 回実行し、stdout 先頭 20 行・stderr 全文・exit code を記録する。gh の認証状態（`gh auth status`）も記録する。書き込み系の gh コマンドは実行しない。
7. 結果ファイルを `C:\Users\uers\.claude\nightly-repo\.autopilot\codex-result-nightly-kpi-20261027.md` に UTF-8（BOM なし）で書く。見出しは必ず次の 5 つ: `## 真因` / `## PR` （URL）/ `## テスト結果` / `## stderr 採取結果` / `## 未完了・次の 1 手`。

## 検証方法（監督側で行う read-back）
- 結果ファイルの `## PR` に `https://github.com/.../pull/<番号>` があり、`gh pr view <番号> --json state` が OPEN
- `## テスト結果` に実行コマンドと pass 件数
- `## stderr 採取結果` に exit code と stderr 本文（空なら「空」と明記）

## 禁止事項
- nightly-repo 本体（共有ツリー）の `git checkout` / `git reset` / index 変更
- main への直接 push、force push、PR のマージ
- 書き込み系の gh コマンド（issue 作成・クローズ・コメント）
- 秘密情報（トークン等）を結果ファイルに書くこと
