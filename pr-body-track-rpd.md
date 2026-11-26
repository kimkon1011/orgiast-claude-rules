## 変更内容

`track-rpd-quoter-response-time.mjs` のレポートに quoter 事前生成ステータスと関連統計を追加。

### Must
1. **CSV に `is_pre_generated` と `pre_generated_at` 列を追加** — DB から直接取得し、各行に含める
2. **レポート末尾に 4 つの事前生成統計値を追加**:
   - `pregen_rate`: 事前生成済みレコードの割合
   - `pregen_median_latency_seconds`: 事前生成→応答までの経過秒数中央値
   - `pregen_without_quoter_response`: 事前生成されたが未応答の件数
   - `pregen_abandoned`: 事前生成から 72h 経過しても未応答の件数

### Want
3. **タイムスタンプを JST (ISO8601, `+09:00`) に統一** — 既存の UTC 混在を解消
4. **タイムスタンプフォーマットを ISO8601 に統一** — `2025/12/31 15:00:00` → `2025-12-31T15:00:00+09:00`

### ファイル構成
- `tools/lib/rpd-quoter-response-report.mjs` — レポート生成ロジック（`generateReport`, `formatStatsText`）
- `tools/track-rpd-quoter-response-time.mjs` — エントリポイント（`postgres` パッケージで Supabase 接続）
- `tools/lib/rpd-quoter-response-report.test.mjs` — テスト 15 件

### テスト結果
15 tests passed ✅ — CSV 列増分、統計値の shape（null/non-null/ゼロケース）、JST ISO8601 フォーマット、空レコードを網羅。

🤖 Generated with [Claude Code](https://claude.com/claude-code)