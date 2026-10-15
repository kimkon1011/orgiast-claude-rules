# 作業指示: kim-PC で正本の onboarding-sync を再実行し、結果を報告する

ファイル編集・git 操作は一切しない。コマンド実行と出力の報告だけ行う。

## 背景
- 直前に旧版 `C:\Users\uers\orgiast-main\tools\onboarding-sync.mjs`（rescue ブランチ・241 コミット遅れ）が `--force` で走り、`C:\Users\uers\.claude\CLAUDE.md` の管理ブロックから `@~/.claude/shared-memory/MEMORY.md` の参照行が消えた。
- kim-PC の正本は `C:\Users\uers\.claude\nightly-repo`（SessionStart hook が参照）。こちらの `tools/memory-share.mjs` は新配信口 `orgiast-memoryserve.vercel.app` を使う。

## 実行する手順（順番どおり・それぞれ1コマンド）
1. `node "C:\Users\uers\.claude\nightly-repo\tools\onboarding-sync.mjs" --force` を実行し、標準出力・標準エラーを全文そのまま記録する。
2. `C:\Users\uers\.claude\hooks\onboarding-sync.log` を読み、`memory-share install` を含む行のうち末尾 3 行を記録する。
3. `C:\Users\uers\.claude\shared-memory\` ディレクトリの存在と、直下の `.md` ファイル数を記録する（無ければ「存在しない」と書く）。
4. `C:\Users\uers\.claude\CLAUDE.md` に `shared-memory/MEMORY.md` を含む行があるか、行番号付きで記録する（無ければ「該当なし」）。

## 禁止
- HTTP エラー（401 / 404 / 502 / 503）が出ても、言い換え・再試行をしない。コードをそのまま記録する。
- ファイルの作成・編集・削除、git commit/push、settings.json の変更をしない。

## 出力形式
日本語で、手順 1〜4 の生出力をコードブロックで列挙し、最後に 3 行以内の所見を書く。
