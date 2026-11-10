#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isEntry } from './is-entry.mjs';

const DEFAULT_DAYS = 30;
const CHARS_PER_TOKEN = 4;

// USD per one million tokens. These are deliberately editable estimates, not invoices.
export const MODEL_PRICES = Object.freeze({
  'deepseek-v4-flash': { input: 0.10, output: 0.40 },
  'deepseek-v3.2': { input: 0.28, output: 0.42 },
  'deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek-reasoner': { input: 0.28, output: 0.42 },
  'gemini-3.6-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gpt-5': { input: 1.25, output: 10.00 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-opus-4-1': { input: 15.00, output: 75.00 },
  unknown: { input: 1.00, output: 5.00 },
});

function parseArgs(argv) {
  const options = { days: DEFAULT_DAYS, format: 'text' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json' || value === '--csv') {
      if (options.format !== 'text') throw new Error('--json と --csv は同時に指定できません');
      options.format = value.slice(2);
    } else if (value === '--days') {
      const days = Number(argv[++index]);
      if (!Number.isInteger(days) || days < 1) throw new Error('--days は1以上の整数で指定してください');
      options.days = days;
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    } else {
      throw new Error(`不明な引数: ${value}`);
    }
  }
  return options;
}

function textLength(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item), 0);
  if (!value || typeof value !== 'object') return 0;
  if (typeof value.text === 'string') return value.text.length;
  if (value.type === 'tool_result') return textLength(value.content);
  if (value.type === 'thinking' && typeof value.thinking === 'string') return value.thinking.length;
  return 0;
}

function normalizeModel(value) {
  const model = String(value || 'unknown').toLowerCase();
  const exact = Object.keys(MODEL_PRICES).find((key) => key !== 'unknown' && model.includes(key));
  if (exact) return exact;
  if (model.includes('opus')) return 'claude-opus-4-1';
  if (model.includes('sonnet')) return 'claude-sonnet-4-5';
  if (model.includes('haiku')) return 'claude-haiku-4-5';
  return model === 'unknown' ? model : `unknown:${model}`;
}

function priceFor(model) {
  return MODEL_PRICES[model] || MODEL_PRICES.unknown;
}

function tokenEstimate(characters) {
  return Math.ceil(characters / CHARS_PER_TOKEN);
}

function cost(inputTokens, outputTokens, model) {
  const price = priceFor(model);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

async function jsonlFiles(root) {
  const files = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    for (const entry of await readdir(projectPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ file: path.join(projectPath, entry.name), project: project.name });
      }
    }
  }
  return files;
}

async function readSession(entry, cutoff, warn) {
  const fileStat = await stat(entry.file);
  if (fileStat.mtime < cutoff) return null;
  const session = {
    session: path.basename(entry.file, '.jsonl'), project: entry.project,
    startedAt: null, endedAt: null, messages: 0, inputTokens: 0, outputTokens: 0,
    estimatedCostUsd: 0, models: {}, parseErrors: 0,
  };
  let pendingInput = 0;
  const lines = readline.createInterface({ input: createReadStream(entry.file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      session.parseErrors += 1;
      warn(`${entry.file}:${lineNumber}: JSONを読み飛ばしました (${error.message})`);
      continue;
    }
    const timestamp = Date.parse(record.timestamp);
    if (Number.isFinite(timestamp) && timestamp < cutoff.getTime()) continue;
    if (Number.isFinite(timestamp)) {
      const iso = new Date(timestamp).toISOString();
      session.startedAt ||= iso;
      session.endedAt = iso;
    }
    const role = record.message?.role || (record.type === 'user' || record.type === 'assistant' ? record.type : null);
    if (role !== 'user' && role !== 'assistant') continue;
    session.messages += 1;
    const characters = textLength(record.message?.content ?? record.content);
    if (role === 'user') {
      pendingInput += characters;
      continue;
    }
    const model = normalizeModel(record.message?.model || record.model);
    const inputTokens = tokenEstimate(pendingInput);
    const outputTokens = tokenEstimate(characters);
    pendingInput = 0;
    const modelCost = cost(inputTokens, outputTokens, model);
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.estimatedCostUsd += modelCost;
    session.models[model] ||= { messages: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    const modelRow = session.models[model];
    modelRow.messages += 1;
    modelRow.inputTokens += inputTokens;
    modelRow.outputTokens += outputTokens;
    modelRow.estimatedCostUsd += modelCost;
  }
  if (pendingInput) {
    const inputTokens = tokenEstimate(pendingInput);
    session.inputTokens += inputTokens;
    session.models.unknown ||= { messages: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    session.models.unknown.inputTokens += inputTokens;
    const pendingCost = cost(inputTokens, 0, 'unknown');
    session.models.unknown.estimatedCostUsd += pendingCost;
    session.estimatedCostUsd += pendingCost;
  }
  return session.messages ? session : null;
}

function addAggregate(map, key, values) {
  map[key] ||= { messages: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  for (const field of Object.keys(map[key])) map[key][field] += values[field] || 0;
}

export async function buildReport({ days = DEFAULT_DAYS, root = path.join(os.homedir(), '.claude', 'projects'), now = new Date(), warn = console.error } = {}) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const sessions = [];
  for (const entry of await jsonlFiles(root)) {
    try {
      const session = await readSession(entry, cutoff, warn);
      if (session) sessions.push(session);
    } catch (error) {
      warn(`${entry.file}: 読み取りに失敗しました (${error.message})`);
    }
  }
  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const byDay = {}, byProject = {}, byModel = {};
  for (const session of sessions) {
    const values = { ...session };
    addAggregate(byDay, session.startedAt?.slice(0, 10) || 'unknown', values);
    addAggregate(byProject, session.project, values);
    for (const [model, modelValues] of Object.entries(session.models)) addAggregate(byModel, model, modelValues);
  }
  const totals = Object.values(byProject).reduce((sum, row) => {
    addAggregate({ sum }, 'sum', row);
    return sum;
  }, { messages: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  return { generatedAt: now.toISOString(), days, cutoff: cutoff.toISOString(), root, assumptions: { charsPerToken: CHARS_PER_TOKEN, pricesUsdPerMillionTokens: MODEL_PRICES }, totals: { sessions: sessions.length, ...totals }, sessions, byDay, byProject, byModel };
}

function csvEscape(value) {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function toCsv(report) {
  const rows = [['scope', 'key', 'messages', 'input_tokens', 'output_tokens', 'estimated_cost_usd']];
  for (const scope of ['byDay', 'byProject', 'byModel']) {
    for (const [key, row] of Object.entries(report[scope])) rows.push([scope, key, row.messages, row.inputTokens, row.outputTokens, row.estimatedCostUsd.toFixed(8)]);
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

function table(title, rows) {
  const lines = [`\n${title}`, 'key\tmessages\tinput\toutput\tcost_usd'];
  for (const [key, row] of Object.entries(rows)) lines.push(`${key}\t${row.messages}\t${row.inputTokens}\t${row.outputTokens}\t$${row.estimatedCostUsd.toFixed(6)}`);
  return lines.join('\n');
}

function toText(report) {
  const total = report.totals;
  return [
    `Token cost report: last ${report.days} days (${total.sessions} sessions)`,
    `Messages ${total.messages} | input ~${total.inputTokens} | output ~${total.outputTokens} | cost ~$${total.estimatedCostUsd.toFixed(6)}`,
    'Estimate: 4 characters/token; prices are editable approximations, not provider invoices.',
    table('By day', report.byDay), table('By project', report.byProject), table('By model', report.byModel),
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`token-cost-report: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log('Usage: node tools/token-cost-report.mjs [--days N] [--json | --csv]');
    return 0;
  }
  const report = await buildReport({ days: options.days });
  console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : options.format === 'csv' ? toCsv(report) : toText(report));
  return 0;
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main();
}
