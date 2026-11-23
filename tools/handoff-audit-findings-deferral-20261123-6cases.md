# handoff-audit 検証記録: 2026-11-21〜22 の未処理 6 件

## 結論

6 件はすべて誤検知。現行スキャンで有効ヒットに残る件は 0 件だった。

- 2 件は PR #2610 の `DELEGATION_STARTED` で除外された。
- 1 件は後続セッションで PR #2548 の着地が確認され、`cross-session` 解消として有効ヒットから除外された。
- 3 件は台帳 excerpt が承認制約を含む発話前半を切り落としていた。transcript の元発話で P3 を再評価する修正と、「回答が無くても実装は自動進行」の非ブロッキング質問除外を追加した。

## 6 件の実データ判定

| finding id | 現行コードでの判定 | 除外条件 | transcript 原文の根拠抜粋 |
|---|---|---|---|
| `35da52a142e5ff3a` | 除外される（誤検知） | `DELEGATION_STARTED` | 「タスク `by7gvg7th`」「締め処理を実行中のため、まだ閉じない（…完了待ち）」 |
| `a3cd09ddd94550da` | 除外される（誤検知） | `REQUIRED_APPROVAL_CONTEXT` + transcript 元発話再評価 | 「この PR には automerge ラベルが無い」「main に入ると全 PC に配られる」 |
| `67559eb8fda00aeb` | 除外される（誤検知） | `REQUIRED_APPROVAL_CONTEXT` + transcript 元発話再評価 | 「PR #8 は…GitHub が draft として拒否しました」「作者が…『マージしない』と明記」 |
| `73fde698e36d7a21` | 有効ヒットから除外（誤検知） | `cross-session` resolution (`pr:2548`) | 「人にしかできない操作で止まってはおらず、Claude 側の自動進行（Codex 実行中）を待っているだけ」 |
| `13a001c76f03d20a` | 除外される（誤検知） | `NON_BLOCKING_ANSWER` | 「②の5つの質問に短く答える（答えなくても7台分の修正は自動で進みます）」 |
| `1a2b3ede8bb7ff68` | 除外される（誤検知） | `DELEGATION_STARTED` | 「Codex（`bged1hp4t`）の push と CI の結果を待っています」 |

## 除外条件の所在

`tools/permanent-fix-deferral-scan.mjs`:

- `W.find()` が `DELEGATION_STARTED` でタスク ID + 完了待ち / push / CI 待ちを除外する。
- `P3.find()` / `P4.find()` が `REQUIRED_APPROVAL_CONTEXT` で automerge 無し、全 PC/全アカウント配布、draft 拒否を除外する。
- `scan()` が P3 について台帳 excerpt の直前の assistant 元発話を読み戻し、切り落とされた承認制約も含めて再評価する。
- `P3.find()` が `NON_BLOCKING_ANSWER` で、回答無しでも修正/実装が自動進行する質問を除外する。

PR #2610 の元実装は commit `09a2a4e3` (`fix(handoff-audit): 委譲待機と承認待ちの誤検知を除外`) で確認した。

## 実行コマンド

| コマンド | exit | 結果 |
|---|---:|---|
| `git status --short; git log --oneline -5` | 0 | 開始時 clean、HEAD `4c5486bd` |
| `node tools/permanent-fix-deferral-scan.mjs --since 2026-11-21T20:00:00Z --until 2026-11-22T13:14:00Z --show-resolved` （修正前） | 0 | 対象の P3 3件が残存、W 1件は `cross-session` 解消 |
| 同コマンド（修正後） | 0 | 対象6件の有効ヒット 0。別件 `c0d5f127` の P2 のみ残存 |
| `node --test tools/permanent-fix-deferral-scan.test.mjs tools/handoff-audit-rescan.test.mjs tools/handoff-audit-nightly.test.mjs tools/handoff-audit-gate.test.mjs` | 0 | 146/146 pass（最終状態） |
| `node --test tools/permanent-fix-deferral-scan.test.mjs` | 0 | 67/67 pass（元発話再評価実装後） |
| `git diff --check` | 0 | 問題なし |

