# handoff-audit 検証記録: `a36e19f6e99afe91`（quota-sweep claude: git-push-ETIMEDOUT の連続失敗）の再発検証（2026-11-05）

対象 TODO: `[handoff-audit:a36e19f6e99afe91] quota-sweep claude: git-push-ETIMEDOUT の連続失敗 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: tools/quota-sweep.mjs の git-push-ETIMEDOUT を quota-sweep.jsonl とログで調査し、回帰テスト付きで修正してPRを作成する）。送信・権限変更は既存の承認範囲を守る。kimへのDMなし。`

送信なし・権限変更なし・kim への DM なし。検証は `~/.claude/quota-sweep.jsonl` 他台帳（実物）と `tools/quota-sweep.mjs` / テスト（origin/main の実コード）の直接走査で実施。

## 結論（3点）

1. **原文（git-push-ETIMEDOUT の連続失敗）の再発は無い。** `~/.claude/quota-sweep.jsonl` は全 26 行（最終 2026-11-04T15:39:59.191Z）で、`git-push-ETIMEDOUT` の failureKey を持つのは **2026-10-29T18:33:58.149Z と 18:49:52.945Z の 2 件のみ**（goal=`[delegation-health:codex_empty_output]`、deliveryError=`git push: spawnSync git ETIMEDOUT (exit null, timeout 300000ms)`）。以後の発生は **0 件**。`~/.claude/executor-usage.jsonl` も同 2 件のみ、`~/.claude/logs/quota-sweep.log` に ETIMEDOUT 一致 0 行。
2. **既存の対策が main にあり、回帰テストも緑。** `tools/quota-sweep.mjs` の `commandRunner` は git の `fetch`/`push` に **300s timeout**（他 git 120s・その他 60s）を適用し、network エラーは **1 回だけ再試行**（`attempt === 1` で throw）。回帰テスト `tools/quota-sweep.test.mjs` の「fetch and push get a longer timeout and exactly one retry」がこの timeout 分岐（300s/120s）と再試行 1 回を検証済み。実機 `node --test tools/quota-sweep.test.mjs` = **75 pass / 1 skip / 0 fail**。
3. **コード修正は不要・本記録で TODO を閉じる。** 2026-10-29 のループ検証（session `6922d671`）も「再発なし・修正不要」と結論済みだったが、`.loop/quota-sweep-claude-state.md`（untracked）への保存のみでコミット・PR にしなかったため TODO が残っていた。本検証でリポジトリへ記録する。

## 1. 原文の再現（一次証拠）

`~/.claude/quota-sweep.jsonl` の 2026-10-29 該当 2 行（主要フィールド）:

```
2026-10-29T18:33:58.149Z | claude | failed | git-push-ETIMEDOUT
  goal=[delegation-health:codex_empty_output] …, deliveryError "git push: spawnSync git ETIMEDOUT (exit null, timeout 300000ms)"
2026-10-29T18:49:52.945Z | claude | failed | git-push-ETIMEDOUT
  goal=[delegation-health:codex_empty_output] …, deliveryError "git push: spawnSync git ETIMEDOUT (exit null, timeout 300000ms)"
```

TODO 文の「git-push-ETIMEDOUT の連続失敗」はこの 18:33 → 18:49 の 2 連続（同一 goal の PR delivery）を指す。

## 2. 検証手順

1. `~/.claude/quota-sweep.jsonl` を全行 JSON parse し failureKey／deliveryError 列で `*-ETIMEDOUT` を走査 → **該当は上記 2 件のみ**（全 26 行、最後の ETIMEDOUT は 2026-10-29T18:49:52Z）。
2. `~/.claude/executor-usage.jsonl` を走査 → 同 2 件のみ（t=2026-10-29T18:33:58.149Z / 18:49:52.945Z、reason=PR delivery: git push…）。
3. `~/.claude/logs/quota-sweep.log` を走査 → `ETIMEDOUT` 一致 0 行。
4. 他台帳（`logs/stall-sweeper.log` / `logs/auto-session-launcher.log` / `course-corrections-ledger.jsonl` / `stop-gate-runner-ledger.jsonl` / `handoff-audit-ledger.jsonl`）の `git-push`/`ETIMEDOUT` 一致は、すべて次世代 TODO テキスト・監査記録の引用で、**新規の失敗行ではない**（2026-10-31 の stop-gate 一致は別監査 codex_auth_failed の一連）。
5. `origin/main` の `tools/quota-sweep.mjs` `commandRunner` を確認: `network = exe==='git' && ['fetch','push'].includes(args[0])`、`timeout = network ? 300_000 : 120_000`（git 時）、`if ((!network && !lockContention) || attempt === 1) throw` → **network は必ず 1 回だけ再試行**。failureKey は `${exe}-${args[0]}-${code}` で `git-push-ETIMEDOUT` が正しく記録される経路も維持。
6. `origin/main` の `tools/quota-sweep.test.mjs`「fetch and push get a longer timeout and exactly one retry」を実機実行 → 75 pass / 1 skip / 0 fail（spawnSync git ETIMEDOUT を注入し、fetch/push は timeout 300s・再試行 1 回・throw `git ${verb}:.*ETIMEDOUT`、status は 120s・再試行なしを検証）。

## 3. 恒久修正／対策の着地状態

- 対象コード（300s timeout + network 1 回再試行）は 2026-10-29 時点で既に `origin/main` に存在。本監査の再発防止経路が指す「回帰テスト付きで修正して PR」は、**欠陥が無いため修正不要** と判定（既存の回帰テストが当該経路を検証済み）。
- 2026-10-29 のループ検証（`quota-sweep/20261029-2324-claude-mvu67vs6` / session `6922d671`）が同じ結論（C1〜C5 証明・「再発なし・修正不要」）を `.loop/quota-sweep-claude-state.md` に記録済みだったが、ループ設定ファイル（untracked）への保存のみでリポジトリへは記録されていなかった。本検証でリポジトリに記録を残す。

## 4. 監視継続条件

- 今後 `~/.claude/quota-sweep.jsonl` に `git-push-ETIMEDOUT`（または `git-*-ETIMEDOUT`）が再発生した場合、再検証する。今回の 2 件は起票前の単発事象（再試行込み 2×300s で応答なし）であり、一過性のネットワーク／GitHub 側要因と推定（外部側の状態はこの PC から直接は確認できない）。
- 夜間検出窓（`handoff-audit-deferral-ledger.jsonl`）が 2026-11-03T18:01 以降未更新（provider timeout 系で `audit-unavailable` 連続）の指摘は別監査の既知フォローと同内容で、本監査の範囲外（直接走査で担保済み）。

## 5. 検収

- 原文の逐語再発: なし（2026-10-29 の 2 件のみ、以降 0 件）
- 同型（`git-*-ETIMEDOUT` / PR delivery 失敗）の再発: なし
- 恒久対策: 300s timeout + 1 回再試行が `origin/main` に存在、回帰テスト 75 pass / 0 fail
- コード修正: 不要（欠陥なし）