# ルール・スキル追加の Codex 委譲手順

## 目的

`CLAUDE.md` へのルール追加や `skills/` へのスキル追加を kim に手作業で依頼せず、Codex（`tools/codex-do.mjs`）へ委譲し、PR 作成・マージ・配布まで自動化するための標準手順。

## 手順

1. `main` から `auto/<日付>-<スラグ>` ブランチを作成する。
2. 指示をファイルへ書き、次の形式で Codex に委譲する。指示を argv へ直接渡してはならない。
   ```bash
   node tools/codex-do.mjs --prompt-file <指示> --cwd <リポジトリ> --timeout 600
   ```
3. 監督が diff をレビューし、`node --test tools/*.test.mjs` が green になることを確認する。
4. 自分が作成したファイルだけをパス指定で `git add` し、commit・push する。
5. PR 作成後、次を実行する。`gh pr merge` の直接実行は classifier に deny されるため使わない。
   ```bash
   gh pr edit <N> --add-label automerge
   ```
6. `gh pr view <N> --json state` で `MERGED` になるまで確認する。`enable-auto-merge` ジョブの pass は、マージ済みを意味しない。
7. `main` へのマージを全 PC への配布トリガとする（§3.0 自動取込）。他 PC への反映は、各 PC の同期を直接確認するまで「未確認」と書く。

## 注意点

- 共有ツリーでは `git add -A` を使わない。
- 着手前と commit 直前に `git status --porcelain` を取得する。
- ファイルを追加するだけの変更なら、テストは既存テストが green であることの確認のみでよい。
