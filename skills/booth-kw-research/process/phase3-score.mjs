#!/usr/bin/env node
/** Phase 3: 検索意図分類、スコアリング、優先順位付け */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const LLM_PATH = path.resolve(__dirname, '..', '..', '..', 'tools', 'llm-ask.mjs');

function ruleBasedIntent(keyword) {
  if (/費用|価格|料金/.test(keyword)) return 'Commercial';
  if (/代行|依頼|申込|見積/.test(keyword)) return 'Transactional';
  if (/とは|意味|方法|違い/.test(keyword)) return 'Informational';
  return 'Commercial';
}

async function askLlm(prompt, max = '80') {
  const { stdout } = await execute(process.execPath, [LLM_PATH, '--provider', 'groq', '--prefer-provider', '--category', 'classification', '--max', max, prompt], {
    timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function classifyIntent(keyword, useLlm) {
  if (!useLlm) return ruleBasedIntent(keyword);
  const prompt = `次のキーワードの検索意図を分類してください。選択肢: Informational（情報収集）/ Commercial（比較検討）/ Transactional（購入・申込）。\nキーワード: ${keyword}\n回答は選択肢の英語1単語のみでお願いします。`;
  try {
    const answer = await askLlm(prompt);
    return ['Informational', 'Commercial', 'Transactional'].find(intent => new RegExp(`\\b${intent}\\b`, 'i').test(answer)) || ruleBasedIntent(keyword);
  } catch (error) {
    console.error(`  LLM検索意図分類失敗: ${keyword}: ${error.message}`);
    return ruleBasedIntent(keyword);
  }
}

async function classifyCategory(keyword, categories, useLlm) {
  if (!useLlm) return '未分類';
  const prompt = `次のキーワードを最も近いカテゴリに分類してください。\n選択肢: ${categories.join(' / ')}\nキーワード: ${keyword}\n回答は選択肢のカテゴリ名1つのみでお願いします。`;
  try {
    const answer = await askLlm(prompt);
    return categories.find(category => answer.includes(category)) || '未分類';
  } catch (error) {
    console.error(`  LLMカテゴリ分類失敗: ${keyword}: ${error.message}`);
    return '未分類';
  }
}

async function mapLimit(items, limit, mapper) {
  const result = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; result[index] = await mapper(items[index], index); }
  }));
  return result;
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
  const classified = await mapLimit(keywords, 5, async keyword => {
    const category = keyword.category === '未分類' ? await classifyCategory(keyword.text, categories, !isDryRun) : keyword.category;
    const normalized = { ...keyword, category };
    const intent = await classifyIntent(keyword.text, !isDryRun);
    return {
      keyword: keyword.text,
      intent,
      category,
      volume: keyword.volume || 50,
      difficulty: keyword.difficulty || 30,
      business_value: bizValue.services.find(service => service.category === category)?.estimated_unit_price || 0,
      score: calculateScore(normalized, bizValue),
    };
  });
  classified.sort((a, b) => b.score - a.score);
  const allScores = classified.map(keyword => keyword.score);
  const rows = classified.map((keyword, index) => ({ priority: index + 1, ...keyword, recommended_action: getRecommendedAction(keyword.score, allScores) }));
  const header = ['priority', 'keyword', 'intent', 'category', 'volume', 'difficulty', 'business_value', 'score', 'recommended_action'];
  const outPath = path.join(root, 'keywords-priority.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [header.join(','), ...rows.map(row => header.map(column => csvCell(row[column])).join(','))].join('\n'));
  console.log(`Phase 3 complete: ${rows.length} keywords scored → ${outPath}`);
}

main().catch(error => { console.error('Phase 3 failed:', error.message); process.exit(1); });
