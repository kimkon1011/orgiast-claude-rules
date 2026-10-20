# handoff-audit 検証記録: `f39d26d0574962cd`（W / 8edc4e46）の再発検証（2026-10-21）

対象 TODO: `[handoff-audit:f39d26d0574962cd] 恒久修正の先送り文を検出（2026-10-19T06:41:59.527Z / 8edc4e46 / W）`
「原因はわかったので、Codex に修正を渡しました。いまはその完了を待っています。…」
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

## 結論（3点）

1. **先送りではない。** 原文はターン途中の経過報告で、同じセッションがその後に実装・レビュー・
   本番反映・ブラウザ検証（16 項目 PASS）まで完了している。停止ゲートもこの行を `verdict=block` で
   差し戻しており、ブロック後にセッションが継続した（＝最終状態ではない）。
2. **待っていた修正は本番まで着地済み。** `D:/repos/booth-production-app` の `75713e1` は origin/master に
   含まれ、その後の #55〜#57 も同枝。本番 Web アプリは HTTP 200 で、新機能の識別子
   `checklistSessions` / `checklistActiveSession` / 「開いている案件」「別の案件」を配信している（実測）。
3. **同型の W は 1 件だけ再発したが、これも中間報告で完了済み**（2026-10-20T02:35 / `7bec04bd`。
   「Codex の作業完了を待っています。」→ 同セッションで月別架電数の修正・検証完了）。
   ただし**検出器が中間行をそのまま拾うため、翌晩に偽の先送り TODO が積まれる**構造だったので、
   検出器を2点修正した（§4）。実台帳で全期間 **15 ヒット → 0 ヒット**、真陽性はテストで固定。

## 1. 原文の一次証拠

`~/.claude/stop-gate-runner-ledger.jsonl`（同日 2 行）:

| ts | verdict | excerpt 要部 |
|---|---|---|
| 2026-10-19T06:41:59.527Z | `block` | 原因はわかったので、Codex に修正を渡しました。いまはその完了を待っています。… |
| 2026-10-19T06:42:06.350Z | `skipped` | Codex が修正を実装中で、まだ終わっていません。… |

`deferral-wait-gate` が 06:41:59 の行を block し、セッションは 06:42 以降も継続した
（transcript `8edc4e46-4678-4813-abdc-190a0a461413.jsonl` の line 183 で Codex 完了通知を受領、
line 196 以降でレビュー・`gas-overlay-push`・ブラウザ検証 16 項目 PASS、line 386 で commit）。
**block された行＝セッションの最終状態ではない**のに、夜間スキャナが同じ行を再度「先送り」として
TODO 化していたのが本項目の実体である。

## 2. 待っていた作業の末路（実物確認）

| 確認対象 | 結果 | 一次証拠（実測） |
|---|---|---|
| 実装コミット | **origin/master に着地** | `git merge-base --is-ancestor 75713e1 origin/master` → true。`75713e1`（src/ui/Checklist.html + test/checklistSessionTabs.test.mjs、+556/−101） |
| 後続変更 | 同枝で継続 | `origin/master` = `2c7d660`(#57) ← `431eda7`(#56) ← `5546c78`(#55) ← `8abdd88` ← `75713e1` |
| 本番配信 | **配信中** | `GET .../exec?app=checklist` → HTTP 200 / 160,717 bytes。本文に `checklistSessions`×2・`checklistActiveSession`×2・「開いている案件」「別の案件」を検出 |
| 回帰テスト | リポジトリに存在 | `origin/master:test/checklistSessionTabs.test.mjs`（198 行） |

＝ 先送りされたまま残った作業はない。

## 3. 再発の有無（実台帳の全期間走査）

修正前の検出器で全期間を走査した結果、`stop-gate-runner-ledger` のヒットは 15 件
（W 7 / P3 7 / P4 1）。分類は次のとおり。

| 型 | 件数 | 判定 |
|---|---|---|
| W（待機語） | 7 | **すべてターン途中の経過報告**。うち対象の `8edc4e46`（06:41:59）と `7bec04bd`（10-20T02:35、6 行中 2 行）は、同セッションが後に完了している。`7ece4ceb` は PR #904 で検証済み。 |
| P3（handoff 行の FIX 語） | 7 | **すべて名詞用法**（「実装指示により」「修正内容」「修正点」「修正点を返信」「数式修正など」）。真の先送り 0 件。 |
| P4（許可要求） | 1 | `fdbd2ff8`（2026-09-25）。既存の設計判断で、今回は対象外。 |

## 4. 検出器の修正（恒久化）

`tools/permanent-fix-deferral-scan.mjs` を 2 点修正し、回帰テストを追加した。

1. **stop-gate 台帳は sessionId ごとの最終行（ts 最大）だけを検出対象にする。**
   Stop フックはターンごとに行を残すため、経過報告や block 後の継続行を最終状態と誤認していた。
   窓で絞る前にファイル全体で最終行を決めるので、「翌晩の窓では最終行が窓外」でも
   解決済みの行は拾わない。`total` は従来どおり全行数。
2. **P3 の FIX 語が名詞接頭辞（指示・点・内容・事項・案・方針・予定・項目・対象・箇所・など・等・方法・手順）
   を伴う出現は先送りとみなさない。** 行内に行為形が 1 つでもあれば従来どおり検出する。

検証:

- `node --test tools/permanent-fix-deferral-scan.test.mjs tools/deferral-wait-gate.test.mjs tools/handoff-audit-nightly.test.mjs` → **65 tests / 65 pass / 0 fail**
- 実台帳（`~/.claude` の3台帳）で修正後の走査 → **全期間 hits=0**（stop-gate 1043 行 / handoff-audit 1141 行 / nightly 49 行）
- 真陽性の保持は回帰テストで固定（`修正は次セッションで行います` → P3、単独 sessionId の待機文 → W）

## 5. 残り

- 本修正は fork PR のため automerge 対象外（`cr568` は upstream への push 権限なし）。**kim の squash-merge 1クリック**で有効になる。
- 本記録の対象作業（booth-production-app のチェックリスト改修）は着地・配信済みで、追加作業なし。
