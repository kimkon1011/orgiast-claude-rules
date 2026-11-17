# handoff-audit:d66ea8c480c357e4 — 恒久修正の先送り文検出（再発確認）

## 概要
- **監査項目**: W「R #2166 は着地済みで、PR #2167 は CI の最後の `test` 1 件の完了待ちです。」
- **元の違反**: 2026-11-16T18:19:59.033Z / session c6225fba-af4f-49ee-853d-7b26b05ed1f7（verdict: block、handoff-audit-nightly-ledger）
- **判定**: 恒久修正の先送り文（W: CI 完了待ちで着地確認を後回しにする待機語）
- **検出したパターン規則**: `tools/permanent-fix-deferral-scan.mjs` の W（待機語）

## 先送りだった作業の実物検証（2026-11-18 実施）
先送り内容は「#2167 の CI 完了と着地確認」。実物で以下を確認した。

| 対象 | 結果 |
|------|------|
| PR #2166 | **MERGED** 2026-11-16T13:55:48Z |
| PR #2167 | **MERGED** 2026-11-16T14:11:18Z（merge commit `3c32652d`）。CI `test`(CI) / `test`(test) / `test-posix` / `enable-auto-merge` すべて SUCCESS。最後の `test` は 14:11:00Z 完了 |
| git 作業ツリー（`~/.claude/nightly-repo`） | HEAD が `3c32652d` を含む（`git merge-base --is-ancestor` OK） |
| このPCの実行コピー（`~/orgiast-claude-rules`、非git） | `tools/seat-secret.mjs` / `seat-secret.test.mjs` / `seat-secret-pubkey.pem` が存在（mtime 2026-11-18 03:10 JST） |
| 実効性 | 実行コピーで `node --test tools/seat-secret.test.mjs` → **20 pass / 0 fail** |

→ 「CI 完了待ち」と先送りにした着地は auto-merge で完了しており、実行コピーへの反映とテスト緑まで実物で確認した。

## 再発検証（2026-11-18 実施）
- **検出ツール**: `node tools/permanent-fix-deferral-scan.mjs --since 2026-11-16T18:19:59.033Z --json`
- **検出元台帳**: stop-gate-runner-ledger.jsonl（13004行）、handoff-audit-ledger.jsonl（10367行）、handoff-audit-nightly-ledger.jsonl（2345行）

### 結果
| 台帳 | 件数 | W | P1〜P4 |
|------|------|----|----|
| stop-gate-runner | 17 | 17（2026-11-17 に集中、block 12 / pass_after_cap 3 / pass 1 / deliverable-cap 1） | 0 |
| handoff-audit-ledger | 0 | 0 | 0 |
| handoff-audit-nightly-ledger | 1 | 1（**元違反 c6225fba 本人のみ**） | 0 |

- 「PR の CI 完了待ち」という同一文言の再発は 0 件。
- ただし W パターン全体（バックグラウンドの Codex・委譲タスクの完了通知待ちで応答を閉じる型）は 17 件あり、**型としては再発している**。うち 13 件は別監査項目（25ef64a4 / ffb92b5c / c310612a / ba533555 / 0fd3acd1 / ef579378 / b8dec767 / 6c73a209 / f8f8a4b1 / 823f3bc6 / 47e7eb65 / 2dc758ea / 74e8279a）として個別に拾われている。未登録は 444aee64（11-17T15:26）、f1df1c65（11-17T17:09）、03550071（11-17T18:49）の 3 件。

### 結論
**本件（d66ea8c4）の先送り作業は完了済み・同一文言の再発なし**。一方、W の型（バックグラウンド完了通知を待って応答を閉じる）は 11-17 に 17 件再発しており、個別項目の検証では止まらない。Stop ゲートが block しても同型が続いているため、型単位の対策（バックグラウンド起動直後に応答を閉じない／前景で待つ指示を codex-delegate playbook と deferral-wait-gate に入れる）が別途必要。
