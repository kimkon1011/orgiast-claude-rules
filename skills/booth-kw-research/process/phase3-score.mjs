#!/usr/bin/env node
/** Phase 3: 検索意図分類、スコアリング、優先順位付け（バッチ分類対応 X-0013） */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ruleBasedIntent(keyword) {
  if (/費用|価格|料金/.test(keyword)) return 'Transactional';
  if (/代行|依頼|申込|見積/.test(keyword)) return 'Transactional';
  if (/とは|意味|方法|違い/.test(keyword)) return 'Informational';
  return 'Commercial';
}

function calculateScore(keyword, bizValue) {
  const volume = keyword.volume || 50;
  const difficulty = keyword.difficulty || 30;
  const service = bizValue.services.find(item => item.category === keyword.category);
  const businessValue = service ? service.estimated_unit_price * service.close_rate * service.weight : 0;
  return Math.round((volume * businessValue) / Math.max(difficulty, 1));
}

function getRecommendedAction(score, allScores) {
  if (!allScores.length) return '監視';
  const sorted = [...allScores].sort((a, b) => b - a);
  const topThreshold = sorted[Math.min(Math.floor(sorted.length * 0.3), sorted.length - 1)];
  const midThreshold = sorted[Math.min(Math.floor(sorted.length * 0.6), sorted.length - 1)];
  if (score >= topThreshold) return '新規記事作成';
  if (score >= midThreshold) return '既存ページ改善';
  return '監視';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRunIndex = args.indexOf('--dry-run');
  const isDryRun = dryRunIndex >= 0;
  const outdir = isDryRun && args[dryRunIndex + 1] && !args[dryRunIndex + 1].startsWith('--') ? path.resolve(args[dryRunIndex + 1]) : null;
  if (isDryRun && !outdir) throw new Error('使用法: node process/phase3-score.mjs --dry-run <outdir>');
  const root = isDryRun ? outdir : path.join(__dirname, '..', 'output');
  const keywords = JSON.parse(fs.readFileSync(path.join(root, 'raw-keywords.json'), 'utf-8'));
  const bizValue = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'business-value.json'), 'utf-8'));
  const categories = bizValue.services.map(service => service.category);

  let classifiedKeywords = keywords;
  if (isDryRun) {
    // dry-run: ルールベースで分類
    classifiedKeywords = keywords.map(keyword => ({
      ...keyword,
      intent: ruleBasedIntent(keyword.text),
      category: keyword.category !== '未分類' ? keyword.category : '未分類',
    }));
  } else {
    const { batchClassify, intentPrompt, parseIntentResponse, categoryPrompt, parseCategoryResponse } = await import('./batch-classify.mjs');

    // バッチで意図分類（1回のLLM呼出し）
    const unclassifiedForIntent = keywords.filter(kw => !kw.category || kw.category === '未分類');
    const needsIntent = keywords.filter(kw => kw.category && kw.category !== '未分類');
    let intentResults = {};
    if (unclassifiedForIntent.length > 0) {
      // カテゴリ未分類のキーワードも含めてまとめて意図分類
      const allForIntent = keywords;
      const r = await batchClassify({
        items: allForIntent.map(kw => ({ text: kw.text })),
        tasks: [{
          key: 'intent',
          prompt: (items) => intentPrompt(items),
          parse: (resp, items) => parseIntentResponse(resp, items),
          defaultValue: 'Commercial',
        }],
        dryRun: false,
      });
      intentResults = r;
    } else {
      const r = await batchClassify({
        items: needsIntent.map(kw => ({ text: kw.text })),
        tasks: [{
          key: 'intent',
          prompt: (items) => intentPrompt(items),
          parse: (resp, items) => parseIntentResponse(resp, items),
          defaultValue: 'Commercial',
        }],
        dryRun: false,
      });
      intentResults = r;
    }

    // カテゴリ未分類のものをバッチ分類（Phase 2 でも分類済みだが、ここで補完）
    const unknownCat = keywords.filter((kw, i) => kw.category === '未分類');
    let categoryResults = { category: keywords.map(kw => kw.category) };
    if (unknownCat.length > 0) {
      const r = await batchClassify({
        items: unknownCat.map(kw => ({ text: kw.text })),
        tasks: [{
          key: 'category',
          prompt: (items) => categoryPrompt(items, categories),
          parse: (resp, items) => parseCategoryResponse(resp, items, categories),
          defaultValue: '未分類',
        }],
        dryRun: false,
      });
      // 元の配列にマージ
      let catIdx = 0;
      categoryResults.category = keywords.map((kw) => {
        if (kw.category === '未分類') {
          return r.category[catIdx++];
        }
        return kw.category;
      });
    }

    classifiedKeywords = keywords.map((keyword, i) => {
      const intent = unclassifiedForIntent.length > 0
        ? intentResults.intent[i]
        : (intentResults.intent[needsIntent.indexOf(keyword)] || ruleBasedIntent(keyword.text));
      return {
        ...keyword,
        intent,
        category: categoryResults.category[i],
      };
    });
  }

  // スコア計算（ルールベース、非決定論的処理なし）
  const scored = classifiedKeywords.map(keyword => {
    const normalized = { ...keyword, category: keyword.category !== '未分類' ? keyword.category : 'Commercial' };
    return {
      keyword: keyword.text,
      intent: keyword.intent,
      category: keyword.category,
      volume: keyword.volume || 50,
      difficulty: keyword.difficulty || 30,
      business_value: bizValue.services.find(service => service.category === keyword.category)?.estimated_unit_price || 0,
      score: calculateScore(normalized, bizValue),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const allScores = scored.map(keyword => keyword.score);
  const rows = scored.map((keyword, index) => ({ priority: index + 1, ...keyword, recommended_action: getRecommendedAction(keyword.score, allScores) }));
  const header = ['priority', 'keyword', 'intent', 'category', 'volume', 'difficulty', 'business_value', 'score', 'recommended_action'];
  const outPath = path.join(root, 'keywords-priority.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [header.join(','), ...rows.map(row => header.map(column => csvCell(row[column])).join(','))].join('\n'));
  console.log(`Phase 3 complete: ${rows.length} keywords scored → ${outPath}`);
}

main().catch(error => { console.error('Phase 3 failed:', error.message); process.exit(1); });