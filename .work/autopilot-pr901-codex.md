# 指示: PR#901 を main に追従させ、CI 失敗（clean-install）を直し、全チェック緑でマージする

## 目的（autopilot の objective）
PR#901「fix(auto-progress): 自動進行の結果を持ち主へDM＋セッション内表示し、最終成果まで進める」をレビュー・修正・マージする。
リポジトリ: GitHub `kimkon1011/orgiast-claude-rules`、PR ブランチ `auto/20261019-auto-progress-owner-visible`、base `main`。
PR URL: https://github.com/kimkon1011/orgiast-claude-rules/pull/901

## 完了条件
1. PR ブランチが `origin/main` の最新に追従している（現在 ahead 1 / behind 11 / diverged）。
2. CI の `Clean Windows install`（job: clean-install）が成功する。他の既存チェック（CI/test, test, test-posix, Auto merge/enable-auto-merge）も成功のまま。
3. PR 本文の変更内容（12 ファイル）をレビューし、明らかなバグがあれば同じブランチで修正する。
4. 全チェック緑を確認してから、`tools/pr-merge.mjs` でマージする（直接 `gh pr merge` は使わない。`tools/pr-merge.mjs --help` か先頭コメントで使い方を確認する）。auto-merge が既に有効（`gh pr view 901 --json autoMergeRequest`）で CI 緑後に自動マージされた場合はそれでよい。
5. 最後に **標準出力の最終行** に次の JSON を1行で出す:
   `{"result":"merged|pushed_waiting_ci|blocked","headSha":"<sha>","ciClean":true|false,"fixSummary":"<何を直したか1行>","notes":"<残課題や未確認事項>"}`

## 対象 cwd と作業場所の制約
- 指定 cwd は `C:\Users\uers\.claude\nightly-repo`（このリポジトリの clone）。**現在 `rescue/auto-session-20261020-070844` ブランチがチェックアウトされており、作業ツリーをいじってはいけない。ブランチも切り替えない。**
- 必ず `git -C "C:\Users\uers\.claude\nightly-repo" fetch origin` の後、`git -C "C:\Users\uers\.claude\nightly-repo" worktree add "C:\Users\uers\.claude\nightly-repo\.work\wt-pr901" origin/auto/20261019-auto-progress-owner-visible` のように **worktree を `.work/wt-pr901` に作って**そこで作業する（`.work/` は untracked）。作業後、worktree は残してよい。
- Bash 規約: `cd X && ...` 連結禁止。絶対パスか `git -C` を使う。1コマンド1呼び出し。

## 直近成果（Claude 側で確認済みの事実）
- PR の変更ファイル: ONBOARDING.md, tools/auto-progress-digest.mjs, tools/auto-progress-inbox-hook.mjs(+test), tools/auto-progress-ledger.mjs, tools/auto-progress-watch.mjs, tools/auto-progress.test.mjs, tools/notify-owner.mjs(+test), tools/register-auto-progress-task.ps1, tools/register-hooks.mjs, tools/setup-manifest.json。コミットは 1 つ（e549a22a）。
- CI の失敗ジョブ: https://github.com/kimkon1011/orgiast-claude-rules/actions/runs/39261896418/job/118091412729
- 失敗ログ全文はローカルに保存済み: `C:\Users\uers\.claude\projects\C--Users-uers--claude-nightly-repo\efbb0758-c04f-4da4-9c4a-3998c7feaca9\tool-results\bbd6hj0hp.txt`
  - 行 110〜: bootstrap.ps1 ステップ（成功）
  - 行 209〜: `setup.mjs --converge` ステップ（成功）
  - 行 309〜: `ORGIAST_REPO` / `ORGIAST_HOME` 環境変数を除去するステップ
  - 行 527〜626: 最後の `setup.mjs` ステップで `setup.mjs failed with exit code 1`。**この 540〜626 行の間に setup.mjs 自体のエラー出力があるはずなので、まずそこを読む。**
- main 側の clean-install は 2026-10-17 の 2 回とも成功しているので、失敗の原因は PR の差分（おそらく `tools/setup-manifest.json` への 3 行追加、`tools/register-hooks.mjs` への 1 行追加、または新規 `tools/auto-progress-inbox-hook.mjs`）か、main との乖離（behind 11）にある可能性が高い。
- ワークフロー定義は `.github/workflows/` 配下（`Clean Windows install`）。最後の setup.mjs ステップが何を引数に実行しているか確認し、worktree 内でローカル再現すること（HOME を一時ディレクトリに向けるなど、ワークフローと同じ条件で）。

## 今回の1施策（やること・順番）
1. 失敗ログの 540〜626 行を読み、setup.mjs のエラーメッセージを特定する。
2. worktree を作り、`origin/main` を PR ブランチへ merge（`git merge origin/main`。conflict があれば PR の意図を保って解決。rebase/force push はしない）。
3. ワークフローの最終 setup.mjs ステップをローカルで再現し、失敗を再現 → 修正。修正は原因に対する最小限のものにし、既存テスト（`node --test tools/`相当。package.json の test スクリプトを確認）を全部通す。
4. PR 本文の「変更」節に沿って 12 ファイルの diff をレビュー。致命的なバグ（例外で落ちる、パス解決ミス、通知の宛先が常に kim になる等）があれば同ブランチで直す。小さな好みの差は直さない。
5. コミット（メッセージ末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`）し、`git -C <worktree> push origin HEAD:auto/20261019-auto-progress-owner-visible`（force 禁止）。
6. `gh pr checks 901 --repo kimkon1011/orgiast-claude-rules --watch` 相当で CI 完了を待つ（最大 20 分）。全部緑なら `tools/pr-merge.mjs` でマージ（auto-merge で既にマージ済みならそれで可）。赤ならログを読んでもう1回だけ修正を試み、それでもだめなら `result: "blocked"` で理由を書く。

## 検証方法
- ローカル: ワークフローと同じ手順で `setup.mjs` が exit 0 になること、`node --test` が全 PASS であること。
- リモート: `gh pr view 901 --json state,mergeStateStatus,statusCheckRollup` で全 conclusion が SUCCESS、state が MERGED になること。
- 最終行に上記 JSON を必ず出す。

## 禁止
- `--force` push、`gh pr merge` 直叩き、main への直接 push、nightly-repo 本体の作業ツリー・ブランチの変更、Discord/DM 送信、settings.json の直接編集。
