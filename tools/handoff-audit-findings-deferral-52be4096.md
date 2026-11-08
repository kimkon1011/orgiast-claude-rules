# handoff-audit 検証記録: `52be4096ae8ae31e`（W / a7673192）の再発検証（2026-10-22）

対象 TODO: `[handoff-audit:52be4096ae8ae31e] 恒久修正の先送り文を検出（2026-10-20T10:37:09.494Z / a7673192 / W）
「行中です。本番の品目は件数が多く、すべてを1ページずつ読んでいるので時間がかかっています。終わると通知が届きます。」`
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（4点）

1. **原文の逐語再発は無い。** 3 台帳を `2026-10-20T10:37:10Z` 以降で全走査し、原文と一致する行は
   当該ターンの記録 4 行（同一時刻を各台帳が記録したもの）だけ。以後の出現は 0。
2. **同型（W＝完了待ちでターンを閉じる）は 2026-10-21 に 5 件再発した。** すべて監視セッション
   `b822034d` / `4d7e4383` の途中経過で、当時の Stop 判定は 5 件とも `pass`。
   ただし両セッションともその後再開し、最終行（06:14:48Z / 06:33:13Z）は本番確認の完了報告だった
   ＝**成果は失われていない**。先送りで失われたのはターン内に閉じなかったこと。
3. **先送りされた検証そのものは、夜間の自動進行が完了させていた。** `api_register_check3.py` /
   `api_register_check4.py` の結果が残っており、2026-10-21T02:04:50Z に元セッションが結果を読んで
   freee へ直接照会し直し「確定CSVは API でそのまま取引登録できる」と結論。テスト用取引も削除済み（§3）。
4. **原文は現在の生きたゲートで block される（実測）。** さらに同型の取りこぼし 2 件
   （`完了報告が届いたら…する` / `完了を待ってから…実行する`）を `FUTURE_WORK` に追加した。
   原文＋同型 5 件の 6 件中、block は 2 件 → **4 件**になった。残る 2 件は後続作業を書かない
   裸の待機文（`Codex の完了を待っています。`）で、後続作業の近接を判定条件にする設計上 pass（§5）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-20T10:37:09.494Z` 行:

```
sessionId: a7673192-aa3f-4bc4-b41c-fc0add617a48
cwd:       C:\Users\test\Desktop\ClaudeCode\netpurchase-shiwake
verdict:   pass / blockedBy: [] / reasonCodes: []
excerpt:   確認用のスクリプトは実行中です。本番の品目は件数が多く、すべてを1ページずつ読んでいるので
           時間がかかっています。終わると通知が届きます。
```

同ターンの `handoff-audit-ledger.jsonl` 行は `fired:false / violations:[] / decision:pass`、
`handoff-audit-deferral-ledger.jsonl` 行は `pattern:W / verdict:pass`。
`detect()` に通すと `W`（一致語 `終わると…通知が届`）。

※ TODO 行の「作業場所: keiri-hub」は生成時の付与で、実際の違反セッションの cwd は
`netpurchase-shiwake`（ネット購入仕訳）。「本番の品目」は freee 本番事業所の品目マスタで、
`api_register_check3.py` は `limit=100` の offset ページングで 504 件を 6 回に分けて読んでいた。
ページング自体は API 仕様どおりで、欠陥ではない。問題は**読み終わるのを待ってターンを閉じたこと**。

## 2. 再発の有無（実物の台帳を全走査）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-20T10:37:10Z`（2026-10-22 実行）:

| 台帳 | total | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 314 | **5** | `W:5`（すべて 2026-10-21） |
| `handoff-audit-ledger.jsonl` | 451 | 0 | — |
| `handoff-audit-nightly-ledger.jsonl` | 23 | 0 | — |

| # | ts | セッション | excerpt（先頭） | 当時 | 現在の judge |
|---|---|---|---|---|---|
| 1 | 2026-10-21T05:13:52.790Z | `b822034d` | `Codex の完了を待っています。` | pass | pass |
| 2 | 2026-10-21T05:14:03.146Z | `4d7e4383` | `…Codex の完了待ちです。…完了報告が届いたら、結果を確かめて報告する…` | pass | **block** |
| 3 | 2026-10-21T05:36:10.905Z | `4d7e4383` | `…その完了を待っています。…確認が終わったら、その結果を確かめて報告する…` | pass | block |
| 4 | 2026-10-21T06:00:01.905Z | `b822034d` | `Codex の修正完了を待っています。` | pass | pass |
| 5 | 2026-10-21T06:18:53.259Z | `b822034d` | `Codex のリンク実装の完了を待ってから、このスクリプトを実行します。` | pass | **block** |

**「再発していない」とは書けない。** ただし 5 件はすべて長時間の監視セッションの途中経過で、
両セッションの最終行は次のとおり実質的な完了報告だった:

- `4d7e4383` 最終 `2026-10-21T06:14:48Z`: 経理ハブ `/shoyo` を本番と Drive で確認し、残りは kim 側の設定2つ
- `b822034d` 最終 `2026-10-21T06:33:13Z`: 共有反映と参照シートのリンク表示を確認（commit 57e5274・本番 e2e 8件通過）

= 待機で成果は失っていない。コストは「ターンを閉じた回数」そのもの。

未マージの PR #926（`auto/20261021-deferral-precision`、CI green・open）は、夜間スキャンを
`stop-gate-runner-ledger` の **sessionId ごとの最終行だけ**に変える。マージ後は上記 5 件は
「途中経過」として夜間の検出対象から外れる見込み（当ターンでは未マージのため未適用）。
本記録の判定は現行 main のスキャナで取った実測値。

## 3. 先送りされた検証の末路（完了済み）

`C:\Users\test\Desktop\ClaudeCode\netpurchase-shiwake` の実物:

| 実物 | 内容 |
|---|---|
| `api_register_check3.txt`（2026-10-21 作成） | 本番事業所 11975741 のマスター解決: `account=229 / partner=409 / item=504 / section=2 / tag=207`、21 行すべて解決（`全項目解決: 21 / 21`・見つからない名前なし）。テスト事業所の `NETPURCHASE-TEST-*` は 0 件 |
| `api_register_check4.txt` | テスト事業所 12653837 へ 2 件登録 → `POST HTTP=201`、未払金 16,914,489 → 17,071,189（増加 156,700＝登録2件の合計）を試算表で確認。**削除も `DELETE=204` → `GET=404`** で完了 |
| 台帳 `2026-10-21T02:04:50.922Z` | 元セッションが結果を読み、freee へ直接照会して「確定CSVは API でそのまま取引として登録できます」と結論 |

＝この handoff の先送り対象（検証）は、違反セッションの次の自動進行で**実装・実行まで完了**している。
route の「当ターン内に実装まで終える」は、違反ターンでは果たされなかったが、翌夜の自動進行が回収した。

## 4. 生きたゲートの実測（repo と配備先）

| 対象 | `tools/deferral-wait-gate.mjs`（repo） | `~/.claude/nightly-repo/tools/deferral-wait-gate.mjs`（配備先） |
|---|---|---|
| 原文 excerpt | **block** `DEFERRAL-WAIT` | **block** `DEFERRAL-WAIT` |

`~/.claude/settings.json` の Stop hook は `nightly-repo/tools/stop-gate-runner.mjs` を指しており、
配備先にも同ファイルがあることを確認済み。

## 5. 当ターンで直したもの / 直さなかったもの

**直したもの:** `FUTURE_WORK` に `届いたら` と `(?:完了|終了)を?待ってから` を追加
（`tools/deferral-wait-gate.mjs`）。2026-10-21 の実測 2 件（#2 `完了報告が届いたら…する` /
#5 `完了を待ってから…実行する`）を後続作業として認識する。実 excerpt をそのまま回帰テストに追加
（`tools/deferral-wait-gate.test.mjs` の positives）。

- 変更前: 原文＋同型 5 件 = 6 件中 **2 件 block**（原文・#3）
- 変更後: **4 件 block**（原文・#2・#3・#5）
- `node --test tools/deferral-wait-gate.test.mjs tools/permanent-fix-deferral-scan.test.mjs` → 53 pass / 0 fail

**直さなかったもの:** #1・#4 の裸の待機文（`Codex の完了を待っています。`）。
ゲートは「待機＋近接する後続作業」を違反条件にしており、後続作業を書かない一文だけでは
ステータス報告と区別できない。ここを広げると `CI の完了を待っています。` のような
既存の非対象ケースまで block するため、設計境界として残した（未解決の先送りではない）。

## 6. 未確認

| # | 未確認事項 |
|---|---|
| U1 | PR #926 のマージ後に夜間スキャンから同型 5 件が外れるか（open・CI green を確認したが未マージ） |
| U2 | 裸の待機文 2 件（#1/#4）が今後も出るか。ゲート対象外のため、出ても nightly の last-row 変更後に検出されない可能性 |
| U3 | `b822034d` / `4d7e4383` が待機中に子プロセスを保持していたかは transcript を走査していない（台帳の最終行のみ確認） |

## 7. 次に kim がすること

**なし。** 本記録とゲート修正は PR に載せ、`automerge` ラベルで CI green 後に自動マージする。
