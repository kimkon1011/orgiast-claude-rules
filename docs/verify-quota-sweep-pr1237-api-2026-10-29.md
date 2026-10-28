# verify: PR #1237 merged（GitHub API 直接照会）— 2026-10-29

目標版: fallback_chain_timeout 修正（PR #1237）の検証のみ（`.loop/quota-sweep-claude.md` 2026-10-29 更新版）。試行 4。

## C1: PR #1237 merged=true（GitHub API 直接照会）— ✅ 確定（暫定→確定に昇格）

- 照会: `GET https://api.github.com/repos/kimkon1011/orgiast-claude-rules/pulls/1237`
  （`git credential fill` で取得した seisaku-team-org トークンを Authorization: Bearer で使用）
- 結果:
  - `title`: "fix(codex-do): cheap-code:deepseek のフォールバックタイムアウトを既定600秒に頭打ちにする"
  - `merged`: **true**
  - `merged_at`: **2026-10-28T15:51:41Z**
  - `merge_commit_sha`: **8966a4d40d8be97daf11c9e6051d193b3038f3c9**
  - `head.ref`: auto/20261029-deepseek-fallback-timeout / `base.ref`: main
  - `merged_by`: github-actions[bot]（automerge）
- 従来の代替証拠（commit-landed で 8966a4d: landed（ancestor）・origin/main ログに現存）と merge_commit_sha が完全一致。
  → C1 は API 未確認の「暫定」不再是正。

## C2: main に修正が現存 — ✅ フェッチ直後の origin/main で再確認

- 2026-10-29 03:07 JST に `git fetch origin main` → origin/main = 798d41a。
- `git show origin/main:tools/codex-do.mjs` の実在（行番号付き）:
  - 422: `export function backendSpecificTimeoutSecs(backendName, env = process.env)`
  - 423-426: gemini-cli → 既定 600 / `CODEX_DO_GEMINI_TIMEOUT_SECS` 上書き可
  - 427-430: `cheap-code:deepseek` と `deepseek` を同一扱い → 既定 600 / **`CODEX_DO_DEEPSEEK_TIMEOUT_SECS` 上書き可**
  - 1354: 使用箇所 `backendSpecificTimeoutSecs(backend.name) ?? Infinity`

## C3: `node --test tools/` — ✅ 試行 3 の緑を有効な既存証拠として保持（再実行しない）

- 試行 3 実測: 代替経路（Node 24 の directory glob 問題で glob + --test-concurrency=1）で
  tools/codex-do.test.mjs のみ 187 pass / 0 fail / 1 skip / 0 cancelled。
  nightly-repo HEAD (5b063a6) は PR #1237 (8966a4d) の祖先のため修正入りコードで実行済み。

## C4: 2026-10-30 03:25 JST 以降の delegation-health.json に fallback_chain_timeout 無し — ⏳ 未観測

- 現在 2026-10-29 03:07 JST。基準時刻（2026-10-30 03:25 JST）前のため観測しない（契約 STEP 2）。
- 現状確認のみ: `~/.claude/delegation-health.json` generatedAt=2026-10-28T15:13:25.952Z
  （mtime 2026-10-29 00:13 JST・基準前）・fallback_chain_timeout 1 件（medium）残存。
- 裏取り: executor-usage.jsonl の直近 24h 窓の timeout 行数は試行 3 時点で 2 件
  （10-28T04:10:18Z / 10-28T12:17:59Z）。窓からの除外（2026-10-29 21:17 JST）も基準時刻も未到達。
- 次回観測: 2026-10-30 03:25 JST 以降に再生成されたファイルで判定。

## C5: 不変条件（症状隠し禁止）— ✅ 判定の範囲で非該当を再確認

- `git diff --stat origin/main...HEAD`（コミット済み差分）=
  docs/gemini-run-shell-policy-spec.md（前目標の調査メモ）+ tools/codex-do.mjs（64060e5 の
  resolveFallbackBackends 同名重複排除 = root-cause 修正）+ tools/codex-do.test.mjs（同テスト）。
  delegation-health-check.mjs・閾値・id 抑止・detectQuotaLimit・cooldown は無変更（差分に不在）。
- 注記: 作業ツリーに未コミットの変更が存在（tools/codex-do.mjs・codex-do.test.mjs・
  delegation-health-check.mjs・qutasks.md・tools/qutask.mjs）。これは別作業（qutask 系）の
  進行中変更で、C5 のゲート対象（origin/main...HEAD）には含まれない。delegation-health-check.mjs の
  変更は POLICY_DENIAL_RE のパターン拡張（検出を広げる方向）で fallback_chain_timeout 抑止に非該当。
  共有作業ツリー保護のため触らず保留。

## DECIDE: ITERATING（C4 のみ時間待ち）

- 確定済み: C1（API）・C2・C3・C5 ✅ / C4 ⏳ 未観測。
- 再開条件: 2026-10-30 03:25 JST 以降。その時刻に delegation-health.json が再生成され、
  findings に fallback_chain_timeout が無く裏取りの 24h 窓が 2 件未満なら FINAL。
- 独立レビュー: 未実施（検証専用目標のため省略可・契約どおり）。