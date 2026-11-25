#!/bin/bash
# ============================================================
# weekly-seo-improve.sh — GA4×AI SEO自動改善 週次パイプライン
# ============================================================
# 定期実行（cron / GitHub Actions / nightly）用スクリプト
#
# 想定実行スケジュール:
#   月 05:00  → GA4+Search Console データ収集
#   火 05:00  → AI分析実行 → 改善案生成
#   水 05:00  → 改善案の優先度判定
#
# 注意:
#   - GA4 / Search Console のデータ取得には API 認証が必要
#   - このスクリプトの一部機能は SA鍵/GCP BigQuery構成後に有効になる
# ============================================================

DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="${DIR}/outputs/seo-weekly"
mkdir -p "${REPORT_DIR}"

WEEK_STAMP=$(date +%Y-%m-%d)
LOG="${REPORT_DIR}/weekly-${WEEK_STAMP}.log"

echo "[$(date)] ====== Weekly SEO Improvement Pipeline =====" | tee -a "$LOG"
echo "[$(date)] Working dir: ${DIR}" | tee -a "$LOG"

# ---- Step 0: GA4データ収集（APIキー必要） ----
echo "[$(date)] Step 0: GA4データ収集..." | tee -a "$LOG"
if [ -n "$GOOGLE_SA_KEY" ]; then
  echo "  → SA鍵: あり（GA4 API連携には別途 GA4 Data API 設定が必要）" | tee -a "$LOG"
else
  echo "  → SA鍵: なし。手動CSVエクスポート推奨" | tee -a "$LOG"
fi

# ---- Step 1: 構造化データ監査 ----
echo "[$(date)] Step 1: 構造化データ監査..." | tee -a "$LOG"
node "${DIR}/tools/schema-audit.mjs" https://www.orgiast.jp > "${REPORT_DIR}/schema-${WEEK_STAMP}.md" 2>&1
echo "  → 結果: schema-${WEEK_STAMP}.md" | tee -a "$LOG"

# ---- Step 2: AI改善提案（モックモード実装） ----
echo "[$(date)] Step 2: AI改善提案生成..." | tee -a "$LOG"
if [ -n "$GEMINI_API_KEY" ]; then
  echo "  → Gemini API: あり" | tee -a "$LOG"
  AI_PROVIDER=gemini \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  node "${DIR}/seo/ga4-ai-pipeline.mjs" \
    --mock \
    --output "${REPORT_DIR}/proposals-${WEEK_STAMP}.md" 2>&1 | tee -a "$LOG"
else
  echo "  → Gemini API: なし（モックモード）" | tee -a "$LOG"
  node "${DIR}/seo/ga4-ai-pipeline.mjs" \
    --mock \
    --output "${REPORT_DIR}/proposals-${WEEK_STAMP}.md" 2>&1 | tee -a "$LOG"
fi
echo "  → 結果: proposals-${WEEK_STAMP}.md" | tee -a "$LOG"

# ---- Step 3: サマリ作成 ----
echo "[$(date)] Step 3: サマリ..." | tee -a "$LOG"
{
  echo "# 週次SEO改善レポート ($(date '+%Y-%m-%d'))"
  echo ""
  echo "## 構造化データ"
  grep -E "^\- .*:|✅|❌|❓" "${REPORT_DIR}/schema-${WEEK_STAMP}.md" | head -20
  echo ""
  echo "## 改善提案"
  grep -E "^###? " "${REPORT_DIR}/proposals-${WEEK_STAMP}.md" | head -20
  echo ""
  echo "## ファイル"
  ls -la "${REPORT_DIR}/"
} > "${REPORT_DIR}/summary-${WEEK_STAMP}.md"

echo "[$(date)] ✅ 週次パイプライン完了" | tee -a "$LOG"
echo "    レポート: ${REPORT_DIR}/summary-${WEEK_STAMP}.md" | tee -a "$LOG"