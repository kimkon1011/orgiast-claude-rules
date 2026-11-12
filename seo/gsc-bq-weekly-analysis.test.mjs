import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const sqlPath = path.join(rootDir, 'seo', 'gsc-bq-weekly-analysis.sql');
const docPath = path.join(rootDir, 'docs', 'gsc-bigquery-weekly-seo-analysis.md');

test('gsc-bq-weekly-analysis.sql file existence and query structure', () => {
  assert.ok(fs.existsSync(sqlPath), 'gsc-bq-weekly-analysis.sql should exist');
  const sqlContent = fs.readFileSync(sqlPath, 'utf8');

  // Query 1: 前週比クリック減ページ
  assert.ok(sqlContent.includes('クエリ1: 前週比クリック減ページ'), 'SQL contains Query 1 header');
  assert.ok(sqlContent.includes('FULL OUTER JOIN'), 'Query 1 uses FULL OUTER JOIN for missing combinations');
  assert.ok(sqlContent.includes('clicks_diff'), 'Query 1 outputs clicks_diff');

  // Query 2: 表示増なのにCTR低下キーワード
  assert.ok(sqlContent.includes('クエリ2: 表示増なのにCTR低下キーワード'), 'SQL contains Query 2 header');
  assert.ok(sqlContent.includes('ctr_curr < p.ctr_prev'), 'Query 2 checks for CTR decline');
  assert.ok(sqlContent.includes('impressions_curr > p.impressions_prev'), 'Query 2 checks for impression growth');

  // Query 3: 順位上昇なのに流入が伸びないページ
  assert.ok(sqlContent.includes('クエリ3: 順位上昇なのに流入が伸びないページ'), 'SQL contains Query 3 header');
  assert.ok(sqlContent.includes('avg_position_curr < p.avg_position_prev'), 'Query 3 checks for rank improvement');
  assert.ok(sqlContent.includes('clicks_curr <= p.clicks_prev + 10'), 'Query 3 checks for limited click gain');
});

test('docs/gsc-bigquery-weekly-seo-analysis.md completeness', () => {
  assert.ok(fs.existsSync(docPath), 'gsc-bigquery-weekly-seo-analysis.md should exist');
  const docContent = fs.readFileSync(docPath, 'utf8');

  assert.ok(docContent.includes('Bulk Data Export'), 'Doc covers GSC Bulk Data Export');
  assert.ok(docContent.includes('Scheduled Query'), 'Doc covers BigQuery Scheduled Query');
  assert.ok(docContent.includes('refreshWeeklySeoReport'), 'Doc includes GAS automated sheet update script');
  assert.ok(docContent.includes('展示会 ブース 制作'), 'Doc includes aujust exhibition/event monitoring keywords');
});
