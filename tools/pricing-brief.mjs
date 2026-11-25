#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search as webSearch } from './web-search.mjs';
import { isEntry } from './is-entry.mjs';

const BEGIN = '<!-- PRICING-BRIEF:BEGIN -->';
const END = '<!-- PRICING-BRIEF:END -->';
const NOTICE = '> これは夜間の自動収集です。金額の判断に使う前に出典URLを必ず開いて確認すること。';
// claude.com は Anthropic の公式ドメイン（support.claude.com / docs.claude.com に一次情報がある）。
// 実測でリダイレクトが support.claude.com に解決され、anthropic.com だけでは公式と判定できなかった。
const OFFICIAL_HOSTS = ['openai.com', 'anthropic.com', 'claude.com', 'google.dev', 'ai.google.dev', 'groq.com', 'deepseek.com', 'openrouter.ai', 'github.com', 'z.ai'];
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
const UNRESOLVED_SUFFIX = '（出典URL未解決）';
const QUESTIONS_FILE = fileURLToPath(new URL('./pricing-brief-questions.json', import.meta.url));

function escapeCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function unescapeCell(value) {
  return value.trim().replace(/\\\|/g, '|');
}

function splitRow(line) {
  const cells = [];
  let cell = '';
  for (let i = 1; i < line.length - 1; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') { cell += '|'; i += 1; }
    else if (line[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += line[i];
  }
  cells.push(cell.trim());
  return cells;
}

export function parsePreviousRows(content = '') {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END, start + BEGIN.length);
  if (start < 0 || end < 0) return new Map();
  const rows = new Map();
  for (const line of content.slice(start + BEGIN.length, end).split(/\r?\n/)) {
    if (!line.startsWith('|') || /^\|\s*(?:項目|---)/.test(line)) continue;
    const cells = splitRow(line).map(unescapeCell);
    if (cells.length >= 5) rows.set(cells[0], { label: cells[0], understanding: cells[1], source: cells[2], date: cells[3], confidence: cells[4] });
  }
  return rows;
}

function urlString(item) {
  return typeof item === 'string' ? item : item?.url;
}

export function isOfficialUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function chooseSource(urls = []) {
  const valid = urls.map(urlString).filter((url) => {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
  });
  return valid.find(isOfficialUrl) || valid[0] || '';
}

function isGroundingRedirect(value) {
  try { return new URL(value).hostname.toLowerCase() === GROUNDING_REDIRECT_HOST; }
  catch { return false; }
}

async function resolveSource(source, fetchImpl) {
  if (!source || !isGroundingRedirect(source)) return { source, unresolved: false };
  let current = source;
  try {
    for (let redirects = 0; redirects < 2; redirects += 1) {
      const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (response.status < 300 || response.status >= 400) return { source, unresolved: true };
      const location = response.headers?.get('location');
      if (!location) return { source, unresolved: true };
      current = new URL(location, current).href;
      if (!isGroundingRedirect(current)) return { source: current, unresolved: false };
    }
  } catch {
    return { source, unresolved: true };
  }
  return { source, unresolved: true };
}

function summarize(answer) {
  const clean = String(answer ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('検索結果の本文が空です');
  const sentences = clean.match(/.*?(?:[。！？]|(?<!\d)[.!?](?=\s|$)|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [clean];
  const summary = sentences.slice(0, 2).join(' ');
  return summary.length <= 500 ? summary : `${summary.slice(0, 497)}…`;
}

function staleRow(row) {
  const suffix = '（今回更新できず）';
  return { ...row, understanding: row.understanding.endsWith(suffix) ? row.understanding : `${row.understanding}${suffix}` };
}

function render(rows) {
  const lines = [BEGIN, NOTICE, '', '| 項目 | 現時点の理解 | 出典 | 取得日 | 確度 |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${escapeCell(row.label)} | ${escapeCell(row.understanding)} | ${escapeCell(row.source)} | ${escapeCell(row.date)} | ${escapeCell(row.confidence)} |`);
  lines.push(END);
  return lines.join('\n');
}

function replaceSection(content, section) {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END, start + BEGIN.length);
  if (start >= 0 && end >= 0) return `${content.slice(0, start)}${section}${content.slice(end + END.length)}`;
  if (!content) return `${section}\n`;
  return `${content}${content.endsWith('\n') ? '' : '\n'}${section}\n`;
}

export async function runPricingBrief(options = {}) {
  const home = options.home ?? os.homedir();
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const searchImpl = options.searchImpl ?? webSearch;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const questions = options.questions ?? JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const provider = options.provider ?? 'gemini';
  const limit = options.limit ?? 8;
  const only = options.only instanceof Set ? options.only : new Set(options.only ?? []);
  const outputFile = options.outputFile ?? path.join(home, '.claude', 'pricing-brief.md');
  const previousContent = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const previous = parsePreviousRows(previousContent);
  const selected = questions.filter((question) => only.size === 0 || only.has(question.id)).slice(0, limit);
  const outcomes = new Map();
  let updated = 0;
  let failed = 0;
  const failures = [];

  for (const question of selected) {
    try {
      const result = await searchImpl(`${question.query}\n料金・利用上限の現状を日本語1〜2文で要約し、一次情報のURLを返してください。`, { provider, homeDir: home });
      const chosenSource = chooseSource(result?.urls);
      const { source, unresolved } = await resolveSource(chosenSource, fetchImpl);
      const understanding = summarize(result?.answer);
      outcomes.set(question.id, {
        label: question.label,
        understanding: unresolved ? `${understanding}${UNRESOLVED_SUFFIX}` : understanding,
        source: source || '出典なし',
        date: now.toISOString().slice(0, 10),
        confidence: unresolved ? '低' : source ? (isOfficialUrl(source) ? '高' : '中') : '低',
      });
      updated += 1;
    } catch (error) {
      failed += 1;
      failures.push({ id: question.id, message: error?.message || String(error) });
      const old = previous.get(question.label);
      if (old) outcomes.set(question.id, staleRow(old));
    }
  }

  const allFailed = selected.length > 0 && updated === 0;
  if (allFailed) return { code: 0, updated, failed, failures, provider, allFailed, body: previousContent, wrote: false, outputFile };

  const rows = [];
  for (const question of questions) {
    const outcome = outcomes.get(question.id);
    const old = previous.get(question.label);
    if (outcome) rows.push(outcome);
    else if (old) rows.push(old);
  }
  const body = render(rows);
  const nextContent = replaceSection(previousContent, body);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, nextContent);
  }
  return { code: 0, updated, failed, failures, provider, allFailed: false, body, content: nextContent, wrote: !options.dryRun, outputFile, rows };
}

export function parseArgs(argv) {
  const options = { provider: 'gemini', limit: 8, dryRun: false, json: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (['--provider', '--limit', '--only'].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} の値がありません`);
      if (arg === '--provider') {
        if (!['gemini', 'groq'].includes(value)) throw new Error('--provider は gemini|groq で指定してください');
        options.provider = value;
      } else if (arg === '--limit') {
        options.limit = Number(value);
        if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('--limit は0以上の整数で指定してください');
      } else options.only = value.split(',').map((id) => id.trim()).filter(Boolean);
    } else throw new Error(`不明なオプション: ${arg}`);
  }
  return options;
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let options;
  try { options = parseArgs(argv); } catch (error) { stderr.write(`${error.message}\n`); return 2; }
  try {
    const result = await runPricingBrief({ ...options, ...dependencies });
    for (const failure of result.failures) stderr.write(`${failure.id}: ${failure.message}\n`);
    if (result.allFailed) stderr.write('全項目の検索に失敗したため、既存ファイルを更新しませんでした。\n');
    if (options.json) stdout.write(`${JSON.stringify({ updated: result.updated, failed: result.failed, provider: result.provider, rows: result.rows ?? [] })}\n`);
    else if (options.dryRun) stdout.write(`${result.body}${result.body.endsWith('\n') ? '' : '\n'}`);
    stdout.write(`ok:更新${result.updated}件/失敗${result.failed}件 provider=${result.provider}\n`);
    return result.code;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
