# 指示: feedback-apps.json にブース制作アプリの repo を登録し、夜間 feedback-zero-sweep の毎晩 error を解消する

## 目的（autopilot objective）
夜間バッチ（tools/nightly-batch.ps1）で毎晩 `feedback-zero-sweep / error:終了コード1` になるのを恒久解消する。

## 完了条件
- `node tools/feedback-zero-sweep.mjs --dry-run` の JSON で `unknown` が 0、`rows[appName=ブース制作アプリ].errors` が空、終了コードが 0。
- 追加した回帰テストを含め `node --test tools/feedback-zero-sweep.test.mjs tools/feedback-to-issues.test.mjs`（存在するもの）が pass。
- origin/main 向けの PR が作成され、`automerge` ラベルが付いている。

## 対象 cwd
`C:\Users\uers\AppData\Local\Temp\sweep-verify-913`（origin/main を detached で checkout 済みの git worktree。共有ツリー `~/.claude/nightly-repo` は触らない）

## 直近成果と調査結果（監督が確認済み・再調査不要）
- PR #913（exit コード判定の関数化）はマージ済み（origin/main b9e3344）。ただしこれは真因ではなかった。
- 真因: `tools/feedback-zero-sweep.mjs` は行の errors が非空だと `unknown` に数え exit 1 にする。実データの dry-run で `ブース制作アプリ` の行に `反映先 repo 参照キー未設定` が 3 件入り `unknown: 1` → exit 1。
- repo は `resolveRef(entry.refs.repo, env) || repoMap[entry.appName]` で解決される。`BOOTH_FEEDBACK_REPO` は env に無く、`tools/feedback-apps.json` にも `ブース制作アプリ` が無い。
- ブース制作アプリの git remote origin は `https://github.com/kimkon1011/booth-production-app.git` → repo 名は `kimkon1011/booth-production-app`。
- `tools/feedback-form-gate.mjs` が定める正規手順: 「`tools/feedback-apps.json` に `"<アプリ名>": "<owner>/<repo>"` を 1 行足す PR を正本ブランチ + automerge ラベルで出す」。
- `tools/feedback-to-issues.mjs` は `DEDICATED_PIPELINE_APPS` でブースを repo 解決より前にスキップするので、json 追加で Issue 二重化は起きない（既存テストで確認すること）。

## 今回の1施策（これだけ行う）
1. `git -C <cwd> fetch origin main` → `git checkout -b fix/feedback-apps-booth-repo origin/main`。
2. `tools/feedback-apps.json` に `"ブース制作アプリ": "kimkon1011/booth-production-app"` を追加（既存順序の末尾でよい。JSON は UTF-8・BOM なし・末尾改行あり）。
3. 回帰テストを追加: `tools/feedback-zero-registry.json` の全 `apps[].appName` が `loadFeedbackApps()` の結果に含まれることを検証するテストを `tools/feedback-zero-sweep.test.mjs` に追加する（既存テストのスタイルに合わせる）。
4. `tools/feedback-to-issues.test.mjs` 等でブースが「専用経路でスキップ」のままであることを確認（既存テストが無ければ 1 件追加）。
5. コミット（日本語・末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`）、`git push -u origin fix/feedback-apps-booth-repo`、`gh pr create --base main --label automerge` でタイトル `fix(feedback-apps): ブース制作アプリの repo を登録し夜間 sweep の毎晩 error を解消` の PR を作る。本文は原因・変更・検証結果を書き、末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
6. 最後に stdout へ `PR_URL=<url>` を 1 行出す。

## 検証方法（Codex 自身が実行して結果を報告すること）
- `node --test tools/feedback-zero-sweep.test.mjs`（および feedback-to-issues のテストがあればそれも）→ 全 pass。
- `node tools/feedback-zero-sweep.mjs --dry-run; echo EXIT=$?` → `unknown: 0`、ブース行の errors 空、`EXIT=0`。dry-run は副作用なし。**通常実行（--dry-run なし）は絶対に行わない**（Issue 作成と Codex 起動が走る）。
- 変更ファイルは `tools/feedback-apps.json` とテストファイルのみ。他は触らない。

## 禁止
- `~/.claude/*.env` の読み書き、レジストリ JSON の変更、sweep 本体ロジックの変更、通常実行（非 dry-run）。
- 共有ツリー `C:\Users\uers\.claude\nightly-repo` での checkout / commit。
