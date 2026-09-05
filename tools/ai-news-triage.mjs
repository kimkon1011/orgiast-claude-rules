#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlmClient } from './line-digest.mjs';
import { search as webSearch } from './web-search.mjs';
import { isEntry } from './is-entry.mjs';

const CONFIDENCES = new Set(['low', 'medium', 'high']);
const PROVIDERS = new Set(['groq', 'deepseek']);
const TODO_HEADING = /^## 残TODO(?:（[^\r\n]*）)?[ \t]*(?=\r?$)/mu;
const PENDING_HEADING = /^### 未処理の提案 \d+件[ \t]*(?=\r?$)/mu;

export function parseArgs(args) {
  const value = (flag, fallback) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
  const limit = Number(value('--limit', 3));
  const confidence = String(value('--confidence', 'high')).split(',').filter(Boolean);
  const provider = value('--provider', 'groq');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit は1以上の整数で指定してください');
  if (!confidence.length || confidence.some((item) => !CONFIDENCES.has(item))) throw new Error('--confidence は low,medium,high の組み合わせで指定してください');
  if (!PROVIDERS.has(provider)) throw new Error('--provider は groq または deepseek を指定してください');
  return { dryRun: args.includes('--dry-run'), list: args.includes('--list'), limit, confidence: new Set(confidence), provider, id: value('--id') };
}

export function readProposalLines(text) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`提案JSONLの${index + 1}行目が不正です`); }
  });
}

function extractJson(text) {
  const clean = String(text ?? '').replace(/```(?:json)?/giu, '').replace(/```/gu, '').replace(/,\s*([}\]])/gu, '$1');
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    for (let end = clean.length; end > start; end -= 1) {
      try { return JSON.parse(clean.slice(start, end)); } catch {}
    }
  }
  throw new Error('判定JSONを復旧できません');
}

export function parseVerdict(text) {
  const value = extractJson(text);
  if (!['confirmed', 'refuted', 'unclear'].includes(value.verdict)) throw new Error('verdict が不正です');
  if (typeof value.adopt !== 'boolean') throw new Error('adopt が真偽値ではありません');
  return { verdict: value.verdict, finding: String(value.finding || '').slice(0, 120), adopt: value.adopt, reason: String(value.reason || '').slice(0, 80) };
}

export function applyTriageResult(record, result, { now = new Date(), provider } = {}) {
  const updated = { ...record, verdict: result.verdict, finding: result.finding, adopt: result.adopt, triagedAt: now.toISOString(), triageProvider: provider };
  if (result.verdict === 'unclear') {
    updated.triageAttempts = Number(record.triageAttempts || 0) + 1;
    updated.status = updated.triageAttempts >= 3 ? 'rejected' : 'pending';
  } else if (result.verdict === 'refuted' || result.adopt === false) updated.status = 'rejected';
  else updated.status = 'done';
  return updated;
}

export function appendTodo(existing, record) {
  const newline = String(existing).includes('\r\n') ? '\r\n' : '\n';
  const match = TODO_HEADING.exec(existing);
  if (!match) return { text: existing, changed: false };
  const sectionStart = match.index + match[0].length;
  const nextHeading = /^## /gmu;
  nextHeading.lastIndex = sectionStart;
  const endMatch = nextHeading.exec(existing);
  const sectionEnd = endMatch?.index ?? existing.length;
  const section = existing.slice(sectionStart, sectionEnd);
  const numbered = /^(\d+)\. /mu.exec(section);
  if (!numbered) return { text: existing, changed: false };
  const line = `${numbered[1]}. **AIニュース提案 [${record.id}]: ${record.title}** — ${record.action}`.replace(/[\r\n]+/gu, ' ');
  const insertAt = sectionStart + numbered.index;
  return { text: existing.slice(0, insertAt) + line + newline + existing.slice(insertAt), changed: true };
}

export function rewritePendingSection(existing, pending) {
  const match = PENDING_HEADING.exec(existing);
  if (!match) return { text: existing, changed: false };
  const newline = String(existing).includes('\r\n') ? '\r\n' : '\n';
  let end = match.index + match[0].length;
  while (existing.slice(end, end + newline.length) === newline) {
    const lineStart = end + newline.length;
    const lineEndRaw = existing.indexOf(newline, lineStart);
    const lineEnd = lineEndRaw < 0 ? existing.length : lineEndRaw;
    if (!existing.slice(lineStart, lineEnd).startsWith('- [P-')) break;
    end = lineEnd;
  }
  const lines = pending.map((item) => `- [${item.id}] ${item.title} — ${item.action}（確度: ${item.confidence} / 要検証）`);
  const replacement = [`### 未処理の提案 ${pending.length}件`, ...lines].join(newline);
  return { text: existing.slice(0, match.index) + replacement + existing.slice(end), changed: true };
}

function formatSearch(result) {
  return JSON.stringify({ answer: result.answer, urls: (result.urls || []).map(({ title, url }) => ({ title, url })) });
}

export async function runTriage(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const log = options.log || console.log;
  const cli = parseArgs(options.args || []);
  const base = path.join(home, '.claude');
  const proposalFile = path.join(base, 'ai-news-proposals.jsonl');
  const nextSessionFile = path.join(base, 'next-session.md');
  const digestFile = path.join(base, 'ai-news-digest.md');
  const proposalText = fs.existsSync(proposalFile) ? fs.readFileSync(proposalFile, 'utf8') : '';
  const records = readProposalLines(proposalText);

  if (cli.list) {
    records.filter((item) => item.triagedAt).forEach((item) => log(`${item.id} ${item.verdict} adopt=${item.adopt} status=${item.status} ${item.finding || ''}`));
    return { status: 'ok:一覧', processed: 0 };
  }

  const pending = records.filter((item) => item.status === 'pending');
  const targets = cli.id
    ? pending.filter((item) => item.id === cli.id).slice(0, 1)
    : pending.filter((item) => cli.confidence.has(item.confidence)).slice(0, cli.limit);
  if (!targets.length) return { status: 'skip:対象なし', processed: 0 };

  const search = options.search || ((query) => webSearch(query, { provider: 'auto', homeDir: home, fetchImpl: options.fetchImpl, geminiApiKey: options.geminiApiKey, groqApiKey: options.groqApiKey, appendUsage: options.appendUsage }));
  const llm = options.llm || createLlmClient({ home, fetchImpl: options.fetchImpl, usageFile: path.join(base, 'executor-usage.jsonl') });
  const now = options.now || (() => new Date());
  const updates = new Map();
  const adopted = [];
  const system = 'LINE投稿由来の提案を検索結果だけから検証する。検索結果に無いことを書かない。不明なら必ず unclear と書く。verdictは投稿内容が裏取りできたか、adoptはオージャストのコスト削減または品質向上に直結し実際に手を打つ価値があるかで決める。JSONのみを返す。形式: {"verdict":"confirmed|refuted|unclear","finding":"120字以内の日本語","adopt":true|false,"reason":"80字以内"}';
  for (const record of targets) {
    const found = await search(`${record.title}\n${record.action}`);
    const response = await llm({ provider: cli.provider, messages: [{ role: 'system', content: system }, { role: 'user', content: `提案: ${JSON.stringify({ title: record.title, action: record.action, evidence: record.evidence })}\n検索結果: ${formatSearch(found)}` }], maxTokens: 500, responseFormat: { type: 'json_object' } });
    const result = parseVerdict(response.text);
    const updated = applyTriageResult(record, result, { now: now(), provider: response.provider || cli.provider });
    updates.set(record.id, updated);
    if (updated.status === 'done' && updated.adopt === true) adopted.push(updated);
    log(`${cli.dryRun ? '[dry-run] ' : ''}${record.id} ${updated.verdict} adopt=${updated.adopt} → ${updated.status}: ${updated.finding}`);
  }

  const nextRecords = records.map((item) => updates.get(item.id) || item);
  const counts = { done: 0, rejected: 0, pending: 0 };
  for (const item of updates.values()) counts[item.status] += 1;
  const status = `ok:検証${updates.size}件 done${counts.done} rejected${counts.rejected} pending${counts.pending}`;
  const warnings = [];
  let nextSessionText = fs.existsSync(nextSessionFile) ? fs.readFileSync(nextSessionFile, 'utf8') : '';
  for (const item of adopted) {
    const result = appendTodo(nextSessionText, item);
    nextSessionText = result.text;
    if (!result.changed) warnings.push('warn:next-session.md の TODO セクションが見つかりません');
  }
  const digestText = fs.existsSync(digestFile) ? fs.readFileSync(digestFile, 'utf8') : '';
  const digestResult = rewritePendingSection(digestText, nextRecords.filter((item) => item.status === 'pending'));

  if (!cli.dryRun) {
    fs.writeFileSync(proposalFile, nextRecords.map(JSON.stringify).join('\n') + (nextRecords.length ? '\n' : ''), 'utf8');
    if (adopted.length && nextSessionText && !warnings.length) fs.writeFileSync(nextSessionFile, nextSessionText, 'utf8');
    if (digestResult.changed) fs.writeFileSync(digestFile, digestResult.text, 'utf8');
  }
  [...new Set(warnings)].forEach(log);
  return { status, processed: updates.size, records: nextRecords };
}

export async function runCli(args, options = {}) {
  const log = options.log || console.log;
  try {
    const result = await runTriage({ ...options, args, log });
    log(result.status);
  } catch (error) {
    log(`error:${error.message}`);
  }
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
