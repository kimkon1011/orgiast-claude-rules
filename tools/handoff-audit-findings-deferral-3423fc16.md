# handoff-audit 検証記録: `3423fc1641f7e360`（W / a7673192）の再発検証（2026-10-22）

対象 TODO: `[handoff-audit:3423fc1641f7e360] 恒久修正の先送り文を検出（2026-10-20T10:00:59.186Z / a7673192 / W）`
「Codex の検証はまだ実行中です。終わると自動で通知が届くので、そのときに結果ファイルの中身と、
テスト用の取引が削除されたかを確認して報告します。」
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`
（夜間 `handoff-audit-nightly`）と Stop 時の `tools/deferral-wait-gate.mjs`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（4点）

1. **原文の逐語再発は無い。** 3 台帳を全走査し、原文と一致する行は当該ターンの記録 2 行
   （`stop-gate-runner-ledger` と `handoff-audit-ledger` が同一時刻を記録したもの）だけ。以後 0。
2. **同型（W＝完了待ちでターンを閉じる）は 2026-10-21 に 5 件出た。** いずれも監視セッション
   `b822034d` / `4d7e4383` の途中経過で、当時の Stop 判定は 5 件とも `pass`。ただし両セッションとも
   再開し、最終行は実質的な完了報告だった＝成果は失われていない。詳細は
   `tools/handoff-audit-findings-deferral-52be4096.md` §2（同一セッションの別ターン）。
3. **先送りされた検証そのものは、同じセッションの翌ターンで完了していた。**
   `2026-10-21T02:04:50.922Z` の台帳行で、元セッションが夜間自動進行の
   `api_register_check3.py` / `api_register_check4.py` の結果を読み、freee へ直接照会して
   「確定CSVは API でそのまま取引として登録できる」と報告済み。テスト用取引の削除も結果ファイルに
   残っている（§3）。
4. **原文は現在の生きたゲートで block される（repo と配備先の両方で実測）。**
   今回その実 excerpt を回帰テスト（`tools/deferral-wait-gate.test.mjs` の陽性）に固定した。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-20T10:00:59.186Z` 行:

```
sessionId: a7673192-aa3f-4bc4-b41c-fc0add617a48
cwd:       C:\Users\test\Desktop\ClaudeCode\netpurchase-shiwake
verdict:   pass / blockedBy: [] / reasonCodes: []
excerpt:   Codex の検証はまだ実行中です。終わると自動で通知が届くので、そのときに結果ファイルの
           中身と、テスト用の取引が削除されたかを確認して報告します。
```

同ターンの `handoff-audit-ledger.jsonl` 行（`2026-10-20T10:00:59.173Z`）は
`fired:false / violations:[] / verdict:pass`。`detect()` に通すと `W`（一致語
`終わると自動で通知が届`）。当時の Stop ゲートは、この「通知待ち＋後続作業」を block できていなかった。

※ TODO 行の「作業場所: keiri-hub」は生成時の付与で、違反セッションの cwd は
`netpurchase-shiwake`（ネット購入仕訳）。「Codex の検証」は freee API の登録検証
（`api_register_check3.py` / `check4.py`）を指す。

## 2. 再発の有無（実物の台帳を全走査）

逐語一致（3 台帳の grep）:

| 台帳 | 原文一致行 | 時刻 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1 | 2026-10-20T10:00:59.186Z（当該ターン） |
| `handoff-audit-ledger.jsonl` | 1 | 2026-10-20T10:00:59.173Z（当該ターン） |
| `handoff-audit-nightly-ledger.jsonl` | 0 | — |

同型 W の全走査 `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-20T10:00:59Z`（2026-10-22 実行）:

| 台帳 | total | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 314（最終 `2026-10-21T06:45:19Z`） | 7 | `W:7` |
| `handoff-audit-ledger.jsonl` | 483 | 0 | — |
| `handoff-audit-nightly-ledger.jsonl` | 23 | 0 | — |

| # | ts | セッション | excerpt（先頭） | 当時 | 現在の judge |
|---|---|---|---|---|---|
| 1 | 2026-10-20T10:00:59.186Z | `a7673192` | **原文**（Codex の検証はまだ実行中…） | pass | **block** |
| 2 | 2026-10-20T10:37:09.494Z | `a7673192` | `…すべてを1ページずつ読んでいるので…終わると通知が届きます。` | pass | **block** |
| 3 | 2026-10-21T05:13:52.790Z | `b822034d` | `Codex の完了を待っています。` | pass | pass |
| 4 | 2026-10-21T05:14:03.146Z | `4d7e4383` | `…完了報告が届いたら、結果を確かめて報告する…` | pass | **block** |
| 5 | 2026-10-21T05:36:10.905Z | `4d7e4383` | `…確認が終わったら、その結果を確かめて報告する…` | pass | block（`届いたら` 拡張後） |
| 6 | 2026-10-21T06:00:01.905Z | `b822034d` | `Codex の修正完了を待っています。` | pass | pass |
| 7 | 2026-10-21T06:18:53.259Z | `b822034d` | `Codex のリンク実装の完了を待ってから、このスクリプトを実行します。` | pass | **block**（`待ってから` 拡張後） |

**「再発していない」とは書けない。** 同型は 10-21 に 5 件出ている。ただし 3・6 は後続作業を書かない
裸の待機文（設計上 pass）、4・5・7 は `FUTURE_WORK` 拡張で今後 block される。原文（#1）は拡張前から
block（一致語に `終わると…通知が届` を含むため）。拡張の詳細は
`tools/handoff-audit-findings-deferral-52be4096.md` §5。

## 3. 先送りされた検証の末路（完了済み・実物で確認）

対象フォルダ `C:\Users\test\Desktop\ClaudeCode\netpurchase-shiwake` の実物:

| 実物 | 内容 |
|---|---|
| `api_register_check4.txt` | テスト事業所へ 2 件登録 → `POST HTTP=201` ×2、未払金 +156,700（登録2件の合計と一致）。**削除 `DELETE=204` → 削除後 `GET=404` を 2 件とも確認** |
| `api_register_check3.txt` | 本番事業所のマスター解決（`全項目解決: 21 / 21`・見つからない名前なし） |
| 台帳 `2026-10-21T02:04:50.922Z`（`a7673192`） | 元セッションが結果ファイルを読み、freee へ直接照会して「**確定CSVは API でそのまま取引として登録できます**」と報告 |

＝「結果ファイルの中身」と「テスト用の取引が削除されたか」は、どちらも翌ターンに確認・報告済み。
route の「当ターン内に実装まで終える」は違反ターンでは果たされなかったが、次のターンで回収された。

## 4. 生きたゲートの実測（repo と配備先）

`judge(<原文>)` を直接実行:

| 対象 | 判定 |
|---|---|
| `tools/deferral-wait-gate.mjs`（repo, origin/main 6f1bca0） | **block** `DEFERRAL-WAIT` |
| `~/.claude/nightly-repo/tools/deferral-wait-gate.mjs`（Stop hook の実体） | **block** `DEFERRAL-WAIT` |

`~/.claude/settings.json` の Stop hook は `nightly-repo/tools/stop-gate-runner.mjs` を指す。

## 5. 当ターンで直したもの / 直さなかったもの

**直したもの:** 原文を `tools/deferral-wait-gate.test.mjs` の陽性ケースへ追加し、逐語で
block を固定した（`detect()` の一致語 `終わると自動で通知が届` は既存述語で拾えるため、
ゲート本体の変更は不要だった）。

**直さなかったもの:** 裸の待機文（`Codex の完了を待っています。`）。ゲートは
「待機＋近接する後続作業」を違反条件にしており、後続作業を書かない一文はステータス報告と
区別できない。広げると `CI の完了を待っています。` などの非対象まで block するため設計境界として残す
（52be4096 記録 §5 と同じ判断）。

## 6. 未確認

| # | 未確認事項 |
|---|---|
| U1 | PR #926（夜間スキャンを sessionId ごとの最終行だけに絞る）マージ後、同型 5 件が夜間検出から外れるか（open・未マージ） |
| U2 | 裸の待機文 2 件（#3/#6）が今後も出るか。ゲート対象外 |

## 7. 次に kim がすること

**なし。** 本記録と回帰テストを PR に載せ、`automerge` ラベルで CI green 後に自動マージする。
