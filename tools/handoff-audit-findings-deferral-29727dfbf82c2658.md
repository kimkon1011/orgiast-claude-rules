# handoff-audit 検証記録: `29727dfbf82c2658`（P3 / d141fe02）の再発検証（2026-11-05）

対象 TODO: `[handoff-audit:29727dfbf82c2658] 恒久修正の先送り文を検出（2026-10-29T18:22:04.956Z / d141fe02 / P3）`

> `t-landed.mjs f0e856b\` は "not landed" のままです。 次に kim がすること: 修正コミット f0e856b を main に取り込む PR のマージ（push/PR/merge はこのループでは禁止のため、人または別経路が行う）

検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）。送信なし・権限変更なし・kim への DM なし。

## 結論（4点）

1. **原文の逐語再発は無い。** 3 台帳（stop-gate-runner 191 行 / handoff-audit 475 行 / handoff-audit-nightly 43 行）を
   `--since 2026-10-30T00:00:00Z`（原文の直後以降）で走査して P1-P4/W 一致は計 1 件のみ。その 1 件は
   **別の監査項目**（2026-11-02T20:49:31.821Z / 1f5e967a / W = `a0879650602acd80`）で、当該監査は
   既に PR #1526（squash commit `e9cfd0c`）として着地・検証済み（原文・同型とも 11-02 以降 0 件と記録済み）。
2. **同型（P3・「次に kim がすること: <fix commit> を main に取り込む PR のマージ」）も原文より後は 0 件。**
   `--since 2026-10-29T00:00:00Z` の P3 は 3 件あり、すべて同一セッション `d141fe02`（原文自身）の
   2026-10-29T18:22 台で、原文より後の ts の P3 はゼロ。`f0e856b` を含む行も全台帳で 2026-10-29T18:23:56 まで（同一違反セッションの繰り返し）に限られ、それ以降の言及は無い。
3. **f0e856b の機能修正は別コミットで回収済み。** コミット `f0e856b` 自体は main に存在しないが、その内容
   （`CODEX_AUTH_FAILED` に `or basic authentication in header` を追加）は後続の指数コミット
   **`50b3291`（PR #1366「先頭が切れた認証失敗 stderrTail を auth_failed に分類し、全失敗が認証失敗なら codex_auth_failed で起票」）として origin/main に着地**しており、しかも拡張版
   （`Failed to refresh token` / `log out and sign in again` も追加、#1533 でさらに追補）になっている。
   回帰テスト（`TRUNCATED_MISSING_BEARER` fixture）も origin/main の `tools/delegation-health-check.test.mjs` に存在し、
   実機 `node --test tools/delegation-health-check.test.mjs` は **133/133 pass**。先送りされた恒久修正の実体は解消済み。
4. **残タスク（フォロー）:** 夜間検出窓は `handoff-audit-deferral-ledger.jsonl` の 2026-11-03T18:01（窓 11-02T15:00〜11-03T15:00、hit=1＝他監査の W）が最後で、11-04 以降の window 記録が無い
   （nightly provider=deepseek が timeout で `audit-unavailable` 連続）。11-04〜05 の再発確認は本検証の直接走査が担った。
   これは前回検証記録（`a0879650` §4）と同内容で、**本監査項目の対象外**。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-29T18:22:04.956Z` 行（監査原文）:

```
sessionId: d141fe02-79e7-4cd3-b2d9-8bba33826093
verdict:   block
match:     t-landed.mjs f0e856b` は "not landed" のままです。 次に kim がすること: 修正コミット f0e856b を main に取り込む PR のマージ（push/PR/merge はこのループでは禁止のため、人または別経路が行…
```

同時刻の `handoff-audit-ledger.jsonl` 該当行（18:19:10〜18:19:56）は `skipped:"regex-blocked"` / `decision:"pass"` で
stop-gate-runner 側の block に検出されていた（原文 18:22:04 はその stop-gate-runner 台帳側の検出）。

## 2. 検証手順

1. `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-29T00:00:00Z` →
   3 台帳で P3=3（すべて `d141fe02`・2026-10-29T18:22）、W=1（2026-11-02 / `1f5e967a`、別監査 ID）。
2. `--since 2026-10-30T00:00:00Z`（原文直後以降）→ 3 台帳で P1-P4/W 計 1 件のみ
   （前述の別監査 W）で、**P3 は 0 件**。
3. 逐語一致の二重確認: 全台帳で `f0e856b` を走査 → 言及はすべて `2026-10-29T18:19〜18:23`（同一違反セッション
   `d141fe02` および前段 `faa83925` / `6171f7bf`）に限られ、11 月以降の言及は 0 件。
4. f0e856b の実物着地確認: `git merge-base --is-ancestor f0e856b origin/main` → **NOT in main** だが、
   `git show origin/main:tools/delegation-health-check.mjs | grep "or basic authentication in header"` → **一致あり**（L268）、
   `git merge-base --is-ancestor 50b3291 origin/main` → **YES**、回帰テスト fixture も origin/main の test ファイルに存在。
5. 実機テスト: `node --test tools/delegation-health-check.test.mjs` → 133 pass / fail 0。

## 3. f0e856b の着地経路（実物検証の内訳）

- `f0e856b`（2026-10-30 03:18、quota-sweep ループ内コミット）: push/PR/merge がループ契約で禁止されていたため未着地。
  ループ外の次の sweep セッション（`quota-sweep/20261031-0339-claude-mvvurnvq` → commit `d681bf0`）が同じ診断を改良して
  PR #1366（squash `50b3291`）で main に着地。**同一修正の重複コミットであり、遅延は 2 日程度で実体は回収済み**。
- origin/main の `tools/delegation-health-check.mjs:268`（現行）:
  ```
  const CODEX_AUTH_FAILED = /401 unauthorized|unauthorized \(401\)|missing bearer or basic authentication|or basic authentication in header|Failed to refresh token|log out and sign in again/i;
  ```
  → f0e856b が追加した `or basic authentication in header` は main で有効。

## 4. 夜間検出の欠落（フォロー事項として記録）

- `~/.claude/handoff-audit-nightly-ledger.jsonl` は 43 行すべて `verdict:audit-unavailable`
  （provider=deepseek, error=timeout-or-provider-unavailable）。
- `~/.claude/handoff-audit-deferral-ledger.jsonl` の window 記録は 2026-11-03T18:01:00.167Z
  （since 11-02T15:00 / until 11-03T15:00, hit=1）が最終で、11-04 以降の window が未実行。
- 影響: 11-04〜05 の先送り文検出は本検証の直接走査で担保（§2）。夜間ジョブ単体の復旧は本 TODO の範囲外
  （前回検証記録 `a0879650` §4 と同じ指摘の継続）。

## 5. 検収

- 原文の逐語再発: なし（§1, §2）
- 同型 P3 の再発: 原文より後 0 件（§2）
- f0e856b の恒久修正: PR #1366（`50b3291`）で main に回収済み・テスト 133/133（§3）
- 残タスク: nightly 検出器の稼働復旧（§4、フォロー・本監査の範囲外）