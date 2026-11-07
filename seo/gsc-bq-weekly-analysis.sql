-- GSC Bulk Data Export: 週次SEO分析クエリ集
--
-- 置換する値:
--   your-project-id : GSCの一括エクスポート先GCPプロジェクトID
--   searchconsole   : GSCが作成するデータセット名（変更した場合のみ置換）
--   your_dataset    : 定期クエリ結果の保存先データセット名
--
-- 3つのクエリは個別に実行・定期設定してください。
-- 対象期間は、データが揃っている可能性が高い「昨日までの7日間」と
-- 「その直前の7日間」です。GSCデータの到着遅延がある場合は基準日を調整してください。
-- 平均掲載順位はGoogle公式の計算式:
--   (SUM(sum_top_position) / SUM(impressions)) + 1.0
-- 匿名化クエリは一括エクスポートに含まれません。さらに query != '' で空文字を除外します。

-- ============================================================================
-- クエリ1: 前週比クリック減ページ（URL × クエリ単位の改善候補）
-- 保存先の例: `your-project-id.your_dataset.weekly_click_declines`
-- clicks_diff <= -1 の行だけを返し、減少幅が大きい順に並べます。
-- ============================================================================
WITH current_week AS (
  SELECT
    url,
    query,
    SUM(clicks) AS clicks_curr,
    SUM(impressions) AS impressions_curr,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_curr,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_curr
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND query != ''
  GROUP BY url, query
),
prior_week AS (
  SELECT
    url,
    query,
    SUM(clicks) AS clicks_prev,
    SUM(impressions) AS impressions_prev
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
    AND query != ''
  GROUP BY url, query
)
SELECT
  COALESCE(c.url, p.url) AS url,
  COALESCE(c.query, p.query) AS query,
  COALESCE(c.clicks_curr, 0) AS clicks_curr,
  COALESCE(p.clicks_prev, 0) AS clicks_prev,
  COALESCE(c.clicks_curr, 0) - COALESCE(p.clicks_prev, 0) AS clicks_diff,
  COALESCE(c.impressions_curr, 0) AS impressions_curr,
  COALESCE(p.impressions_prev, 0) AS impressions_prev,
  ROUND(COALESCE(c.ctr_curr, 0) * 100, 2) AS ctr_curr_pct,
  ROUND(c.avg_position_curr, 2) AS avg_position_curr
FROM current_week AS c
FULL OUTER JOIN prior_week AS p
  ON c.url = p.url
 AND c.query = p.query
WHERE COALESCE(c.clicks_curr, 0) - COALESCE(p.clicks_prev, 0) <= -1
ORDER BY clicks_diff ASC, impressions_curr DESC;

-- ============================================================================
-- クエリ2: 表示増なのにCTR低下キーワード
-- 保存先の例: `your-project-id.your_dataset.weekly_ctr_declines`
-- 今週の表示回数が100超、表示増、CTR低下をすべて満たすクエリを返します。
-- ============================================================================
WITH current_week AS (
  SELECT
    query,
    SUM(clicks) AS clicks_curr,
    SUM(impressions) AS impressions_curr,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_curr,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_curr
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND query != ''
  GROUP BY query
),
prior_week AS (
  SELECT
    query,
    SUM(clicks) AS clicks_prev,
    SUM(impressions) AS impressions_prev,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_prev
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
    AND query != ''
  GROUP BY query
)
SELECT
  c.query,
  c.impressions_curr,
  p.impressions_prev,
  ROUND(c.ctr_curr * 100, 2) AS ctr_curr_pct,
  ROUND(p.ctr_prev * 100, 2) AS ctr_prev_pct,
  c.clicks_curr,
  ROUND(c.avg_position_curr, 2) AS avg_position_curr
FROM current_week AS c
INNER JOIN prior_week AS p USING (query)
WHERE c.impressions_curr > 100
  AND c.ctr_curr < p.ctr_prev
  AND c.impressions_curr > p.impressions_prev
ORDER BY c.impressions_curr - p.impressions_prev DESC;

-- ============================================================================
-- クエリ3: 順位上昇なのに流入が伸びないページ
-- 保存先の例: `your-project-id.your_dataset.weekly_position_opportunities`
-- 平均掲載順位は小さい数値ほど上位です。順位は改善した一方、クリック増が
-- 10以下で、今週の表示回数が50超のURLを返します。
-- ============================================================================
WITH current_week AS (
  SELECT
    url,
    SUM(clicks) AS clicks_curr,
    SUM(impressions) AS impressions_curr,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_curr,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_curr
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND query != ''
  GROUP BY url
),
prior_week AS (
  SELECT
    url,
    SUM(clicks) AS clicks_prev,
    SUM(impressions) AS impressions_prev,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_prev
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
    AND query != ''
  GROUP BY url
)
SELECT
  c.url,
  ROUND(c.avg_position_curr, 2) AS avg_position_curr,
  ROUND(p.avg_position_prev, 2) AS avg_position_prev,
  ROUND(c.avg_position_curr - p.avg_position_prev, 2) AS position_diff,
  c.clicks_curr,
  p.clicks_prev,
  c.impressions_curr,
  ROUND(c.ctr_curr * 100, 2) AS ctr_curr_pct
FROM current_week AS c
INNER JOIN prior_week AS p USING (url)
WHERE c.avg_position_curr < p.avg_position_prev
  AND c.clicks_curr <= p.clicks_prev + 10
  AND c.impressions_curr > 50
ORDER BY position_diff ASC, c.impressions_curr DESC;
