# handoff-audit 検証記録: `106a259c042d0a32`（W / 4d7e4383）の再発検証（2026-10-23）

対象 TODO: `[handoff-audit:106a259c042d0a32] 恒久修正の先送り文を検出（2026-10-21T05:36:10.905Z / 4d7e4383 / W）`
「アプリ作りのセッションは、画面操作の確認を Codex にやり直させ、その完了を待っています。まだ完了していません。」
（`~/.claude/next-session.md`）。検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly` が実行）、
Stop 時の実ゲートは `tools/deferral-wait-gate.mjs`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論（4点）

1. **原文の逐語再発は無い。** `~/.claude/*.jsonl` の全台帳を走査し、原文と一致する行は当該ターンの
   記録 4 行（`stop-gate-runner-ledger` と `handoff-audit-deferral-ledger` が 05:36:10.905Z、
   `handoff-audit-ledger` が 05:36:04.588Z、`course-corrections-ledger` が 05:36:04.347Z）だけ。以後の出現は 0（§2）。
2. **同型（W＝完了待ち）は事象後に 2 件だけ。** どちらも別セッション `b822034d` の
   `2026-10-21T06:00:01.905Z`「Codex の修正完了を待っています。」と
   `06:18:53.259Z`「Codex のリンク実装の完了を待ってから、このスクリプトを実行します。」で、
   `handoff-audit:e50806fb45fa141c` / `6ac1c04694d4dc1c` として別途検証済み。前者は裸の待機（ゲート対象外）、
   後者は PR #988 のゲートで block になる。05:36:11Z 以降の W ヒットはこの 2 件のみ（§2）。
3. **先送りされた「画面操作の確認のやり直し」は、同じ流れの中で完了している。**
   `keiri-hub` の `b3473ee`（2026-10-21 14:52:43 +0900 = 05:52:43Z）で `/shoyo` 本体と
   `e2e/shoyo.spec.ts` が `main` に入り、`06:14:04Z` のターンで本番 URL・main のコミット・
   Drive 共有を実測して「本番で動いています」と報告されている（§3）。待機で成果は失われていない。
   コストは「ターンを閉じた回数」そのもの。
4. **現行ゲートはこの原文を block する。** repo（`d2d4e60`）と配備先 `~/.claude/nightly-repo`
   （`ae2f798` = origin/main）の両方で `block / DEFERRAL-WAIT` を実測（§4）。

## 1. 原文の再現（一次証拠）

`~/.claude/stop-gate-runner-ledger.jsonl` の `2026-10-21T05:36:10.905Z` 行:

```
sessionId: 4d7e4383-0676-451a-9c40-1dcc90a7c40c
verdict:   pass / blockedBy: []（当時のゲートは待機＋後続作業を拾えていなかった）
excerpt:
アプリ作りのセッションは、画面操作の確認を Codex にやり直させ、その完了を待っています。まだ完了していません。

次に kim がすること: なし
この後の自動進行: 確認が終わったら、そのセッションの結果を確かめて報告する
このセッション: まだ閉じない（作業中）
```

同じターンの `handoff-audit-deferral-ledger.jsonl` は `kind:"hit" / pattern:"W" / verdict:"pass"`、
`observation` は excerpt の SHA-256 `cd8b9096…`。`detect()` に通すと `W`（一致語 `完了を待って`）。
当時の Stop ゲートは「待機語＋近接する後続作業」の述語を持っておらず pass した。
現在の `FUTURE_WORK` はこの 05:36:10 を含む 3 件の実測を根拠に `届いたら` / `終わったら` /
`完了を待ってから` / 通知の受け取りを追加済み（`tools/deferral-wait-gate.mjs` のコメントに明記）。

## 2. 再発の有無（実物の台帳を全走査）

逐語一致（`~/.claude/*.jsonl` の全行走査・2026-10-23 実行）:

| 台帳 | 原文一致行 | 時刻 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1 | 2026-10-21T05:36:10.905Z（当該ターン） |
| `handoff-audit-deferral-ledger.jsonl` | 1 | 2026-10-21T05:36:10.905Z（当該ターン） |
| `handoff-audit-ledger.jsonl` | 1 | 2026-10-21T05:36:04.588Z（当該ターン） |
| `course-corrections-ledger.jsonl` | 1 | 2026-10-21T05:36:04.347Z（当該ターン） |
| `handoff-audit-nightly-ledger.jsonl` | 0 | — |

同型 W の全走査 `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-21T05:36:11Z`:

| 台帳 | total | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 388 | **2** | `W:2`（06:00:01.905Z / 06:18:53.259Z、いずれも `b822034d`） |
| `handoff-audit-ledger.jsonl` | 700 | 0 | — |
| `handoff-audit-nightly-ledger.jsonl` | 36 | 0 | — |

`4d7e4383` の当該セッションの流れ（`handoff-audit-ledger` / `stop-gate-runner-ledger`）:

| ts | excerpt（先頭） |
|---|---|
| 05:04:21Z | アプリ作りは別セッションで動き始めました |
| 05:14:03Z | 実装を任せた Codex の完了待ちです（`handoff-audit:38fe891783fc6ce2`） |
| 05:35:35Z | 実データで画面操作を確かめている最中（承認→試し送り→PDF→承認取消） |
| **05:36:10Z** | **原文**（画面操作の確認を Codex にやり直させ、その完了を待っています） |
| 05:36:38Z | 画面操作の確認を Edge ブラウザでやり直しているところです |
| 05:47:55Z | PDF 修正後の通し確認をもう一度実行しているところです |
| 05:53:36Z | 本番環境での動作確認の結果を待っています |
| 06:00:15Z | 本番で見つかった点を Codex に直させているところです |
| 06:14:04Z | **完了報告**（本番とドライブで実測。「経理ハブに『賞与』画面ができ、本番で動いています」） |

＝原文は長時間セッションの途中経過で、その 38 分後に実測つきの完了報告へ到達している。

## 3. 先送りされた作業の末路（実物で確認）

`C:\Users\test\Desktop\ClaudeCode\keiri-hub`:

| 実物 | 内容 |
|---|---|
| `b3473ee`（2026-10-21 14:52:43 +0900） | 人事評価賞与 `/shoyo` を追加（計算→報告画像→金さん承認→社員へ PDF を Discord DM）と feedback-kit 導入 |
| `e2e/shoyo.spec.ts` | 「賞与結果→横並び報告画像→金さん承認→PDF dry-run」「対象者全員が送信済みなら送信ボタンを無効化」を実際の画面操作で検査。原文が待っていた一連の操作に対応する |
| `f8e631a`（15:03:08 +0900） | 元データを読めないときは「計算開始」で保存済みの計算を上書きしない |
| `git branch --contains b3473ee` | `main`・`origin/main` に含まれる |

06:14:04Z のターンで、本番 URL（ログイン画面へ転送＝画面は存在）、開始確認用 URL の 401、
main の 2 コミット（`b3473ee`・`f8e631a`）反映済み、Drive 共有の未設定 2 件を実測して報告済み。
待機の対象だった画面操作の確認は、違反ターンではなく**同じセッションの後続ターンで通し確認まで到達**した。

## 4. 生きたゲートの実測（repo と配備先）

`judge(<原文の excerpt>)`:

| 対象 | 判定 |
|---|---|
| `tools/deferral-wait-gate.mjs`（repo, `ae2f798` = origin/main） | **block / DEFERRAL-WAIT** |
| `~/.claude/nightly-repo/tools/deferral-wait-gate.mjs`（Stop hook の実体, `ae2f798`） | **block / DEFERRAL-WAIT** |

理由: `W` の一致語「完了を待って」から 160 字以内に `確認が終わったら`（`FUTURE_WORK`）がある。
同セッションの 05:14 の原文（`38fe8917`）も既に positives に入っており block する。
夜間検出器 `permanent-fix-deferral-scan.mjs` は同じ文を `W` として候補化する（§5 で回帰固定）。

## 5. 当ターンで直したもの / 直さなかったもの

**直したもの（回帰テスト）:**
- `tools/deferral-wait-gate.test.mjs` の positives に 05:36:10 の実 excerpt を追加し、
  ゲートが block する境界を逐語で固定した。
- `tools/permanent-fix-deferral-scan.test.mjs` に、同じ excerpt が `W` になることを固定した
  （夜間監査は候補として surface する役割）。

**直さなかったもの:** ゲート本体の変更。既に `FUTURE_WORK` がこの形を拾っており、
同型の `b822034d` 2 件は PR #988 で block 化済み。新しい穴は見つかっていない。

## 6. 未確認

| # | 未確認事項 |
|---|---|
| U1 | Codex がやり直した画面操作そのものの実行ログ（当該セッションの外）は当ターンで再実行していない。`e2e/shoyo.spec.ts` の存在と main への反映、06:14:04Z の本番実測報告までを確認した |
| U2 | 裸の待機文（後続作業を書かない一文）は引き続きゲート対象外。nightly が W として拾う二段構えは `6ac1c046` の検証どおり |

## 7. 次に kim がすること

**なし。** 本記録と回帰テストを PR に載せ、`automerge` ラベルで CI green 後に自動マージする。
