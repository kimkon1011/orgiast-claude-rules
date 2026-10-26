# handoff-audit:4101244d79302da4 再発検証（2026-10-25）

## 対象

`~/.claude/next-session.md` の残TODO:

> [handoff-audit:4101244d79302da4] 他AIレーン上限到達で作業を止め Claude 本体で再開 — この handoff が
> 再発していないかを実物で検証し結果を記録する（再発防止の経路: codex-do.mjs）。送信・権限変更は
> 既存の承認範囲を守る。kimへのDMなし。

- id の再計算: `sha256(JSON.stringify([key("他AIレーン上限到達で作業を止め Claude 本体で再開"), key("codex-do.mjs")]))`
  の先頭16桁 = `4101244d79302da4`（一致を確認）。
- **起票元セッションの原文は本PCに残っていない（未確認）。** `handoff-audit-ledger.jsonl`（1,528行）・
  `handoff-audit-nightly-ledger.jsonl`（45行）・`handoff-audit-promotions.jsonl`（4行）・
  `handoff-audit-candidates.jsonl`・`handoff-audit-deferral-ledger.jsonl`（30行）・transcript 426本の
  いずれにも pattern 文の逐語一致が無い。以下は TODO の pattern 文を定義として検証した結果である。

## 再発の定義

1 turn の assistant 本文が「他AIレーン／Codex の上限（429 / usage limit）に達した」ことを理由に
**作業を止め、Claude 本体での再開や次回への持ち越しを宣言している**型。次のいずれかを含むものは
再発から除く（型の逆または正当な処理）:

- (a) 同一 turn 内に代替レーン／Claude 本体で完了まで進めた
- (b) `[LANE-REPAIR]` で修復または代替を明示した
- (c) 上限そのものを直した実装報告（メタ言及。先送りではない）

## 1. タスク側の実測（transcript 全走査）

- 対象: `~/.claude/projects` + `~/.claude/cheap-code-worker/projects` の **426 jsonl /
  assistant turn 42,963 / 2026-07-01T02:51:57Z〜2026-10-24T16:36:43Z**
- 条件: LANE `/他AI|レーン|Codex|codex-do|LLM|provider|プロバイダ/` ∧
  LIMIT `/上限到達|上限に達|利用上限|usage limit|レート上限|\b429\b|RESOURCE_EXHAUSTED/` ∧
  STOP `/作業を止め|作業は止め|中断|停止|保留|再開|本体/` → **9 hits。全件を目視分類した**:

| 時刻 (Z) | session | 分類 |
|---|---|---|
| 2026-10-12T15:51:36 / 15:51:40 | `c1656ba3` | glm 429 を診断し `delegation-health-check` を直した報告（(c) メタ言及） |
| 2026-10-17T15:58:32 | `66fcf862` | kimi 残高切れ 429 の恒久修正（(c)） |
| 2026-10-22T05:55〜07:12（6件） | `870a3958` | glm 週次上限中に「今回は codex で代替し影響なし」＋`[LANE-REPAIR] glm: 修復不可`。**同一 turn 内で代替**しており (a)(b)。「停止」は kim-PC 端末の休止を指す |

- 逐語の「他AIレーン上限到達で作業を止め Claude 本体で再開」: **0 件**
  （自セッションの監査プロンプト `[handoff-audit:4101244d79302da4]` を除く）。
- 台帳側も同じ条件で走査: `handoff-audit-ledger`(1,528行) strict 10 / `stop-gate-runner-ledger`(631行)
  strict 9 / `handoff-audit-nightly-ledger`(45行) strict 1 / `handoff-audit-deferral-ledger`(30行) strict 0。
  strict hit はすべて上表と同じメタ言及（`c1656ba3` / `66fcf862` / `870a3958` / マージ承認の
  `aa8b6736`）。**型の再発は 0。**
- 先送り検出器の窓走査（`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-20T00:00:00Z`）:
  `stop-gate-runner-ledger: hits 36 / 631`（P1:1 P2:0 P3:35 P4:0 W:0）。P1/P3 は 10-23 の
  `f94ee7a` マージ承認系で、レーン上限の型は 0。

## 2. 再発防止の経路（codex-do.mjs）の実測

### 2.1 実ランタイム

- `~/.claude/codex-limit-history.jsonl`（codex の上限記録）: **2行のみ** =
  2026-10-18T19:14:20Z / 2026-10-19T19:22:06Z。いずれも #889（`c65b63d`, 2026-10-19T20:46Z 着地）より前。
  **着地後の codex 上限は 0 行。**
- `~/.claude/executor-usage.jsonl` の codex 行（2026-10-20T00:00Z〜2026-10-24T16:36Z）:
  **43行 = ok 39 / error 4 / deferred 0 / usage limit 0**。上限で止まった行は無い。
- fallback 行（同期間）: 3行（ok 1 / error 2）。2026-10-20T19:46:03Z に
  `cheap-code:deepseek/deepseek-v4-flash` が **ok**（codex `escalated:exit_1` → 同一 turn 内で代替して完了）
  ＝フォールバック経路が本番で実際に動いている。

### 2.2 コード経路

- `tools/codex-do.mjs:909-915`: 上限時は `executor-usage.jsonl` に `status:"deferred"`・`retryAt`・
  `launched:false` を残す。
- `tools/codex-do.mjs:926-935`: `codex_cooldown`（上限）または `unattended_budget` でも
  **代替バックエンドが1つ以上あれば deferred にせずフォールバックへ回す**（#889 の修正）。
- `tools/codex-do.mjs:936-941`: 代替が無いときだけ `deferredPayload` を出して exit 75。
  **沈黙で止めず、再試行時刻を明示する保留**である。

### 2.3 回帰テスト

`node --test tools/codex-do.test.mjs` → **182 tests / 181 pass / 0 fail / 1 skipped**（2026-10-25 実測）。
上限まわりの固定:

- `tools/codex-do.test.mjs:1580` 上限 stderr → `codex-cooldown.json` 書込 → 次回起動は deferred(75)
- `tools/codex-do.test.mjs:1606` cooldown 中でも代替あり → deferred にせず fallback（`保留:` を出さない）
- `tools/codex-do.test.mjs:1657` 無人枠 8/8 → 9件目は deferred(75)、interactive は通る
- `tools/codex-do.test.mjs:1676` 無人枠到達でも代替あり → deferred にせず fallback、台帳に deferred 行を残さない

## 3. 判定

**再発 0（測った範囲）。**

本PCの transcript 全期間と4台帳のいずれにも、レーン上限を理由に作業を止めて Claude 本体で再開する
handoff は無い。上限が起きた場合の経路は #889 以降、codex-do.mjs が同一 turn 内に代替レーンへ回し、
代替が無い場合だけ明示的な deferred(75) として `retryAt` を残す。実ランタイムでも 2026-10-20 以降の
codex 上限は 0 件で、2026-10-20T19:46Z にフォールバック成功を実測した。追加のコード変更は不要。

## 4. 限界・残リスク

- 対象は本PCに残る transcript（2026-07-01 以降）と4台帳。**他PC・2026-07-01以前・削除済みログは未確認。**
  よって「0 は測った 0」であり、全期間の絶対0ではない。
- 起票元セッションの原文は本PCに無い（逐語一致 0）。TODO の pattern 文からの再構成である。
- codex-do の上限→代替は「代替バックエンドが1つ以上生存」が条件。全レーン上限のときは deferred(75) で
  保留し次セッションへ持ち越す設計であり、停止ではなく明示的保留（仕様）である。
- transcript 上の検出は語彙の近接に依存するため、極端に短い言い換え（例: 「枠が終わったので次回」）は
  取りこぼしうる。今回の全走査では該当なし。

## 5. このターンの変更

- 本ドキュメントのみ（コード変更なし）。経路は既に #889 で修正・回帰テスト済みで、今回の実測はそれを否定しない。
