#!/usr/bin/env node
/** Phase 4: コンテンツギャップ、既存ページ、内部リンクの改善提案 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const LLM_PATH = path.resolve(__dirname, '..', '..', '..', 'tools', 'llm-ask.mjs');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
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
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map(values => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatch = Array(a.length).fill(false), bMatch = Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - range); j <= Math.min(i + range, b.length - 1); j += 1) {
      if (!bMatch[j] && a[i] === b[j]) { aMatch[i] = true; bMatch[j] = true; matches += 1; break; }
    }
  }
  if (!matches) return 0;
  const aa = a.split('').filter((_, index) => aMatch[index]);
  const bb = b.split('').filter((_, index) => bMatch[index]);
  let transpositions = 0;
  for (let i = 0; i < aa.length; i += 1) if (aa[i] !== bb[i]) transpositions += 1;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function ruleBasedPageType(keyword) {
  const volume = Number(keyword.volume) || 0;
  if (keyword.intent === 'Transactional' || (keyword.intent === 'Commercial' && volume >= 50)) return 'サービスページ';
  if (keyword.intent === 'Commercial') return '事例ページ';
  return 'コラム';
}

async function recommendPageType(keyword, useLlm) {
  if (!useLlm) return ruleBasedPageType(keyword);
  const prompt = `次のキーワードに最適なページ種別を1つ選んでください。選択肢: サービスページ（高意図・高ボリューム）/ 事例ページ（高意図・低ボリューム）/ コラム（低意図・高ボリューム）\nキーワード: ${keyword.keyword}\n意図: ${keyword.intent}\n検索ボリューム: ${keyword.volume}\n回答は「サービスページ」「事例ページ」「コラム」のいずれか。`;
  try {
    const { stdout } = await execute(process.execPath, [LLM_PATH, '--provider', 'groq', '--prefer-provider', '--category', 'classification', '--max', '80', prompt], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return ['サービスページ', '事例ページ', 'コラム'].find(type => stdout.includes(type)) || ruleBasedPageType(keyword);
  } catch (error) {
    console.error(`  LLMページ種別分類失敗: ${keyword.keyword}: ${error.message}`);
    return ruleBasedPageType(keyword);
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

function normalizeUrl(value) {
  try { const url = new URL(value); url.hash = ''; return url.href.replace(/\/$/, ''); } catch { return value; }
}

function pageTopic(page) {
  return `${page.title || ''} ${page.h1 || ''} ${page.description || ''}`.trim();
}

function pageCategory(page, keywords) {
  const topic = pageTopic(page);
  return keywords.find(keyword => keyword.category && keyword.category !== '未分類' && (topic.includes(keyword.keyword) || topic.includes(keyword.category)))?.category || '未分類';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRunIndex = args.indexOf('--dry-run');
  const isDryRun = dryRunIndex >= 0;
  const outdir = isDryRun && args[dryRunIndex + 1] && !args[dryRunIndex + 1].startsWith('--') ? path.resolve(args[dryRunIndex + 1]) : null;
  if (isDryRun && !outdir) throw new Error('使用法: node process/phase4-propose.mjs --dry-run <outdir>');
  const root = isDryRun ? outdir : path.join(__dirname, '..', 'output');
  const keywords = parseCsv(fs.readFileSync(path.join(root, 'keywords-priority.csv'), 'utf-8'));
  const crawlData = JSON.parse(fs.readFileSync(path.join(root, 'crawl-results.json'), 'utf-8'));
  const orgiastPages = crawlData.filter(site => site.domain === 'https://orgiast.jp' || site.domain === 'https://orgiast.jp/').flatMap(site => site.pages);
  const topics = orgiastPages.map(page => pageTopic(page));
  const gaps = keywords.filter(keyword => Math.max(0, ...topics.map(topic => jaroWinkler(keyword.keyword, topic))) < 0.3);
  const gapTypes = await mapLimit(gaps, 5, keyword => recommendPageType(keyword, !isDryRun));
  const typeByKeyword = new Map(gaps.map((keyword, index) => [keyword.keyword, gapTypes[index]]));

  const optimizations = [];
  for (const keyword of keywords.slice(0, 10)) {
    for (const page of orgiastPages.filter(item => pageTopic(item).includes(keyword.keyword))) {
      const changes = [];
      if (!(page.title || '').includes(keyword.keyword)) changes.push(`タイトル: 「${page.title || '（未設定）'} | ${keyword.keyword}」`);
      if (!(page.h1 || '').includes(keyword.keyword)) changes.push(`H1: 「${page.h1 || '（未設定）'} | ${keyword.keyword}」`);
      if (!(page.description || '').includes(keyword.keyword)) changes.push(`meta description: 「${page.description || '（未設定）'} ${keyword.keyword}」`);
      if (changes.length) optimizations.push({ page, keyword: keyword.keyword, changes });
    }
  }

  const internalLinks = [];
  const categorizedPages = orgiastPages.map(page => ({ page, category: pageCategory(page, keywords) }));
  for (let i = 0; i < categorizedPages.length; i += 1) {
    for (let j = i + 1; j < categorizedPages.length; j += 1) {
      const source = categorizedPages[i], target = categorizedPages[j];
      if (source.category === '未分類' || source.category !== target.category) continue;
      const sourceLinks = new Set((source.page.links || []).map(normalizeUrl));
      const targetLinks = new Set((target.page.links || []).map(normalizeUrl));
      if (!sourceLinks.has(normalizeUrl(target.page.url))) internalLinks.push(`「${source.page.title || source.page.url}」から「${target.page.title || target.page.url}」へリンクを追加（${source.category}）`);
      if (!targetLinks.has(normalizeUrl(source.page.url))) internalLinks.push(`「${target.page.title || target.page.url}」から「${source.page.title || source.page.url}」へリンクを追加（${source.category}）`);
    }
  }
  const home = orgiastPages.find(page => { try { return new URL(page.url).pathname === '/'; } catch { return false; } });
  if (home) {
    const homeLinks = new Set((home.links || []).map(normalizeUrl));
    for (const page of orgiastPages.filter(item => item !== home)) {
      if (!homeLinks.has(normalizeUrl(page.url))) internalLinks.push(`トップページから「${page.title || page.url}」への導線を追加`);
      const childLinks = new Set((page.links || []).map(normalizeUrl));
      if (!childLinks.has(normalizeUrl(home.url))) internalLinks.push(`「${page.title || page.url}」からトップページへの導線を追加`);
    }
  }

  const md = [
    '# 展示会ブース制作 コンテンツ最適化提案', '',
    `生成日: ${new Date().toISOString().split('T')[0]}`, '',
    '## サマリ',
    `- 分析キーワード数: ${keywords.length}`,
    `- コンテンツギャップ: ${gaps.length}キーワード`,
    `- 自社ページ数: ${orgiastPages.length}`, '',
    '## 優先キーワード TOP20', '',
    '| 順位 | キーワード | 意図 | スコア | 推奨アクション | 推奨ページ種別 |',
    '|---|---|---|---|---|---|',
    ...keywords.slice(0, 20).map(keyword => `| ${keyword.priority} | ${keyword.keyword} | ${keyword.intent} | ${keyword.score} | ${keyword.recommended_action} | ${typeByKeyword.get(keyword.keyword) || ruleBasedPageType(keyword)} |`), '',
    '## コンテンツギャップ（未カバーの需要キーワード）', '',
    ...(gaps.length ? gaps.slice(0, 10).map((keyword, index) => `${index + 1}. **${keyword.keyword}** (意図: ${keyword.intent}, スコア: ${keyword.score}, 推奨: ${typeByKeyword.get(keyword.keyword)})`) : ['該当なし']), '',
    '## 既存ページ最適化候補', '',
    ...(optimizations.length ? optimizations.map(item => [`### ${item.page.title || item.page.url}`, `- URL: ${item.page.url}`, `- 対象キーワード: ${item.keyword}`, ...item.changes.map(change => `- ${change}`)].join('\n')) : ['上位10キーワードに該当する追加最適化候補はありません。']), '',
    '## 内部リンク改善案', '',
    ...(internalLinks.length ? [...new Set(internalLinks)].slice(0, 30).map(item => `- ${item}`) : ['現時点で追加の内部リンク改善候補はありません。']), '',
    '---', '',
    '> 本提案はAIエージェントが自動生成したものです。実装前にSEO担当者のレビューを推奨します。',
  ].join('\n');
  const outPath = path.join(root, 'content-gaps.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`Phase 4 complete → ${outPath}`);
}

main().catch(error => { console.error('Phase 4 failed:', error.message); process.exit(1); });
