## 修正内容

`fallbackBackendTimeoutSecs`（既定900秒）が主経路（primary）の codex 呼び出しに適用されていなかった問題を修正。

### 原因

`launchCodex()` の `remainingTimeoutSecs()` は `remainingPrimaryBudgetSecs()` だけを返し、`fallbackBackendTimeoutSecs` の上限を適用していなかった。フォールバック連鎖だけが上限を守り、主経路は `--timeout` の full budget（3000秒など）をそのまま使えていた。

### 実害

2026-11-12: codex(gpt-6-astra) が `--timeout 3000` で 3025 秒動き、50分間を無駄にした。`delegation-health.json` が `timeout_waste_exceeds_cap`(high) を検出。

### 修正

`remainingTimeoutSecs()` に `Math.min(..., fallbackBackendTimeoutSecs(timeoutSeconds))` を追加し、主経路の1試行も900秒上限で打ち切る。

### テスト

- `主経路のタイムアウトは fallbackBackendTimeoutSecs の上限で制限される` — 3種の budget で上限を確認
- `2026-11-12 実例（3025秒/予算3000秒）は上限超過` — 実測値を再現
- `timeout-waste-judge` 全19テスト通過
- `codex-do` 関連テスト全通過
- `TIMEOUT_KILL_FIX_MERGED_AT` を 2026-11-14 へ進め、歴史的行を除外

🤖 Generated with [Claude Code](https://claude.com/claude-code)
