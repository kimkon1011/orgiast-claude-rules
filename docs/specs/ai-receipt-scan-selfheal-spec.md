# 指示書A3: 領収書スキャンが「止まったまま放置」にならないようにする（kim 2026-10-18 の問い）

## 実測で見つかった穴
- `OrgiastCostImproveLoop`（kim-PC、毎日 07:20、StartWhenAvailable=True）は 2026-10-17 07:20 を最後に 10/18 は動いていない（次回 10/19 07:20）。つまり PR #847 で入れた `scanAiReceipts` は無人ではまだ一度も走っていない（`~/.claude/ai-receipts.jsonl` の mtime は 10/17 11:46＝手動実行）。
- `tools/cost-improve-loop.mjs` は `scanAiReceipts` が throw すると `aiReceipts = null` にして console.error だけ出す。レポートにも DM にも「スキャンできなかった」が出ない＝沈黙失敗。
- スキャンが成功しても `errors`（アカウント単位の取得失敗・上限100件）は report の末尾行に出るだけで、違反（violations）として扱われず DM 対象にならない。

## 直すこと

### 1. `tools/ai-receipt-scan.mjs` に `--if-stale <hours>` を追加
- 台帳 `~/.claude/ai-receipts.jsonl` と状態 `~/.claude/ai-receipts-alert-state.json` のうち新しい方の mtime が `<hours>` 時間以内なら、何もせず `skip: fresh (<age>h)` を stdout に1行出して exit 0。
- それ以外は通常どおりスキャン（`--notify` と併用可）。
- `export function receiptLedgerAgeHours(home, now)` を追加（無ければ `Infinity`）。テストを足す。
- SA 鍵（`tools/lib/drive-auth.mjs` の `defaultDriveKeyPath()` か `GOOGLE_SA_KEY`）が無い PC では `skip: no-sa-key` を1行出して exit 0（他PCの SessionStart から呼ばれても失敗ログを出さない）。

### 2. `tools/cost-loop.mjs`（SessionStart）に自己修復を追加
- 既存の `cost-work-loop` / `webhook-health` と同じ流儀（guard ファイル `~/.claude/.receipt-scan-guard`、20時間に1回）で、`ai-receipt-scan.mjs --if-stale 30 --notify` を `background()` で起動する。SA 鍵の有無は scan 側が判定するので cost-loop では見ない。
- 目的: 夜間タスクが動かなかった日でも、次に kim-PC で Claude Code を開いた時点で 30 時間超の空白を埋め、アラートがあれば DM する。

### 3. `tools/cost-improve-loop.mjs`: 未計測を違反として扱う
- `collectSignals()` で `aiReceipts` が `null`（throw）のとき、および `aiReceipts.errors.length > 0` のとき、`violations` に `{ kind: 'measurement_untrusted', pc: 'self', severity: 'error', provider: 'receipts', evidence: '領収書スキャン: <失敗理由 or 未計測アカウント一覧>', trusted: true }` を追加する（既存の `measurement_untrusted` と同じ扱い＝レポート先頭・DM 対象）。既存の `evaluate*` の流儀に合わせて関数化し、テストで「null → 違反1件」「errors 2件 → 違反1件に両アカウント名」「正常 → 違反なし」を確認。
- `receiptLedgerAgeHours(home, now) > 36` のときも同じ kind で `evidence: '領収書台帳が <n>h 更新されていない'` を出す（scan が成功していれば直後に更新されるので通常は出ない）。
- レポート本文で `aiReceipts` が null のときは `領収書(全アカウント Gmail): スキャン失敗（未計測）` の1行を必ず出す（沈黙させない）。

### 4. テスト
- `tools/ai-receipt-scan.test.mjs`（--if-stale / no-sa-key / receiptLedgerAgeHours）、`tools/cost-improve-loop.test.mjs`（上記3）、`tools/cost-loop` にテストがあれば guard の追加分。
- 実行: `node --test tools/ai-receipt-scan.test.mjs tools/cost-improve-loop.test.mjs tools/no-undistributed-imports.test.mjs tools/fleet-scope.test.mjs`（cwd=repo）が全部 pass。`fleet-scope.test.mjs` の (c) が新規検出を出したら `tools/fleet-scope.json` に fleet で登録する。
- commit / push はしない。完了報告は変更ファイル一覧とテスト件数だけ。
