#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isEntry } from './is-entry.mjs';
import { walkJsonl } from './usage-stats.mjs';

const DAY = 864e5;

// Read ツールの出力は「行番号<TAB>本文」(cat -n 形式)。剥がさずに判定すると
// 全ての Read 結果が tsv と誤検出され、ソースコードや Markdown が
// 「一括データ」として上位を占める(2026-08-27 実測で確認)。
export function stripLineNumbers(text) {
  const lines = String(text || '').split(/\r?\n/), nonEmpty = lines.filter((line) => line.trim());
  if (!nonEmpty.length) return String(text || '');
  const numbered = nonEmpty.filter((line) => /^\s*\d+(?:\t|→)/.test(line)).length;
  if (numbered / nonEmpty.length < 0.7) return String(text || '');
  return lines.map((line) => line.replace(/^\s*\d+(?:\t|→)/, '')).join('\n');
}

export function getBulkKind(text, minChars = 2000) {
  text = stripLineNumbers(typeof text === 'string' ? text : '');
  if (text.length < minChars) return null;
  const lines = text.split(/\r?\n/), nonEmpty = lines.filter((line) => line.trim());
  const delimited = (separator, minColumns) => {
    const counts = new Map();
    for (const line of nonEmpty) {
      const columns = line.split(separator).length;
      if (columns >= minColumns) counts.set(columns, (counts.get(columns) || 0) + 1);
    }
    const mode = Math.max(0, ...counts.values());
    return mode >= 5 && mode / nonEmpty.length >= 0.7;
  };
  if (delimited(',', 3)) return 'csv';
  if (delimited('\t', 2)) return 'tsv';
  let consecutive = 0, hasSeparator = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed)) {
      consecutive++;
      if (/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|$/.test(trimmed)) hasSeparator = true;
      if (consecutive >= 5 && hasSeparator) return 'markdown-table';
    } else { consecutive = 0; hasSeparator = false; }
  }
  const trimmed = text.trim();
  try {
    const value = JSON.parse(trimmed);
    if (Array.isArray(value) && value.length >= 5 && value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).length > value.length / 2) return 'json-array';
  } catch {}
  if (trimmed.startsWith('[{') && trimmed.endsWith('}]') && (trimmed.match(/}\s*,\s*{/g) || []).length >= 5) return 'json-array';
  return null;
}

export function estimateTokens(text) {
  let ascii = 0, nonAscii = 0;
  for (const char of String(text || '')) char.codePointAt(0) <= 0x7f ? ascii++ : nonAscii++;
  return Math.ceil(ascii / 4 + nonAscii / 1.6);
}

export function normalizeSignature(value) {
  return String(value || '')
    .slice(0, 160)
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    // ディレクトリだけ伏せて basename は残す。全部 <PATH> にすると Read/Glob が
    // 1グループへ潰れ、「どの呼び出しを置き換えるか」が読めなくなる。
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`]+[\\/])*([^\s'"`\/]*)/g, '<PATH>/$1')
    .replace(/\d{3,}/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toolAttribution(block, tools) {
  const match = tools.get(block?.tool_use_id);
  if (!match) return { tool: '(unknown)', signature: '(unmatched tool_result)' };
  const tool = String(match.name || '(unknown)');
  let raw = '';
  if (tool === 'Bash' || tool === 'PowerShell') raw = match.input?.command;
  else if (['Read', 'Glob', 'Grep'].includes(tool)) raw = match.input?.file_path || match.input?.pattern;
  return { tool, signature: raw ? normalizeSignature(raw) : tool };
}

function resultTexts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
}

async function forEachRow(file, visit) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      await visit(row);
    }
  } finally { lines.close(); input.destroy(); }
}

export async function collectBulkPayloads({ home = process.env.ORGIAST_HOME || os.homedir(), days = 30, now = Date.now(), minChars = 2000 } = {}) {
  const cutoff = now - days * DAY, payloads = []; let skippedFiles = 0;
  for (const file of walkJsonl(path.join(home, '.claude', 'projects'))) {
    let requestTotal = 0, lastRequestKey = null; const tools = new Map();
    // 1リクエストが thinking/text/tool_use の複数行に分割されるので、行数ではなく
    // requestId の変化でリクエストを数える(kim-PC実測 assistant 250行 = 107リクエスト)。
    const requestKey = (row, index) => row.requestId || row?.message?.id || row.uuid || ('#' + index);
    let scanIndex = 0;
    try {
      await forEachRow(file, (row) => {
        const key = requestKey(row, scanIndex++);
        if (row?.type !== 'assistant') return;
        if (key !== lastRequestKey) { requestTotal++; lastRequestKey = key; }
        const content = Array.isArray(row?.message?.content) ? row.message.content : [];
        for (const block of content) if (block?.type === 'tool_use' && block.id) tools.set(block.id, block);
      });
      let requestsSeen = 0, seenKey = null, replayIndex = 0;
      await forEachRow(file, (row) => {
        const key = requestKey(row, replayIndex++);
        if (row?.type === 'assistant') { if (key !== seenKey) { requestsSeen++; seenKey = key; } return; }
        if (row?.type !== 'user') return;
        const timestampMs = Date.parse(row.timestamp || '');
        if (!Number.isFinite(timestampMs) || timestampMs < cutoff) return;
        const content = row?.message?.content;
        const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
        for (const block of blocks) {
          let texts, attribution;
          if (block?.type === 'tool_result') { texts = resultTexts(block.content); attribution = toolAttribution(block, tools); }
          else if (block?.type === 'text' && typeof block.text === 'string') { texts = [block.text]; attribution = { tool: '(user paste)', signature: '(user paste)' }; }
          else continue;
          for (const text of texts) {
            const kind = getBulkKind(text, minChars); if (!kind) continue;
            const tokens = estimateTokens(text), repeats = Math.max(1, requestTotal - requestsSeen);
            payloads.push({ kind, ...attribution, chars: text.length, tokens, repeats, amplifiedTokens: tokens * repeats, timestamp: new Date(timestampMs).toISOString(), session: path.basename(file, '.jsonl'), file });
          }
        }
      });
    } catch (error) {
      skippedFiles++;
      process.stderr.write(`bulk-context-audit: 読み込めないファイルをスキップ: ${file} (${error.message})\n`);
    }
  }
  if (skippedFiles) process.stderr.write(`bulk-context-audit: ${skippedFiles}ファイルをスキップしました\n`);
  return payloads;
}

export function groupPayloads(payloads) {
  const grouped = new Map();
  for (const payload of payloads) {
    const key = JSON.stringify([payload.kind, payload.tool, payload.signature]);
    const group = grouped.get(key) || { kind: payload.kind, tool: payload.tool, signature: payload.signature, hits: 0, tokens: 0, amplifiedTokens: 0, latest: '', maxTokens: 0, session: '' };
    group.hits++; group.tokens += payload.tokens; group.amplifiedTokens += payload.amplifiedTokens;
    if (!group.latest || payload.timestamp > group.latest) group.latest = payload.timestamp;
    if (payload.tokens > group.maxTokens) { group.maxTokens = payload.tokens; group.session = payload.session; }
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((a, b) => b.amplifiedTokens - a.amplifiedTokens || b.tokens - a.tokens);
}

export function formatReport(groups, totals, { days = 30, minChars = 2000, top = 20 } = {}) {
  const number = (value) => Math.round(value).toLocaleString('en-US');
  const lines = [
    `## 一括データを context へ貼っている箇所（直近${days}日・最小${minChars}文字）`,
    `検出 ${number(totals.totalHits)} 件 / 生 ${number(totals.totalTokens)} tok / 増幅後 ${number(totals.totalAmplified)} tok（後続リクエストでの再送を含む）`,
  ];
  groups.slice(0, top).forEach((group, index) => {
    const repeats = group.tokens ? Math.round(group.amplifiedTokens / group.tokens) : 0;
    lines.push('', `  ${index + 1}. [${group.kind}] ${group.tool} — 増幅 ${number(group.amplifiedTokens)} tok (生 ${number(group.tokens)} tok × ${repeats}回) / ${group.hits}件`);
    lines.push(`     ${group.signature}`);
    lines.push(`     最新: ${group.latest.slice(0, 10)} / 最大単発: ${number(group.maxTokens)} tok / session ${group.session.slice(0, 8)}`);
  });
  return lines.join('\n');
}

function parseArgs(args) {
  const read = (name, fallback) => { const i = args.indexOf(name); const inline = args.find((arg) => arg.startsWith(`${name}=`)); return inline ? inline.slice(name.length + 1) : i >= 0 ? args[i + 1] : fallback; };
  return { days: Number(read('--days', 30)) || 30, minChars: Number(read('--min-chars', 2000)) || 2000, top: Number(read('--top', 20)) || 20, home: read('--home', process.env.ORGIAST_HOME || os.homedir()), json: args.includes('--json') };
}

if (isEntry(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const payloads = await collectBulkPayloads(opts), groups = groupPayloads(payloads).slice(0, opts.top);
  const totals = { totalHits: payloads.length, totalTokens: payloads.reduce((sum, item) => sum + item.tokens, 0), totalAmplified: payloads.reduce((sum, item) => sum + item.amplifiedTokens, 0) };
  if (opts.json) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), days: opts.days, minChars: opts.minChars, ...totals, groups }, null, 2));
  else console.log(formatReport(groups, totals, opts));
}
