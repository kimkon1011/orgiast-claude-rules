# handoff-audit:13f5d2c0ea6be788 再発検証（2026-10-25）

## 対象

`~/.claude/next-session.md` の残TODO:

> [handoff-audit:13f5d2c0ea6be788] 他AIレーン（Codex等）の usage limit / cooldown で作業が止まった —
> この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: codex-do.mjs）。

- id の再計算: `sha256(JSON.stringify([key("他AIレーン（Codex等）の usage limit / cooldown で作業が止まった"), key("codex-do.mjs")]))`
  の先頭16桁 = `13f5d2c0ea6be788`（一致を確認）。
- **起票元は特定できた**（今回は原文あり）。`~/.claude/handoff-audit-nightly-ledger.jsonl` の
  2026-10-23T18:05:29.835Z 行（session `55e59df6`）が rule 13 / 12 / 5 違反として起票し、
  `learned` にこの pattern を出している。原文の turn は `projects/c--Users-kimko-OneDrive--------CLAUDE-md--/55e59df6-…jsonl` の
  2026-10-23T10:31:41.918Z ほか（下記 §2）。

## 1. 再発の定義

1 turn の assistant 本文で、**レーンの上限語**（usage limit / クールダウン / cooldown / 利用枠切れ /
429 / RESOURCE_EXHAUSTED）の近傍に、**レーン語**（Codex / codex-do / 他AIレーン / DeepSeek / Gemini 等）と
**停止・先送り語**（修復不可 / 作業を止める / 本体で / 次回 / 保留 / 代行）が同時に現れ、
かつ修復・明示フォールバックの証拠が無いもの。

除外（正当な処理）: `[LANE-FALLBACK]`、`lane-doctor(.mjs) --probe` の実行、
`[LANE-REPAIR] <lane>: 修復済み …`。監査 TODO 文そのものも除外。

## 2. 原文（実文）

| 時刻 (Z) | session | 内容 | 判定 |
|---|---|---|---|
| 2026-10-23T10:31:41 / 10:31:53 / 10:46:13 | `55e59df6` | `[LANE-REPAIR] codex: 修復不可 試行: … 3回とも「Codex usage limit クールダウン中」と返り、代わりの DeepSeek が実装しました` | **原文（再発の型）** |
| 2026-10-23T10:39:32 | `bc7b1727` | `[LANE-REPAIR] codex: 修復不可。試したことは次の3つです。- lane-doctor --probe を 10:25Z に実行 → … 生きている実装役は deepseek・glm・gemini-cli … DeepSeek に任せました` | **除外**（lane-doctor 実行＋生存レーンへ委譲。rule 13 の手順どおり） |

原文の時点で codex は 2026-10-23T08:26:50Z から cooldown 中（`~/.claude/codex-cooldown.json` の
`until=2026-10-23T11:32:00Z`）。55e59df6 は lane-doctor を当ターンに実行せず「修復不可」と断定した点が
nightly に rule 13/12 違反と判定された。bc7b1727 は同じ上限でも「試行→生存レーン委譲」を実施しており、
型の再発ではない。

## 3. 再発走査（読み取り専用・機械＋人手分類）

新設した `tools/handoff-audit-lane-limit-abandonment-scan.mjs` で走査した。

```
node tools/handoff-audit-lane-limit-abandonment-scan.mjs --since 2026-10-23T10:31:41Z
```

- 対照（selftest）: **9/9 pass**（陽性4・陰性5。原文・「次回に回す」・「利用枠切れで本体」・「429 で止める」を含む）
- 窓: 2026-10-23T10:31:41Z 〜 実行時刻（約43時間）
- 入力: 台帳4本の窓内行 **260**（handoff-audit 101 / nightly 47 / deferral 10 / course-corrections 102）、
  transcript **63ファイル / assistant turn 4,889**（全571ファイルのうち mtime が窓内のもの）
- 機械ヒット **14** → 除外4（lane-doctor 3 / `[LANE-FALLBACK]` 1）→ 非除外 **10**
- 非除外10の人手分類:
  - **8行 = 原文クラスタ**（`55e59df6` の 10:31:41 / 10:31:53 / 10:46:13 と、その台帳写し）
  - **2行 = `90e20c38`（2026-10-23T19:32Z）** = codex-do の `shouldAbortPolicyStall` 配線を調べた
    実装メモ（「累積上限 8」はループ予算の話）。**メタ言及であり先送りではない**
- **2026-10-23T10:46Z 以降、型の再発は 0 件。**

既存の `handoff-audit-lane-delegation-scan` は「委譲して実行中で終える」型専用で、上限語の
`cooldown` / `修復不可` を持たない。前回監査（`4101244d79302da4`）の語彙も同じ理由で原文を拾えていなかった。
今回それを専用検出器として固定した（§6）。

## 4. 再発防止の経路（codex-do.mjs）の実測

### 4.1 実ランタイム（`~/.claude/executor-usage.jsonl`）

- 原文ターン以降（>2026-10-23T10:46:20Z）: **645行**。うち codex **17行 = ok 12 / deferred 1 / timeout 1 / failed 3**。
  - `deferred` 1行（10:46:25Z, reason=`codex_cooldown`, `retryAt`=11:32Z）は**上限中の明示的保留**（exit 75 相当）。
    codex-do は `retryAt` を残して止まり、同セッションは DeepSeek フォールバックで実装を完了している
    （10:37:44Z / 10:43:58Z の `provider=fallback / cheap-code:deepseek` が ok）。
  - `failed` 3行は quota-sweep の作業ツリー未整理・利用窓情報欠落が理由で、**usage limit ではない**。
  - **usage limit / cooldown を理由に止まった codex 行は 0。**
- `~/.claude/codex-limit-history.jsonl` の最終行は **2026-10-23T08:26:50Z**（原文より前）。
  **原文以降の新規上限記録は 0 行。**

### 4.2 コード経路

- `tools/codex-do.mjs`: 上限検出（`parseCodexResetUntil` / `codex_cooldown`）→ クールダウン記録 →
  代替バックエンドがあればフォールバック、無ければ `deferred`（`retryAt` 付き）で exit 75。
  「沈黙して止まる」経路は無く、止まる場合も再試行時刻を残す。
- 回帰テスト: `node --test tools/codex-do.test.mjs` は本日時点で
  **182 tests / 181 pass / 0 fail / 1 skipped**（同日の別監査 4101244d79302da4 で実測。今回コードは未変更）。

## 5. 判定

**再発 0（測った範囲）。**

原文（55e59df6）の「lane-doctor を試さず修復不可と断定」型は、2026-10-23T10:46Z 以降の約43時間で
台帳260行・assistant turn 4,889 に再発していない。同じ上限に当たった別セッション（bc7b1727）は
lane-doctor と生存レーン委譲を実施しており、手順が機能した実例になっている。
実ランタイムでも codex の usage limit は原文以降 0 件で、上限時は deferred（retryAt 付き）または
DeepSeek フォールバックに落ちている。

## 6. このターンの変更

- `tools/handoff-audit-lane-limit-abandonment-scan.mjs`（新規・読み取り専用）
  — 上限語×レーン語×停止語の近接検出、除外（LANE-FALLBACK / lane-doctor / 修復済み）、対照9件、`--since` / `--selftest`
- `tools/handoff-audit-lane-limit-abandonment-scan.test.mjs`（新規・8 tests）
- 本ドキュメント。
- knowledge への追記はしない: 経路 `codex-do.mjs` は既存 entry（`Codex等の他AIレーン待機が期限切れ→Claude本体で続行`）と
  route が同一で、`mergeKnowledge` の route 重複規則により追加されないため。記録は本ドキュメントに残す。

## 7. 限界・残リスク

- 対象は本PCの transcript（mtime が窓内の63ファイル）と4台帳。**他PC・削除済みログ・mtime が窓外のファイルは未確認。**
  「0 は測った 0」であり全期間の絶対 0 ではない。
- 検出は近接共起依存のため、極端な言い換え（「枠が終わったので次回」等）は取りこぼしうる。
- **残リスク（別件・未修正）**: `llm-ask` の `kimi` レーンは残高不足で恒久 429
  （`exceeded_current_quota_error` / account suspended）のまま、窓内に **252行（ok 0、failover=false、attempt 0/1/2 を各156/48/48）**。
  作業停止には至っていない（transcript に型の再発は無い）が、レーンとしては「上限状態の放置」であり、
  kimi を主経路にした処理では止まる。恒久策（恒久 429 の provider を cooldown 登録し attempt を1に落とす）は
  `llm-ask.mjs` 側の別変更として起票する。今回のスコープ外。
- 毎セッションのプロンプトに含まれる本 TODO 文が lane-abandonment gate の signal として
  2026-10-24T09:49:58Z に block を出している（自己言及の偽陽性）。これは型の再発ではない。
