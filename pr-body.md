## 修正内容

`tools/onboarding-sync.mjs` が「コミットが1つも無い空の git リポジトリ」を持つ配備コピーで同期を毎回スキップする不具合を修正しました。

### 真因（ログ引用）

```
repo fetch failed(continue): Command failed: git -C C:\Users\user\orgiast-claude-rules rev-parse HEAD
```

配備コピー `~\orgiast-claude-rules` に 2026-11-20 に作られた空の `.git`（`No commits yet`）があり、`rev-parse HEAD` が `fatal: ambiguous argument 'HEAD'` で例外になり、`updateRepositoryFiles` が一度も呼ばれず同期がスキップされていました。

### 修正

1. `readHead(repoPath)` ヘルパーを追加 — `rev-parse HEAD` の失敗時に空文字を返し、例外を投げない
2. 該当2か所の `rev-parse HEAD` を上記ヘルパーに置き換え
3. `changed` 判定を拡張: `before`/`after` が空文字（空リポジトリ）の場合も安全側で `true` とする
4. テストを2件追加: 空リポジトリで例外が出ないこと / 通常リポジトリでコミットハッシュが取れること

### 検証

```
node --test tools/onboarding-sync.test.mjs
ℹ tests 63
ℹ suites 0
ℹ pass 63
ℹ fail 0
```

63 tests passed（新規2件含む）。`git diff --check`: 問題なし。`git diff --stat`: 2 files changed, 48 insertions(+), 5 deletions(-)

🤖 Generated with [Claude Code](https://claude.com/claude-code)