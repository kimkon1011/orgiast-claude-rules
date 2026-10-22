# handoff-audit 検証記録: `28f9a56001c18089`（サブエージェント/他AIレーンへ実装を委譲して『実行中』で終わる）の再発検証

- 対象 TODO: `[handoff-audit:28f9a56001c18089] サブエージェント/他AIレーンへ実装を委譲して『実行中』で終わる`
  （`~/.claude/next-session.md` 残TODO #11）
- 監査日: 2026-10-20（auto-session 2026-10-20-10）
- 起票時刻: **2026-10-18T18:01:30.702Z**（`~/.claude/handoff-audit-nightly-ledger.jsonl` の昇格行
  `observation=cd097922…` / session `3052aef2` / confidence=high。handoff ID は pattern+route の
  sha256 先頭16桁で、route 文が更新されたため旧 `e9640ea79ef414e9` とは別 ID になった）
- 判定: **起票後の再発は 0 件**（真の再発 0 / in-turn 完了 2）。起票前の窓（10-15〜10-18T18:01Z）には
  真の再発が 4 セッションあり、route の landing 前には型が続いていたことを確認した。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 1. 使った道具と検出力

`tools/handoff-audit-lane-delegation-scan.mjs`（読み取り専用）。

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest   → 13/13 pass
```

対照（陽性7・陰性6）が全通過した状態で件数を測った。0 件は「測った 0」。

## 2. 起票後の実測（窓: 2026-10-18T18:01:30Z 〜 2026-10-20T02:56 JST）

```
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-18T18:01:30Z
→ ledger 1155 行 / 窓内 284 行、transcript 267 ファイル / 窓内 22 ファイル / assistant turn 3,684
→ hits 2 / recurrences 0 / inTurnHits 2
```

| ts | session | 一致 | inTurn | 実物の確認 |
|---|---|---|---|---|
| 2026-10-19T05:31:26Z | `1f03b132` | `CI の完了を待ってからマージを試す」までを Codex に任せます` | true | 直後 05:31:34Z に `codex-do.mjs` を Bash で前景起動 → 05:39:57Z に結果（CI 3 ジョブ pass） |
| 2026-10-19T05:44:33Z | `1f03b132` | `CI の完了を待ってマージを試す作業を Codex に任せます` | true | 直後 05:44:35Z に前景起動 → 05:54:19Z に結果（CHECKS pass / MERGE は権限で失敗） |

どちらも**同じ turn 内で前景実行の結果を受け取り、そのまま作業を続けている**（transcript 行 1086→1089、
1156→1159）。turn を「実行中」で閉じた型ではないため、再発には数えない。
＝ 起票後の真の再発は 0 件。

補助確認: `~/.claude/auto-session/runs/2026-10-19*.summary.md` / `2026-10-20*.summary.md` を
`実行中|完了待ち|完了を待っ|バックグラウンド` で走査し、委譲を実行中で閉じた報告は無し。

## 3. 起票前の窓（参考・型が続いていたことの記録）

```
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-15
→ hits 17 / recurrences 15 / inTurnHits 2（同一セッションの ledger+transcript 二重計上を含む）
```

真の再発（inTurn=false かつ人手で本文確認）:

| 日付 | session | 本文 | 状態 |
|---|---|---|---|
| 10-15T02:14Z | `700b6033` | `実装レーン（codex-do → Gemini フォールバック）の完了待ちです` | 既記録（findings-deferral-700b6033.md） |
| 10-15T11:11Z | `e1df5a6f` | `gate の修正は Codex レーンで実行中で、終わり次第、差分とテスト結果を確認します` | 真の再発 |
| 10-18T08:36Z / 14:13Z | `947959f0` | `Codex の実装完了を待っています` / `Codex 経由で…を実行中です` | 真の再発（08:36 は b05b3e88 として別途記録済み） |
| 10-18T09:14/09:16/09:57Z | `fdf5be85` | `実装を委譲レーンで実行中です` / `委譲先で実行中です` | 真の再発 |

`a434a061`（10-16T15:49Z）は検証記録の本文がパターン名を引用した自己言及のため FP。

→ 起票（10-18T18:01Z）以降に真の再発は無く、route の landing 前後で型が止まっている。

## 4. 当ターンで直したもの（恒久策）

**検出器が「同じ user-turn 内で前景実行が完了した hit」を再発から分離できるようにした。**
起票後の 2 hit はどちらもこの型で、毎回人手で transcript を開いて分類していた（前回記録 §5 の未解決点）。

`tools/handoff-audit-lane-delegation-scan.mjs`:
- `completedCodexDoInTurn(records, hitIndex)`: hit 以降、次の本物の user プロンプトまでを同一 turn とし、
  `Bash` の `tool_use` で command が `codex-do.mjs` に一致し、その後に `tool_result` があれば `true`。
- 行に `inTurn` を追加し、返り値に `recurrences`（`!inTurn` の件数）と `inTurnHits` を追加。
  `hits` / `detect()` / `firstMatch()` / `CONTROLS` / `selftest()` は不変（後方互換）。
- ledger 由来の行は `inTurn: false`。

検証:
- `node --test tools/handoff-audit-lane-delegation-scan.test.mjs` → **19 tests / pass 19 / fail 0**
  （ケースA: 前景実行あり=inTurn / B: 実行なし=再発 / C: 別 tool のみ=再発 / D: tool_result なし=再発）
- `--selftest` → 13/13 pass（検出語彙は変えていない）
- 実データ再走査: 起票後 2 hit → `recurrences 0 / inTurnHits 2`。広窓 17 hit → `recurrences 15` で
  **既知の真陽性は 1 件も消えていない**（フラグは再発判定を置き換えず、分類を分けるだけ）。

## 5. 直さなかったもの（限界）

- `inTurn` は「前景で起動して結果が返った」ことだけを見る。起動が前景でも **timeout / 非 0 exit で
  未完了**なら inTurn=true になる（分類の人手確認は残る）。ただし turn を閉じていない点で
  「実行中で handoff」とは別の型であり、本 handoff の再発判定には使える。
- 近接 80 文字・turn 内のみという検出限界は従来どおり。turn をまたぐ言及は取りこぼす（過小評価側）。

## 6. 追検証（2026-10-22）: 起票後 0 件は **再現しなかった**（1 セッション 4 hit）

PR #908（本節 §4 の `inTurn` 分離）は **2026-10-19T18:14:28Z にマージ済み**、CI 4 チェックすべて pass。
配布コピー2系統（`~/.claude/nightly-repo` / `~/orgiast-claude-rules`）の
`tools/handoff-audit-lane-delegation-scan.mjs` は **バイト一致**で `inTurn` 実装を含む。

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest   → 13/13 pass
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-18T18:01:30Z
→ ledger 1453 行 / 窓内 582、transcript 275 ファイル / 窓内 30 / assistant turn 4,818
→ hits 7 / recurrences 4 / inTurnHits 3
```

| ts | session | 一致 | inTurn | 人数え |
|---|---|---|---|---|
| 2026-10-19T05:31:26Z | `1f03b132` | CI 完了待ちマージを Codex に任せます | true | 0（§2 で確認済み） |
| 2026-10-19T05:44:33Z | `1f03b132` | 同上（2 回目） | true | 0 |
| 2026-10-20T23:21:50Z | `cf63f5f2` | `Codex 実行中に、セッション側の変更を準備します` | true | 0 |
| **2026-10-21T07:04:08 / 07:04:21Z** | **`7e568bc0`** | `v3 の組み立ては実装レーン（Codex）で実行中で、終わると通知が来ます` | **false** | **1** |

`7e568bc0` の 4 hit は同一 turn（台帳 2 行＋transcript 2 行）の二重計上で、**セッションとしては 1 件**。
本文は C0051 提案書 v3 の組み立て中に「Codex で実行中、終わると通知が来ます」と報告して turn を閉じたもの
（07:04:12Z に Stop hook が発火しているので turn 終端）。ただし**同一セッションが 08:18:09Z まで続き、
v3 PDF を佐藤様へ Discord DM で送って完結**している（成果物は実在）。＝
「委譲したまま実測せず終える」事故型ではなく、**turn を『実行中』で閉じる型の再発**ではある。

- 判定: 起票後の **真の再発 1 セッション**。前回記録（§2 の recurrences 0）は **10-20 時点**の値で、
  10-21 の 1 件で更新される。**「recurrences 0」は 2026-10-22 時点では成立しない。**
- 未解決の検出器の穴: `inTurn` は前景実行の有無しか見ないため、**委譲先（外部 Codex 通知）で進む
  turn を mid-session の進捗報告と区別できない**。次に直すなら
  (a) `recurrences` をセッション単位に束ねる（台帳＋transcript の二重計上を除く）、
  (b) hit した turn の後に同一セッションで成果物が着地したかを `inTurn` と同様に判定する、の 2 点。
