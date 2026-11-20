#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';

export const DEFAULT_BRANDS = ['オージャスト', 'リブース'];
export const DEFAULT_PROVIDERS = ['gemini', 'deepseek', 'groq'];
export const BRAND_DOMAINS = Object.freeze({
  オージャスト: ['orgiast.jp'],
  リブース: ['rebooth.co.jp'],
});
export const SYSTEM_PROMPT = 'あなたは有益な情報を提供するアシスタントです。以下の質問に対して、具体的な企業名やサービス名を含めて回答してください。回答の末尾には、参考にした情報源のURLがあれば列挙してください。';

const execFileAsync = promisify(execFile);
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const llmAsk = path.join(toolsDir, 'llm-ask.mjs');

function list(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

export function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  const known = new Set(['--question', '--questions-file', '--brand', '--competitors', '--providers', '--output']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!known.has(flag)) throw new Error(`不明なオプションです: ${flag}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} に値が必要です`);
    values[flag.slice(2)] = value;
    i += 1;
  }
  if (Boolean(values.question) === Boolean(values['questions-file'])) {
    throw new Error('--question または --questions-file のどちらか一方を指定してください');
  }
  const output = (values.output || 'markdown').toLowerCase();
  if (!['markdown', 'json'].includes(output)) throw new Error('--output は markdown または json を指定してください');
  const providers = unique(list(values.providers || DEFAULT_PROVIDERS.join(',')));
  if (!providers.length) throw new Error('--providers に1件以上指定してください');
  return {
    question: values.question || null,
    questionsFile: values['questions-file'] || null,
    brand: values.brand || 'オージャスト',
    competitors: unique(list(values.competitors || 'リブース')),
    providers,
    output,
  };
}

// RFC 4180相当の引用符を扱う。competitors列だけは末尾まで結合し、設計書の
// 「...,オージャスト,リブース,クラフト」のような未引用CSVも受け入れる。
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('CSVの引用符が閉じていません');
  if (field || row.length) { row.push(field); if (row.some(cell => cell.trim())) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(header => header.trim().toLowerCase());
  const questionIndex = headers.indexOf('question');
  if (questionIndex < 0) throw new Error('CSVに question ヘッダーが必要です');
  const competitorsIndex = headers.indexOf('competitors');
  return rows.map((cells, index) => {
    const record = {};
    headers.forEach((header, column) => {
      record[header] = competitorsIndex === column
        ? cells.slice(column).join(',').trim()
        : String(cells[column] ?? '').trim();
    });
    if (!record.question) throw new Error(`CSV ${index + 2}行目の question が空です`);
    return record;
  });
}

export function loadQuestions(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

function normalized(value) {
  return String(value).normalize('NFKC').toLowerCase();
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractUrls(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"'）)\]}]+/giu) || [];
  return unique(matches.map(url => url.replace(/[.,;:!?、。]+$/u, '')));
}

export function detectBrands(text, brands) {
  const raw = String(text);
  const haystack = normalized(raw);
  const urls = extractUrls(raw);
  return unique(brands).map(brand => {
    const needle = normalized(brand);
    const occurrences = haystack.match(new RegExp(escaped(needle), 'gu')) || [];
    const exactMatch = occurrences.length > 0;
    const companyPattern = new RegExp(`(?:株式会社|\\(株\\))\\s*${escaped(needle)}|${escaped(needle)}\\s*(?:株式会社|\\(株\\))`, 'u');
    const partialMatch = companyPattern.test(haystack);
    const domains = BRAND_DOMAINS[brand] || [];
    const urlMatch = urls.some(url => domains.some(domain => {
      try { return new URL(url).hostname.toLowerCase() === domain || new URL(url).hostname.toLowerCase().endsWith(`.${domain}`); }
      catch { return normalized(url).includes(domain); }
    }));
    return { brand, mentioned: exactMatch || partialMatch || urlMatch, exactMatch, partialMatch, urlMatch, count: occurrences.length };
  });
}

export function buildCrossTab(results, brands, providers = results.map(result => result.provider)) {
  return Object.fromEntries(unique(brands).map(brand => {
    const cells = Object.fromEntries(providers.map(provider => {
      const result = results.find(item => item.provider === provider);
      return [provider, Boolean(result?.brands?.find(item => item.brand === brand)?.mentioned)];
    }));
    const count = Object.values(cells).filter(Boolean).length;
    return [brand, { ...cells, appearanceRate: `${count}/${providers.length}` }];
  }));
}

export async function askProvider(provider, systemPrompt, userPrompt) {
  const { stdout } = await execFileAsync(process.execPath, [llmAsk, '--provider', provider, '--system', systemPrompt, '--prompt', userPrompt], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function analyzeQuestion({ question, brand = 'オージャスト', competitors = ['リブース'], providers = DEFAULT_PROVIDERS, ask = askProvider, timestamp = new Date().toISOString() }) {
  const brands = unique([...DEFAULT_BRANDS, brand, ...competitors]);
  const results = await Promise.all(providers.map(async provider => {
    try {
      const response = await ask(provider, SYSTEM_PROMPT, question);
      return { provider, responseSnippet: response.slice(0, 500), brands: detectBrands(response, brands), citedUrls: extractUrls(response) };
    } catch (error) {
      return { provider, error: String(error?.message || error), responseSnippet: '', brands: detectBrands('', brands), citedUrls: [] };
    }
  }));
  if (results.every(result => result.error)) {
    const error = new Error('全プロバイダへの問い合わせに失敗しました');
    error.results = results;
    throw error;
  }
  const crossTab = buildCrossTab(results, brands, providers);
  const selfMentionCount = providers.filter(provider => crossTab[brand][provider]).length;
  const ranked = competitors.map(competitor => ({ brand: competitor, count: providers.filter(provider => crossTab[competitor]?.[provider]).length }))
    .filter(item => item.count > 0).sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand, 'ja'));
  return {
    question, timestamp, results, crossTab,
    gapAnalysis: {
      selfBrand: brand, selfMentionCount, totalProviders: providers.length,
      topCompetitors: ranked.filter(item => item.count === ranked[0]?.count).map(item => item.brand),
      priorityActions: ['施工事例ページの強化', '「おすすめ」クエリに対応する比較記事作成'],
    },
  };
}

function cell(value) { return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }

export function formatMarkdown(report) {
  const providers = report.results.map(result => result.provider);
  const competitors = Object.keys(report.crossTab).filter(brand => brand !== report.gapAnalysis.selfBrand);
  const lines = ['# AI引用ブランド言及分析レポート', '', `> 質問: "${report.question}"`, '', '## 質問結果サマリー', `| AIプロバイダ | 言及ブランド数 | 自社(${cell(report.gapAnalysis.selfBrand)}) | 競合言及 | 引用URL数 |`, '|---|:---:|:---:|---|:---:|'];
  for (const result of report.results) {
    if (result.error) { lines.push(`| ${cell(result.provider)} | エラー | エラー | ${cell(result.error)} | 0 |`); continue; }
    const mentioned = result.brands.filter(item => item.mentioned);
    const rivalNames = mentioned.filter(item => item.brand !== report.gapAnalysis.selfBrand).map(item => item.brand);
    const own = mentioned.some(item => item.brand === report.gapAnalysis.selfBrand) ? '✅ あり' : '❌ なし';
    lines.push(`| ${cell(result.provider)} | ${mentioned.length} | ${own} | ${cell(rivalNames.join(', ') || 'なし')} | ${result.citedUrls.length} |`);
  }
  lines.push('', '## ブランド別クロス集計', '', `| ブランド | ${providers.map(cell).join(' | ')} | 出現率 |`, `|---|${providers.map(() => ':---:').join('|')}|:---:|`);
  for (const [brand, values] of Object.entries(report.crossTab)) lines.push(`| ${cell(brand)} | ${providers.map(provider => values[provider] ? '✅' : '❌').join(' | ')} | ${values.appearanceRate} |`);
  lines.push('', '## ギャップ分析', '', `- 自社(${report.gapAnalysis.selfBrand}): ${report.gapAnalysis.totalProviders} AI 中 ${report.gapAnalysis.selfMentionCount} AI で言及`, `- 競合上位: ${report.gapAnalysis.topCompetitors.join(', ') || 'なし'}`, `- 優先アクション: ${report.gapAnalysis.priorityActions.join('、')}`);
  if (competitors.length === 0) lines.push('- 競合ブランドは指定されていません');
  return lines.join('\n');
}

export async function runCli(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArgs(argv);
    const rows = options.question ? [{ question: options.question }] : loadQuestions(options.questionsFile);
    if (!rows.length) throw new Error('分析する質問がありません');
    const reports = [];
    for (const row of rows) {
      reports.push(await analyzeQuestion({
        question: row.question,
        brand: row.brand || options.brand,
        competitors: row.competitors ? list(row.competitors) : options.competitors,
        providers: options.providers,
      }));
    }
    const output = options.output === 'json'
      ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)
      : reports.map(formatMarkdown).join('\n\n---\n\n');
    io.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`エラー: ${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli();
