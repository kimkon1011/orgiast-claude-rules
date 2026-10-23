# handoff-audit 検証記録: `e50806fb45fa141c`（W / b822034d）の再発検証（2026-10-23）

対象 TODO: `[handoff-audit:e50806fb45fa141c] 恒久修正の先送り文を検出（2026-10-21T06:18:53.259Z / b822034d / W）`
「Codex のリンク実装の完了を待ってから、このスクリプトを実行します。」
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly`）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（5点）

1. **原文の逐語再発は 0。** 原文発生 `2026-10-21T06:18:53Z` 以降の 3 台帳（978 行）を全走査し、
   `detect()` の一致は 0 件。
2. **同型（他AIレーンの完了を待ってターンを閉じる）は再発している。** 同じ違反セッション `b822034d` が
   翌 `2026-10-22T01:21:06Z` / `01:22:13Z` / `01:23:27Z` の 3 ターンで
   「Codex が作業中です。終わったら本番まで出して確認します。」の形を繰り返し、**3 件とも pass**
   ／夜間スキャンでも 0 件だった。`41a63819` の `2026-10-22T05:13:04Z` も同型。
3. **成果は失われていない。** `b822034d` は `2026-10-22T01:33:21Z` に本番反映・e2e 9 件通過の完了報告を
   出している。失われたのはターン内に閉じなかったこと（コスト）だけ。
4. **検出の穴を塞いだ。** 待機語が「完了を待って」ではなく「作業中／実行中」「…のを待って、」
   「終わったら…します」だと `W` に一致しないのが原因。`tools/deferral-wait-gate.mjs` に
   他AIレーン待機の述語を追加し、実測 3 件を回帰テストに固定した。
5. **原文・同型は今後 block される（repo で実測）。** 配備先 `~/.claude/nightly-repo` への反映は
   同期後に確認する（§5）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-21T06:18:53.259Z` 行:

```
sessionId: b822034d-f3e2-474d-ad5f-98fb68ddc755
verdict:   pass / matched: []
excerpt:   Codex のリンク実装の完了を待ってから、このスクリプトを実行します。
```

`detect()` に通すと `W`（一致語 `完了を待って`）。当時の Stop ゲートは
`deferral-wait-gate` の `FUTURE_WORK` に `(?:完了|終了)を?待ってから` が入る前（#959 以前）で pass。

## 2. 再発の有無（2026-10-23 実測）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-21T06:18:54Z`:

| 台帳 | 全行 | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 388 | 0 | — |
| `handoff-audit-ledger.jsonl` | 652 | 0 | — |
| `handoff-audit-nightly-ledger.jsonl` | 36 | 0 | — |

**逐語の再発は 0。** ただし `detect()` を通した走査では同型が拾えない。実物の台帳から
「他AI（Codex）の実行中・完了待ち ＋ 近接する後続作業」を人手で拾うと次の 4 件が出た
（いずれも当時の判定は pass、夜間スキャンも 0 件）:

| # | ts | セッション | excerpt（先頭） | 旧ゲート | 新ゲート |
|---|---|---|---|---|---|
| 1 | 2026-10-22T01:21:06.421Z | `b822034d` | 送付欄の表記変更は Codex が作業中です。終わったら本番まで出して確認します。 | pass | **block** |
| 2 | 2026-10-22T01:22:13.344Z | `b822034d` | PDF から計算ルールの行を消しました。Codex の作業が終わったら、まとめてテストして本番に出し… | pass | **block** |
| 3 | 2026-10-22T01:23:27.631Z | `b822034d` | Codex の送付欄の作業が終わるのを待って、まとめて本番に出します。 | pass | **block** |
| 4 | 2026-10-22T05:13:04.961Z | `41a63819` | Codex はまだ作業中です（10:10 起動のプロセスが稼働中）。終わり次第、18日・19日も毎日に変えて当てます。 | pass | **block** |

原因は待機語の語彙。`W` は「完了を待って」「…のを待っています（います/ます が続く）」だけを見るため、
「作業中です」「実行中です」「…のを待って、〜します」は一致しない。ゲートの `FUTURE_WORK`
（`終わったら` 等）は一致するのに、待機側が無いので発火しなかった。

## 3. 先送りされた作業の末路（完了済み・実物）

`b822034d` の同セッション後続ターン:

| ts | 内容 |
|---|---|
| 2026-10-21T06:33:13Z | 共有反映と参照シートのリンク表示を確認（commit 57e5274・本番 e2e 8件通過） |
| 2026-10-22T01:31:03Z〜01:33:21Z | ご指示 4 点を本番反映し確認まで完了（commit 919575d・本番 e2e 9件通過） |

＝「リンク実装を待ってからスクリプトを実行」の対象は、翌ターンに実行・確認まで終わっている。
ターン内に閉じなかったことだけが違反で、成果の消失は無い。

## 4. 恒久修正（ゲート）と実測

`tools/deferral-wait-gate.mjs`:

- `AGENT_RUNNING`（`Codex|codex|他AI|エージェント|レーン` ＋ 作業中/実行中/進行中/稼働中/動いています）を
  待機語に追加し、`FUTURE_WORK` が ±160 字以内にあるとき block。
- `AGENT_WAIT_THEN`（同 ＋ 終わったら/終わり次第/終わると/完了したら/待って、）は、後続 120 字以内に
  動作（します/テストして/反映して 等）があるとき block。
- 監査記録が実 excerpt を「…」で引用した行（`handoff-audit:<16hex>` の直後の引用）は除外。
- 既存の `W` / 返信待ち判定はそのまま。

旧ゲート（origin/main）と新ゲートで全 excerpt を再判定した実測:

| 台帳 | 判定対象 | 旧 block | 新 block | 新たに block | block→pass に変わった行 |
|---|---|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 388 | 7 | 21 | **+14** | 0 |
| `handoff-audit-ledger.jsonl` | 348 | 8 | 27 | **+19** | 0 |

新たに block した行を全件目視した。すべて「Codex 等の実行中／完了待ち ＋ その後に自分が作業する」
の実文で、完了報告・引用・第三者宛の待ちは含まれていない（`Codex が作業中です。` 単独、
`Codex の実装が完了しました。本番反映まで終えています。`、監査引用の 3 ケースは pass を回帰で固定）。

回帰: `node --test tools/deferral-wait-gate.test.mjs tools/permanent-fix-deferral-scan.test.mjs`
→ **67 pass / 0 fail**。実 excerpt 4 件を positives、偽陽性防止 3 件を negatives に追加。

## 5. 生きたゲートの実測

| 対象 | 原文 | 同型 3 件 |
|---|---|---|
| `tools/deferral-wait-gate.mjs`（repo, #988） | **block** `DEFERRAL-WAIT` | **block** |
| `~/.claude/nightly-repo/tools/deferral-wait-gate.mjs`（Stop hook の実体, 8d974eb） | **block** | **block** |

`~/.claude/settings.json` の Stop hook は `nightly-repo/tools/stop-gate-runner.mjs` を指し、
`stop-gate-runner.mjs` の 40 行目で `deferral-wait-gate.mjs` の `judge` を呼んでいる。
#988 のマージ（2026-10-22T15:56:10Z）後、配備先の checkout を定期更新ジョブと同じ
`git fetch origin main && git checkout origin/main` で 8d974eb に進め、配備先の実体で
原文・同型 3 件すべて **block** を実測した（2026-10-23）。

## 6. 実装の経路（Codex 委譲の結果）

`node tools/codex-do.mjs ... --origin unattended --timeout 420` は
`sol 失敗 → astra 昇格 → exit_null`、フォールバック `cheap-code:deepseek` は
`spawn C:\Program Files\nodejs\node.exe ENOENT` で起動できず、作業ツリーは 1 行も変更されなかった
（`git status --porcelain` 空を確認）。このため監督が直接実装し、レビュー・テスト・検証を行った。

## 7. 未確認

| # | 未確認事項 |
|---|---|
| U1 | ~~マージ後、配備先 `~/.claude/nightly-repo` の同期で同型が block になること~~ → 2026-10-23 に 8d974eb へ更新して実測・確認済み（§5） |
| U2 | 夜間スキャン（`permanent-fix-deferral-scan.mjs` の `W`）は本型を拾わないまま。Stop ゲートで塞ぐ設計とし、スキャナの語彙は変えていない（過去台帳の一括再判定で誤検出を作らないため） |
| U3 | `b822034d` が待機中に子プロセスを保持していたかは transcript を走査していない |

## 8. 次に kim がすること

**なし。** 本記録とゲート修正を PR に載せ、`automerge` ラベルで CI green 後に自動マージする。
