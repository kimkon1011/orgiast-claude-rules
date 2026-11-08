#!/usr/bin/env node
/**
 * Phase 3: キーワード評価と優先順位付け
 *
 * 収集したキーワードを検索意図で分類し、ビジネス価値を考慮して優先順位付けする。
 * スコアに基づいて推奨アクション（新規記事作成 / 既存ページ改善 / 監視）を割り当てる。
 *
 * 使用法:
 *   node process/phase3-score.mjs
 *   node process/phase3-score.mjs --dry-run <outdir>
 *
 * TODO(codex): 以下の実装が必要
 * - tools/llm-ask.mjs を呼び出して検索意図分類（Informational/Commercial/Transactional）
 * - data/business-value.json から該当カテゴリのビジネス価値を取得
 * - 優先度スコア計算: Score = Volume × BusinessValue ÷ max(Difficulty, 1)
 * - スコア降順ソート
 * - CSV出力（keywords-priority.csv）
 * - スコアリングロジックの単体テスト
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function classifyIntent(keyword) {
  // 実装予定: tools/llm-ask.mjs --kind classify を呼び出し
  // プロンプト: "以下のキーワードを検索意図で分類: Informational / Commercial / Transactional\nキーワード: {keyword}"
  return 'Commercial';
}

function calculateScore(kw, bizValue) {
  // 実装予定: 優先度スコア計算
  // VolumeはGSCが利用不可の場合、推定値（1-100）かプレースホルダ（50）を使用
  const volume = kw.volume || 50;
  const difficulty = kw.difficulty || 30;
  const service = bizValue.services.find(s => s.category === kw.category);
  const businessValue = service ? service.estimated_unit_price * service.close_rate * service.weight : 0;
  return Math.round((volume * businessValue) / Math.max(difficulty, 1));
}

function getRecommendedAction(score, allScores) {
  // スコアのパーセンタイルに基づいて推奨アクションを割り当て
  if (allScores.length === 0) return '監視';
  const sorted = [...allScores].sort((a, b) => b - a);
  const topThreshold = sorted[Math.min(Math.floor(sorted.length * 0.3), sorted.length - 1)];
  const midThreshold = sorted[Math.min(Math.floor(sorted.length * 0.6), sorted.length - 1)];
  if (score >= topThreshold) return '新規記事作成';
  if (score >= midThreshold) return '既存ページ改善';
  return '監視';
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const dryRunIndex = process.argv.indexOf('--dry-run');
  const outdir = isDryRun && dryRunIndex + 1 < process.argv.length
    ? path.resolve(process.argv[dryRunIndex + 1])
    : null;
  if (isDryRun && !outdir) {
    console.error('Usage: node process/phase3-score.mjs --dry-run <outdir>');
    process.exit(1);
  }

  const kwPath = isDryRun
    ? path.join(outdir, 'raw-keywords.json')
    : path.join(__dirname, '..', 'output', 'raw-keywords.json');
  const keywords = JSON.parse(fs.readFileSync(kwPath, 'utf-8'));
  const bizValuePath = path.join(__dirname, '..', 'data', 'business-value.json');
  const bizValue = JSON.parse(fs.readFileSync(bizValuePath, 'utf-8'));

  const scored = [];
  for (const kw of keywords) {
    const intent = await classifyIntent(kw.text);
    const score = calculateScore(kw, bizValue);
    scored.push({
      keyword: kw.text,
      intent,
      category: kw.category,
      volume: kw.volume || 50,
      difficulty: kw.difficulty || 30,
      business_value: bizValue.services.find(s => s.category === kw.category)?.estimated_unit_price || 0,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // 推奨アクション割り当て
  const allScores = scored.map(k => k.score);
  const withAction = scored.map(kw => ({
    ...kw,
    recommended_action: getRecommendedAction(kw.score, allScores),
  }));

  const outPath = isDryRun
    ? path.join(outdir, 'keywords-priority.csv')
    : path.join(__dirname, '..', 'output', 'keywords-priority.csv');

  const header = 'priority,keyword,intent,category,volume,difficulty,business_value,score,recommended_action';
  const rows = withAction.map((kw, i) =>
    `${i + 1},${kw.keyword},${kw.intent},${kw.category},${kw.volume},${kw.difficulty},${kw.business_value},${kw.score},${kw.recommended_action}`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [header, ...rows].join('\n'));
  console.log(`Phase 3 complete: ${scored.length} keywords scored → ${outPath}`);
}

main().catch(e => {
  console.error('Phase 3 failed:', e.message);
  process.exit(1);
});