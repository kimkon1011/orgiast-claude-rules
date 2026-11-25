# handoff-audit 検証記録: `c64bfb081554dba4`（P3 / e955379b）の再発検証（2026-10-29）

対象 TODO: `[handoff-audit:c64bfb081554dba4] 恒久修正の先送り文を検出（2026-10-23T18:03:48.019Z / e955379b / P3）「次に kim がすること: `f94ee7a` を main にマージするか判断して承認する（承認が必要なのはこの1点だけ）。」`

検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）。送信なし・権限変更なし・kim への DM なし。

## 結論（4点）

1. **対象原文（f94ee7a のマージ判断の kim 手渡し）の再発は 0 件**。
   f94ee7a の SHA は main の祖先ではなく PR にも紐づいていないが、**修正内容は 2026-10-29 検証で main に着地済み**（`tools/stop-gate-runner.mjs` の該当ブロックが origin/main に実在、`regexBlocked: false` の第2段再評価）。対象の先送り文は機能しなくなっている。
2. **同型の新規 P3 が 1 件だけ実測された**: 2026-10-28T08:32:06Z / session `454b60c1`
   → `次に kim がすること: df0b6b4 を main へマージしてください。あわせて deepseek の残高チャージも必要です。gemini-cli の policy 拒否は仕様確認が要ります。`
   型（P3＝マージ判断の kim 手渡し）は対象と同じだが、事例は別（df0b6b4 = delegation-health cooldown/402 除外）。
3. **その df0b6b4 は kim の手を借りずに自動で main 着地済み**:
   - PR #1234（head=`quota-sweep/20261028-0802-claude-mvrtu4g7`・`automerge` ラベル）が 2026-10-28 に merged（merge_commit `4ab76b0a`、origin/main の祖先として実測確認）。
   - `git patch-id` / cherry での内容一致は姉妹監査 `4d44b90dcf96f602`（記録 bcc6d10）で確認済み（patch-id `c71eae2f…` 一致、導入コミット `0449b88`）。
4. **検出器・ゲートの変更は不要**。今回の再発は「検出器が正しく P3 として捕捉した」事例で、自動レーン（quota-sweep → PR + automerge）が当日中に回収済み。恒久修正の再先送りにはなっていない。10-28T08:32 以降 2026-10-29 まで新規ヒット 0 件。

## 1. 対象原文の状態（2026-10-29 実測）

- `git merge-base --is-ancestor f94ee7a origin/main` = 非祖先（f94ee7a は `origin/quota-sweep/20261023-0202-claude-mvkbrycs` 上のみ）。
- GitHub API `GET /repos/kimkon1011/orgiast-claude-rules/commits/f94ee7a/pulls` = 空配列（PR 未紐づけ）。
- ただし origin/main `tools/stop-gate-runner.mjs:138-140` に対象修正の実装が実在:
  ```
  138:  // 先行 gate が発火して第2段を飛ばしたのに、policy/demote で全て無効化された場合は、監査を素通りさせず第2段を改めて評価する。
  140:    const second = await evaluateAudit({ text: assistantText, transcriptRaw: context.raw, sessionId, regexBlocked: false }, ...);
  ```
  導入経路は姉妹監査 `4d44b90dcf96f602` の記録（PR #1047・merge `0449b88`、2026-10-24）。f94ee7a 固有の SHA は main に入っていないが、**内容は同じ修正が別経路で着地している**。

## 2. 再発スキャン実測（2026-10-29）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-28T00:00:00Z`:

- stop-gate-runner-ledger.jsonl: 1249 行中 hits=1（P3=1）
  - 2026-10-28T08:32:06Z / `454b60c1`（上記 df0b6b4、唯一の同型再発）。
- handoff-audit-ledger.jsonl: 2823 行中 hits=**0**
- handoff-audit-nightly-ledger.jsonl: 99 行中 hits=**0**

`--since 2026-10-25T00:00:00Z` に広げても同型 P3 は 1 件のみ（残りは W 型の完了待ち 8 件: b5ec5293 / 5e1d2c93 / 2f10641b）。

## 3. df0b6b4 の着地検証（実物）

- GitHub API `GET /repos/kimkon1011/orgiast-claude-rules/pulls/1234`:
  `state=closed / merged=true / merge_commit_sha=4ab76b0aa415f05f507aca9f6f5d9bec23c5e2be / head=quota-sweep/20261028-0802-claude-mvrtu4g7 / base=main / labels=[automerge]`
- `git -C auto-session-repo merge-base --is-ancestor 4ab76b0aa415f05f507aca9f6f5d9bec23c5e2be origin/main` = 祖先（着地確認・実測）。

## 4. 記録

- 検証日時: 2026-10-29（セッション 2026-10-29-9、branch `auto/20261029-deferral-c64bfb08`）。
- 残った恒久修正の先送り: なし。検出器・ゲートへの変更: なし。
- 次回以降の確認ポイント: なし（姉妹監査 `4d44b90dcf96f602` と結果を共有）。