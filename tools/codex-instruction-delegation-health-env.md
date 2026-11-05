## 実装内容
`tools/delegation-health-check.mjs` の `timeout_waste_exceeds_cap` 判定（`judgeTimeoutRows` 呼出）を、ハードコードされた既定値ではなく環境変数から読み取るよう変更します。

### 変更対象
- `tools/delegation-health-check.mjs`
  - `collectFindings()` 内の `judgeTimeoutRows()` 呼出（1箇所）
  - `timeoutWasteSummary()` 内の `judgeTimeoutRows()` 呼出（1箇所）

### 変更内容
- `collectFindings()` の先頭で環境変数 `HEALTH_TIMEOUT_WASTE_THRESHOLD_SECONDS` を読み、数値として有効なら `capSecs` として使う。未設定または無効な値の場合は従来の既定値（`DEFAULT_CAP_SECS` = 900）を維持する。
- 読み取った `capSecs` を `judgeTimeoutRows()` の第2引数 `{ capSecs }` として渡す。
- `timeoutWasteSummary()` も同様に環境変数から `capSecs` を読み取り `judgeTimeoutRows()` に渡す。
- 高い閾値を設定した場合（例: `HEALTH_TIMEOUT_WASTE_THRESHOLD_SECONDS=1000000`）、どの timeout 行も上限超過と判定されず `timeout_waste_exceeds_cap` finding が抑制される。
- `HEALTH_NORMAL_STATUS` 環境変数はタイムアウト関連の status 出力に使う（現状の `id: 'healthy'` 構造は維持する）。

### 入出力の実例
- 環境変数 `HEALTH_TIMEOUT_WASTE_THRESHOLD_SECONDS` が未設定の場合、従来どおり `capSecs=900`（`DEFAULT_CAP_SECS`）で `judgeTimeoutRows()` が呼ばれる。既存テストは全て pass する。
- 環境変数 `HEALTH_TIMEOUT_WASTE_THRESHOLD_SECONDS=1000000` と設定した場合、どの timeout 行も上限超過と判定されず、finding は出ない（delegation-health.json の findings に `timeout_waste_exceeds_cap` が含まれない）。

### 前提条件
- カレントブランチは `quota-sweep/20261104-1547-claude-mw2aj4j2`（tools/ の編集が可能な状態）
- `tools/delegation-health-check.mjs` が存在し読み取り可能
- `tools/timeout-waste-judge.mjs` が存在し、`judgeTimeoutRows()` は第2引数 `{ capSecs }` を受け付ける
- 既存のテスト `tools/delegation-health-check.test.mjs` を参照し、修正箇所以外を壊さないこと

### 禁止事項
- テストファイルの変更は行わない（既存テストが破綻しないように実装すること）
- `judgeTimeoutRows` のデフォルト値（`timeout-waste-judge.mjs` 側の `DEFAULT_CAP_SECS=900`）は変更しない。あくまで呼出側の `delegation-health-check.mjs` だけで環境変数から値を渡す。
- `HEALTH_NORMAL_STATUS` を finding の id 変更に使わない。現状の `id: 'healthy'` を維持する。

### 完了条件
- `tools/delegation-health-check.mjs` の `collectFindings()` 内で `judgeTimeoutRows()` に `{ capSecs }` が環境変数から渡されていること
- `tools/delegation-health-check.mjs` の `timeoutWasteSummary()` 内でも同様に `judgeTimeoutRows()` に `{ capSecs }` が環境変数から渡されていること
- `node --test tools/delegation-health-check.test.mjs` が既存テストを全て pass すること
- `HEALTH_TIMEOUT_WASTE_THRESHOLD_SECONDS=1000000 node tools/delegation-health-check.mjs --dry-run --home /tmp/test-home` で `timeout_waste_exceeds_cap` finding が出ないこと

### 確認用コマンド
```
node --test tools/delegation-health-check.test.mjs
HEALTH_TIMEOUT_WASTE_THRESHOLD_SECONDS=1000000 node tools/delegation-health-check.mjs --dry-run --home /tmp/testhome 2>&1 | grep -c timeout_waste_exceeds_cap
```