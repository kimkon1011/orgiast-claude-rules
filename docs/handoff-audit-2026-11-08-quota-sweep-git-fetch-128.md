# quota-sweep git-fetch-128 再発確認（2026-11-08）

## 結論

handoff `c94da0f85df28e71` は未完了で、実ログ上も再発していた。`quota-sweep.jsonl` に 2026-11-04 05:38:33Z と 05:53:34Z の2件があり、いずれも Codex レーンが `git fetch` の exit 128、`failureKey=git-fetch-128`、`ticks=0` で停止していた。

## 原因

共有リポジトリ `C:\Users\asmo0\.claude\nightly-repo\.git\HEAD` は41バイトすべて NUL だった。ネットワーク障害ではなく、Git が作業ディレクトリをリポジトリとして認識できないため、`prepareTree` 冒頭の fetch が即時失敗していた。

## 修正

`prepareTree` は fetch より前に shared HEAD を検査する。有効な HEAD は変更しない。破損時は次の順で、実在が確認できる ref だけを使って復元する。

1. loose または packed の `refs/heads/main` があれば symbolic HEAD を復元する。
2. local main が無く packed `refs/remotes/origin/main` があれば、その確認済み commit へ detached HEAD を復元する。
3. どちらも無ければ書き換えず明示的に失敗する。

## 直接検証

- `node --test tools/quota-sweep.test.mjs`: 79件中78成功、1スキップ、失敗0。
- `node --check tools/quota-sweep.mjs`: 成功。
- `git diff --check`: 対象差分のエラーなし。
- 全 `tools/*.test.mjs`: 9070件中9055成功、14スキップ。対象外の `tools/tetsuko-growth-loop.test.mjs` 1件のみ、Windows の symlink 作成権限 `EPERM` で失敗。
- 実環境の破損 HEAD に修復関数を適用: `{"repaired":true}`。
- 同じ実環境で `git fetch origin main --quiet`: exit 0。
- 修復後の `HEAD`: `ref: refs/heads/main`。
- fetch 後の local HEAD: `2fcfefd92505bb4477bddaf3d7a85914b8fda356`。
- fetch 後の `origin/main`: `58e0057d51afc4858b98e58cec42b9aac7390352`。

失敗した quota-sweep ジョブ本体やモデル実行は再起動していない。外部通知、権限変更、既存差分の取り込みも行っていない。
