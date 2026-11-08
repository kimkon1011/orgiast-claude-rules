#!/usr/bin/env node
/** Phase 2: クロール結果とGSC CSVからキーワードを収集・統合 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const STOP_WORDS = new Set(['オージャスト', '一覧', '株式会社', '株式会社オージャスト', 'サービス', 'メニュー']);

function extractKeywords(text) {
  if (!text) return [];
  const candidates = [];
  for (const phrase of text.match(/[一-龯々〆ヵヶァ-ヶー]{2,}/g) || []) candidates.push(phrase);
  const tokens = [...text.matchAll(/[一-龯々〆ヵヶ]{2,}|[ァ-ヶー]{2,}/g)].map(match => ({ text: match[0], index: match.index }));
  for (const token of tokens) candidates.push(token.text);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const between = text.slice(tokens[i].index + tokens[i].text.length, tokens[i + 1].index);
    if (!/[。！？!?\n]/.test(between)) candidates.push(tokens[i].text + tokens[i + 1].text);
  }
  return [...new Set(candidates)].filter(word => word.length >= 2 && !STOP_WORDS.has(word)).map(word => ({ text: word }));
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatch = Array(a.length).fill(false);
  const bMatch = Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - range); j <= Math.min(i + range, b.length - 1); j += 1) {
      if (!bMatch[j] && a[i] === b[j]) { aMatch[i] = true; bMatch[j] = true; matches += 1; break; }
    }
  }
  if (!matches) return 0;
  const aChars = a.split('').filter((_, i) => aMatch[i]);
  const bChars = b.split('').filter((_, i) => bMatch[i]);
  let transpositions = 0;
  for (let i = 0; i < aChars.length; i += 1) if (aChars[i] !== bChars[i]) transpositions += 1;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function mergeKeywords(keywords, threshold = 0.8) {
  const merged = [];
  for (const keyword of keywords) {
    let target = merged.find(item => item.text === keyword.text);
    if (!target) target = merged.find(item => jaroWinkler(item.text, keyword.text) >= threshold);
    const source = Array.isArray(keyword.source) ? keyword.source : [keyword.source].filter(Boolean);
    if (!target) {
      merged.push({ ...keyword, volume: keyword.volume ?? 1, crawlVolume: keyword.gsc ? 0 : (keyword.volume ?? 1), gscVolume: keyword.gsc ? (keyword.volume ?? 0) : 0, source: [...new Set(source)] });
      continue;
    }
    if (keyword.text.length > target.text.length) target.text = keyword.text;
    target.crawlVolume += keyword.gsc ? 0 : (keyword.volume ?? 1);
    target.gscVolume += keyword.gsc ? (keyword.volume ?? 0) : 0;
    target.volume = target.gscVolume > 0 ? target.gscVolume : target.crawlVolume;
    target.source = [...new Set([...target.source, ...source])];
  }
  return merged.map(({ crawlVolume, gscVolume, gsc, ...keyword }) => ({ ...keyword, volume: gscVolume > 0 ? gscVolume : crawlVolume }));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); if (row.some(value => value !== '')) rows.push(row); row = []; field = '';
    } else field += char;
  }
  row.push(field); if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

function readGscKeywords(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, ''));
  if (!rows.length) return [];
  const header = rows[0].map(value => value.trim().toLowerCase());
  const queryIndex = header.findIndex(value => value === 'top queries' || value === 'queries' || value === 'query');
  const clicksIndex = header.indexOf('clicks');
  const impressionsIndex = header.indexOf('impressions');
  if (queryIndex < 0) throw new Error('GSC CSVにTop queries列がありません');
  return rows.slice(1).flatMap(row => {
    const query = row[queryIndex]?.trim();
    if (!query) return [];
    const clicks = Number(String(row[clicksIndex] || '').replace(/,/g, '')) || 0;
    const impressions = Number(String(row[impressionsIndex] || '').replace(/,/g, '')) || 0;
    return [{ text: query, volume: impressions || clicks || 1, clicks, impressions, source: 'GSC', gsc: true }];
  });
}

async function mapLimit(items, limit, mapper) {
  const result = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; result[index] = await mapper(items[index], index); }
  }));
  return result;
}

async function classifyCategory(keyword, categories) {
  const prompt = `次のキーワードを最も近いカテゴリに分類してください。\n選択肢: ${categories.join(' / ')}\nキーワード: ${keyword}\n回答は選択肢のカテゴリ名1つのみでお願いします。`;
  const llmPath = path.resolve(__dirname, '..', '..', '..', 'tools', 'llm-ask.mjs');
  try {
    const { stdout } = await execute(process.execPath, [llmPath, '--provider', 'groq', '--prefer-provider', '--category', 'classification', '--max', '80', prompt], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return categories.find(category => stdout.trim().includes(category)) || '未分類';
  } catch (error) {
    console.error(`  LLMカテゴリ分類失敗: ${keyword}: ${error.message}`);
    return '未分類';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRunIndex = args.indexOf('--dry-run');
  const gscIndex = args.indexOf('--gsc-csv');
  const isDryRun = dryRunIndex >= 0;
  const outdir = isDryRun && args[dryRunIndex + 1] && !args[dryRunIndex + 1].startsWith('--') ? path.resolve(args[dryRunIndex + 1]) : null;
  if (isDryRun && !outdir) throw new Error('使用法: node process/phase2-collect.mjs --dry-run <outdir> [--gsc-csv <path>]');
  if (gscIndex >= 0 && (!args[gscIndex + 1] || args[gscIndex + 1].startsWith('--'))) throw new Error('--gsc-csvにはCSVパスが必要です');
  const root = isDryRun ? outdir : path.join(__dirname, '..', 'output');
  const crawlData = JSON.parse(fs.readFileSync(path.join(root, 'crawl-results.json'), 'utf-8'));
  const bizValue = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'business-value.json'), 'utf-8'));
  let allKeywords = [];
  for (const site of crawlData) {
    for (const page of site.pages) {
      const extracted = extractKeywords(`${page.title || ''} ${page.h1 || ''} ${page.description || ''}`);
      allKeywords.push(...extracted.map(keyword => ({ ...keyword, source: site.domain, url: page.url, volume: 1 })));
    }
  }
  if (gscIndex >= 0) allKeywords.push(...readGscKeywords(path.resolve(args[gscIndex + 1])));
  let threshold = 0.8;
  try { threshold = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'adjustment-params.json'), 'utf-8')).keyword_merge?.similarity_threshold ?? 0.8; } catch { /* 既定値 */ }
  const merged = mergeKeywords(allKeywords, threshold);
  const categoryMap = bizValue.keyword_category_map;
  const categories = bizValue.services.map(service => service.category);
  const categorized = merged.map(keyword => ({
    ...keyword,
    category: Object.entries(categoryMap).find(([key]) => keyword.text.includes(key))?.[1] || '未分類',
  }));
  if (!isDryRun) {
    const unknown = categorized.filter(keyword => keyword.category === '未分類');
    const classified = await mapLimit(unknown, 5, keyword => classifyCategory(keyword.text, categories));
    unknown.forEach((keyword, index) => { keyword.category = classified[index]; });
  }
  const outPath = path.join(root, 'raw-keywords.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(categorized, null, 2));
  console.log(`Phase 2 complete: ${categorized.length} unique keywords → ${outPath}`);
}

main().catch(error => { console.error('Phase 2 failed:', error.message); process.exit(1); });
