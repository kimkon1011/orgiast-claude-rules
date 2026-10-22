# handoff-audit 検証記録: `b05b3e883b40daa0`（W / 947959f0）の再発検証（2026-10-20）

対象 TODO: `[handoff-audit:b05b3e883b40daa0] 恒久修正の先送り文を検出（2026-10-18T08:36:45.216Z / 947959f0 / W）
「memory への追記が終わりました。Codex の実装完了を待っています（終わると通知が来ます）。」`
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（3点）

1. **原文の逐語再発は無い。** 3 台帳を全期間走査して、原文と完全一致する W は当該 1 件だけ。
   transcript 側で原文が現れるのは `next-session.md` の監査 TODO 行を読んだ 3 セッションの引用のみ（§3）。
2. **同型（`W`＝ジョブ/レーンの完了待ちで turn を閉じる）は 3 件再発した。**
   2026-10-18T23:10:09.626Z（`6d3cb967`）・2026-10-19T03:46:37.620Z（`947959f0` ＝ **同一セッション**）・
   2026-10-19T03:52:52.104Z（`09042acc`）。うち 2 件は Stop gate の verdict が `pass`（`reasonCodes: []`）で
   止まっていない（§2）。**「再発していない」とは書けない。**
3. **先送りされた実装自体は本番まで到達済みで、失われてはいない。**
   Codex の commit `1d5ac10` → PR #48（merged 2026-10-18T15:34:30Z）→ PR #56 / #57（merged 2026-10-19T16:28:56Z / 16:31:41Z）
   → 本番 GAS `gas-overlay-push` readBack ok → 一括 apply `changed 35 / failed 0 / skipped 3`（§4）。
   検出器に今回の 3 件を取りこぼす欠陥は無く、当ターンのコード修正はしていない（§5）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-18T08:36:45.216Z` 行:

```
sessionId: 947959f0-9d5a-4ff5-9ed7-5ac00e17e811
verdict:   pass / blockedBy: [] / reasonCodes: []
excerpt:   memory への追記が終わりました。Codex の実装完了を待っています（終わると通知が来ます）。
```

`detect()` に直接通すと `W`（一致語 `完了を待って`）。原文の前後（transcript 行 834〜847）を実物で確認した:

- 834: `node tools/codex-do.mjs … --timeout 1500 > …/codex-cpshare.log 2>&1` を **バックグラウンド起動**（タスク `bnl7n59u8`）
- 839: memory `feedback-construction-manual-as-google-slides.md` へ共有設定の追記
- 847: 上記 excerpt（＝Codex の完了を待って turn を閉じた）
- 853: 約 73 秒後に `<task-notification>` completed / exit 0 が届き、セッションは**そのまま再開**
- 862: Codex の報告（実装・テスト・commit `1d5ac10` 完了）を読み、870 でテスト 48 pass を実測

つまり「待ったら通知が来て再開できた」実行ではあるが、headless では turn 終了で子プロセスごと落ちる契約なので、
**待機で締める文面そのものが違反**である（`tools/handoff-audit-lane-delegation-scan.mjs` の P2 と同型）。

## 2. 再発の有無（実物の台帳を全走査）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-18T08:36:45.216Z`（2026-10-20T02:20 JST 実行）:

| 台帳 | hits / total | 内訳 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 4 / 934 | `W:4`（10-18:2 / 10-19:2） |
| `handoff-audit-ledger.jsonl` | 0 / 1123 | — |
| `handoff-audit-nightly-ledger.jsonl` | 0 / 14 | — |

`--since` は境界を含むため 4 件目が原文。**その後に当たる 3 件**は次のとおり:

| # | ts | セッション | 一致語 | verdict | excerpt |
|---|---|---|---|---|---|
| 1 | 2026-10-18T23:10:09.626Z | `6d3cb967` | `完了を待って` | pass | `コピー増殖を止める修正ジョブの完了を待っています（通知が来たら W2 の実データで最終確認します）。` |
| 2 | 2026-10-19T03:46:37.620Z | `947959f0`（原文と同一） | `完了待ち` | pass | `再組版と台帳登録の完了待ちです（数分）。終わり次第、本番デッキのページを目視して報告します。` |
| 3 | 2026-10-19T03:52:52.104Z | `09042acc` | `完了を待って` | block | `今は2つの作業の完了を待っています。どちらも終わると自動で知らせが届くので、そのまま続けます。…`（blockedBy: `decision-research-gate`） |

- #1・#2 は `reasonCodes: []` で **Stop gate が止めていない**。#3 だけが別ゲートで block された。
  `lane-abandonment-gate` は対象が Fable/Opus かつ失敗シグナル有りの turn に限られるため、この 3 件では発火しない。
- **逐語の再発は 0 件**、**同型は 3 件**。前者だけを根拠に「再発していない」とは結論しない。

## 3. 逐語再発が無いことの確認（transcript 実測）

`rg "Codex の実装完了を待って" projects/**/*.jsonl` は 4 ファイルに当たるが、原文セッション以外の 3 ファイル
（`32a84520` / `6d3cb967` / `dee92195`）はすべて `next-session.md` の監査 TODO 行を読んだ**引用**で、
手書きの handoff ではない（前後 200 字を実物確認）。検出器の `isAuditCitation()`（PR #767）と同じ扱いで、
これは違反回数に数えない。

## 4. 先送りされた作業の末路

待っていた「Codex の実装」は施工手順書の anyone-with-link 共有:

- Codex commit `1d5ac10 feat: 施工手順書を毎回リンク閲覧可にし、既存分の一括共有コマンドを追加`（`~/wt-booth-cpshare`、tests 48 pass）
- PR kimkon1011/booth-production-app **#48** MERGED `2026-10-18T15:34:30Z`（原文から約 7 時間後）
- PR **#56** MERGED `2026-10-19T16:28:56Z` / PR **#57** MERGED `2026-10-19T16:31:41Z`（Drive API v3 先行へ変更）
- 本番 GAS `gas-overlay-push` readBack ok、一括 apply の目印 `cpshare_ok_apply_t55_c35_a17_f0_s3_20261020_014236.txt`:
  **total 55 / changed 35 / already 17 / failed 0 / skipped 3**、3 ファイルの permissions に anyone:reader を read-back 確認
  （`~/.claude/auto-session/runs/2026-10-20-6.summary.md`）

＝この先送りは「実装の取りこぼし」は生んでいない。コストは待った時間ではなく、**同じ型が 19 時間で 3 回続いたこと**。

## 5. 当ターンで直したもの / 直さなかったもの

- **直したもの: なし（コード変更なし）。** 今回の 3 件は検出器が正しく拾っており、`detect()` の誤検出・
  取りこぼしの再現は無い。台帳の読み残しも無い（3 台帳の total 行数と走査件数が一致）。
- **直さなかったもの:** Stop gate への待機文のリアルタイム遮断。`W` は正規表現だけでは正当な待機説明
  （外部プロセスの説明・引用）と区別できず、全セッションに block を入れると誤爆が増える。
  `lane-abandonment-gate` を広げる案は「バックグラウンド起動の証跡（tool_use）」を条件にできるが、
  interactive セッションでは正当な使い方でもあるため、headless 判定とセットでないと入れられない。
  設計判断が要るので本記録では実装しない（次の監査項目で扱う）。
- **未反映（予測で埋めない）:** `handoff-audit-deferral-ledger.jsonl` の最終行は原文の hit（10-18T08:36）。
  #1〜#3 は夜間監査の次窓（10-20 03:01 JST 予定）以降に記録される見込みだが、本記録時点では未実行。

## 6. 未確認

| # | 未確認事項 |
|---|---|
| U1 | 10-20 03:01 JST の夜間監査が #1〜#3 を `handoff-audit-deferral-ledger.jsonl` に記録するか（実行前のため未確認） |
| U2 | 同型が今後止まるか。検出器は文面しか見ないので、本記録は行動を変えない |
| U3 | `6d3cb967` / `09042acc` の待機対象ジョブが当ターン内に完了したかは、本記録では追跡していない（各セッションの transcript 未走査） |

## 7. 次に kim がすること

**なし。** 本記録は PR（`auto/20261020-handoff-audit-b05b3e88`）に載せた。cr568 は `push:false` のため
自動マージされない（fork 枝）。マージは PR 作成後に kim-PC 側の codex へ依頼する。

## 8. 2026-10-22 再検証（前回記録の後の窓に再発 0 件）

実行: 2026-10-21T16:10Z（10-22 01:10 JST）。前回記録（PR #906）の後に当たる区間を、
同じ検出器 `tools/permanent-fix-deferral-scan.mjs` で全走査した。送信なし・権限変更なし・コード変更なし。

```
node tools/permanent-fix-deferral-scan.mjs --since 2026-10-20T00:00:00Z
stop-gate-runner-ledger.jsonl : hits=0 / 1008   P1:0 P2:0 P3:0 P4:0 W:0
handoff-audit-ledger.jsonl    : hits=0 / 1453   P1:0 P2:0 P3:0 P4:0 W:0
handoff-audit-nightly-ledger  : hits=0 / 26     P1:0 P2:0 P3:0 P4:0 W:0
```

- 対象区間 = 2026-10-20T00:00Z〜2026-10-21T10:19Z の Stop gate 記録 74 行 / 7 セッション
  （verdict は pass 22・block 52）。**7 セッションと小さい母数**であることは明記しておく。
- **先送り（P1）・次セッション送り（P2）・次に kim がすること欄での送り（P3）・判断丸投げ（P4）・
  待機で締める文（W）のいずれも 0 件。** 前回記録時点で 3 件あった W の同型は、10-19T05:55Z を最後に
  40 時間出ていない。
- 原文の逐語 `Codex の実装完了を待って` は、transcript 上では前回と同じ 4 ファイルにしか現れず
  （`32a84520` / `947959f0` / `dee92195` / `6d3cb967`。いずれも監査 TODO 行の引用）、**新しい手書きの再発は 0 件**。
- 前回の未確認 U1 は解消: `handoff-audit-deferral-ledger.jsonl` に #1〜#3 の `kind:"hit"` が
  各 ts で記録され、窓 `2026-10-18T15:00Z→2026-10-19T15:00Z` は `hits:3` として残っている（実物確認）。

### 8.1 同じ窓の再走査が 3→7 になる件（検出器の拡張が遅れて効いた・欠陥ではない）

`--since 2026-10-18T15:00:00Z --until 2026-10-19T15:00:00Z` を今の検出器で回すと **7 件**（W:7）になる。
台帳の窓記録は 3 件で、差の 4 件は `09042acc` の 10-19T04:22:22Z / 04:51:01Z / 05:37:11Z / 05:55:13Z。

原因は時系列で説明できる。窓記録は `2026-10-19T18:00:50Z` に書かれ、W を
`完了すると…知らせが届` / `〜のを待っています` まで広げた #927（commit `7468573`）のマージは
`2026-10-20T16:51:53Z`。つまり**窓を書いた時点の検出器には、その 4 件を拾う語が無かった**。
夜間監査の欠陥ではなく、検出器の改善が遡って効いたぶんの差。配備状況は 2026-10-21 に実測し、
`~/.claude/nightly-repo`（origin/main と behind 0）と `~/orgiast-claude-rules` の両コピーが拡張版。

追加 4 件は当時 TODO 化されていないが、いずれも 10-19 に終了したターンで、先送りされた作業自体は
§4 のとおり本番まで到達済み。遡って TODO を積む必要は無いと判断した。

### 8.2 残る未確認

| # | 未確認事項 |
|---|---|
| U4 | 夜間監査の窓 `2026-10-20T15:00Z→2026-10-21T15:00Z` はまだ台帳に無い（次回 10-22 03:02 JST 実行）。同区間は本走査で 0 件だが、夜間側の記録は未確認 |
| U5 | W が 0 件なのは「待機で締めない運用が定着した」のか「7 セッションがたまたま待機を伴わなかった」のかは区別できない（検出器は文面しか見ない・前回 U2 と同じ） |

**次に kim がすること: なし。** 本節は PR に載せる（cr568 は `push:false` のため、マージのみ人手）。
