# handoff-audit 3dc61863786fe1a0 再検証（2026-11-04）

対象: `[handoff-audit:3dc61863786fe1a0]`（2026-11-01T14:40:40.436Z / session `efe02524-d267-47e8-a9d9-c591dd9d9e30` / W）
原文: 「Codex のコード修正と、メッセージ判定の試運転（60日分）が並行で動いています。どちらも終わると、このセッションに自動で通知が届きます。」
verdict: pass_after_cap（deferral-wait-gate 等が DEFERRAL-WAIT で捕捉後、retry_cap 解放）
再発防止の経路指示: 違反セッションの先送りを当ターン内に実装まで終える

## 結論

**同型（背景作業＋「通知が来たら検証・続行」でターンを閉じる W 型）は、別セッションで 1 件再発した**（`6c57dfd8` / 2026-11-02T02:42:40Z）。
ただしこれは既存の検出器（`permanent-fix-deferral-scan.mjs` の ARRIVAL_WAIT）に捕捉され、`deferral-wait-gate` が `DEFERRAL-WAIT` でブロックしていた。先送りされた実装（security-health アプリの強化）は 2026-11-02 にリポジトリへ着地しており（06f1bdc → 79e37a3）、放置・未実装では終わっていない。

- 原検出（efe02524 14:40）: 現行検出器の W が原文を拾う（ARRIVAL_WAIT「終わると…通知が届」）— 実測再現。
- 同セッション再発（efe02524 15:24 / 16:04）: 前回再検証（2026-11-01 21:18 / dbf660c5）で既知・テスト化済み（`permanent-fix-deferral-scan.test.mjs` の「3dc61863 / efe02524 の同セッション再発」）。
- **新規: 別セッション再発（6c57dfd8 11-02 02:42）**: 前回再検証の後に発生。gate が捕捉（pass_after_cap）。

## 1. 実台帳の再走査

`node tools/permanent-fix-deferral-scan.mjs --since 2026-11-01T14:40:40.436Z --json`（2026-11-04 実行）

| 窓 | stop-gate-runner | handoff-audit | handoff-audit-nightly | 判定 |
|---|---:|---:|---:|---|
| 2026-11-01T14:40:40Z 以降 | 4（全W） | 0 | 0 | stop-gate-runner のみで検出 |

### 各ヒットの判定

| ts | sessionId | verdict | 一致語（match[0]） | 同型判定 |
|---|---|:---:|---|---|
| 2026-11-01T14:40:40.436Z | efe02524 | pass_after_cap | どちらも終わると、このセッションに自動で通知が届 | **原検出**（監査対象そのもの） |
| 2026-11-01T15:24:34.153Z | efe02524 | pass_after_cap | バックグラウンドで完了を待ちます | 同セッション再発・既知（テスト化済み） |
| 2026-11-01T16:04:40.454Z | efe02524 | pass_after_cap | 終わると自動でこのセッションに通知が届きます | 同セッション再発・既知 |
| 2026-11-02T02:42:40.328Z | 6c57dfd8 | pass_after_cap | これはバックグラウンドの作業で、このターンの中では終わりません。終わると Claude に通知が来るので、通知が来たら…検証します | **別セッションの同型再発（新規）** |

`detect()` 実測: 原検出文 → `W:"終わると、このセッションに自動で通知が届"` / 6c57dfd8 文 → `W:"終わると Claude に通知が来るので、通知が来"`（どちらも ARRIVAL_WAIT）。

## 2. 原文と実セッション本文の照合

- **efe02524（原検出）**: 14:40:40 の excerpt は監査対象の原文どおり。deferral-wait-gate 等 3 ゲートが block 後、retry_cap で pass_after_cap。15:24/16:04 は同一セッションの後続ターン（作業フォルダ生成の完了待ち・本番書き込みの通知待ち）。
- **6c57dfd8（別セッション・新規再発）**: security-health アプリ（`C:\Users\kimko\security-health`）を1台のPCで実在企業のデータを扱える水準に強化する作業。原文は 「実装は Codex が hardening-local ブランチで進めています。これはバックグラウンドの作業で、このターンの中では終わりません。終わると Claude に通知が来るので、通知が来たらこのPCで全テストを実行して検証します。」。
  - 同じターン内（02:39:54 / 02:41:07）に deferral-wait-gate が `DEFERRAL-WAIT` で block。02:42:40 は sameTextRetries=3 で pass_after_cap 解放（retry cap 設計どおり）。
  - 以後 04:01 / 04:04 / 05:33 も gate が再捕捉。セッションは継続して作業を進めた。
  - **先送りされた実装の着地**: security-health リポジトリに 2026-11-02 11:38〜14:28 JST でコミットが着地（`06f1bdc` baseline → `dc54b4f`/`a12f46c`/`68bc77f`/`53c7480`/`79e37a3` 強化・テスト・回帰カバレッジ）。≒ 02:42Z(JST 11:42) の直後から作業完了まで継続しており、先送りは「実装しないまま放置」ではなく「背景レーン（Codex）の実装完了後の検証」を約束した形。

## 3. 検出経路の実働（恒久化の有無）

- **検出器**: 原検出文・再発文の両方を W で検出（実測）。6c57dfd8 文は `permanent-fix-deferral-scan.mjs` の 3 台帳走査でヒットし、nightly が窓を開けば fresh hit として拾われる位置にある。
- **ゲート**: `deferral-wait-gate` の `judge()` 実測で 6c57dfd8 原文 → `{decision:'block', code:'DEFERRAL-WAIT'}`。実際の ledger でも blockedBy に deferral-wait-gate / reasonCodes に DEFERRAL-WAIT。**再発を無条件で通していない**。
- **夜間監査（検出経路に欠落あり）**: handoff-audit-deferral-ledger.jsonl の最後の窓は 2026-11-01T18:04:41Z（窓: 10-31T15:00〜11-01T15:00Z）。`OrgiastNightlyBatch` タスクは Ready・LastResult=0 だが、**11-01T18:04Z 以降 deferral window が書かれていない**（11-03 の nightly-batch ログは存在せず、11-04 11:01 の実行は off-peak 帯外で skip）。よって 6c57dfd8（11-02T02:42:40Z）は**夜間の定期走査では未捕捉**であり、本再検証セッションが `permanent-fix-deferral-scan.mjs` を直接実行して初めて捕捉した。夜間走査の cadence 回復（何が止めたかの調査）は本監査とは別の課題として残す。

## 4. 回帰

`node --test tools/permanent-fix-deferral-scan.test.mjs` → **44 pass / 0 fail**（2026-11-04 実測）。テストには既に「3dc61863 / efe02524 の同セッション再発」の回帰ケースが登録済み。6c57dfd8 の原文は ARRIVAL_WAIT の既存ケース（「終わると通知が来る」節）と同一パターンのため、検出器の変更は不要。

## 5. 変更範囲

この再検証文書のみを追加した。コード・テストの変更なし。秘密値・本文全文の転載なし。外部送信・権限変更・main 直接操作なし。