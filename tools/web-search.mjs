#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODELS = { gemini: 'gemini-3.6-flash', groq: 'groq/compound-mini' };
// グラウンディング検索は実測で 50 秒超えることがある(2026-08-30)。60 秒だと惜しいところで Groq へ落ちる。
const DEFAULT_TIMEOUT_SECONDS = 120;
const USAGE = '使い方: node tools/web-search.mjs "<調べたいこと>" [--provider auto|gemini|groq] [--model <id>] [--json] [--timeout <秒>] [--raw]';

export function appendExecutorUsage(row, { homeDir = process.env.ORGIAST_HOME || os.homedir(), usageFile } = {}) {
  const file = usageFile || path.join(homeDir, '.claude', 'executor-usage.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function loadGeminiApiKey({ env = process.env, homeDir = os.homedir() } = {}) {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  const envKey = readEnvValue(path.join(homeDir, '.gemini', '.env'), 'GEMINI_API_KEY');
  if (envKey) return envKey;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
    return config?.mcpServers?.['gemini-cli']?.env?.GEMINI_API_KEY || '';
  } catch {
    return '';
  }
}

export function loadGroqApiKey({ env = process.env, homeDir = os.homedir() } = {}) {
  return env.GROQ_API_KEY || readEnvValue(path.join(homeDir, '.claude', 'groq.env'), 'GROQ_API_KEY');
}

function collectUrls(value, found) {
  if (typeof value === 'string') {
    try { collectUrls(JSON.parse(value), found); } catch {}
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      const url = match[0].replace(/[),.;:\]}]+$/g, '');
      if (url) found.add(url);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUrls(item, found);
  }
}

export function extractExecutedToolUrls(executedTools) {
  const found = new Set();
  collectUrls(executedTools, found);
  return [...found].map((url) => ({ url, title: '' }));
}

export function extractGroundingUrls(chunks = []) {
  const found = new Map();
  for (const chunk of chunks) {
    const url = chunk?.web?.uri;
    if (url && !found.has(url)) found.set(url, { url, title: chunk.web.title || '' });
  }
  return [...found.values()];
}

export function parseArgs(argv) {
  const options = { provider: 'auto', model: '', timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, json: false, raw: false };
  const queryParts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--model' || arg === '--timeout' || arg === '--provider') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} の値がありません`);
      if (arg === '--model') options.model = value;
      else if (arg === '--provider') {
        if (!['auto', 'gemini', 'groq'].includes(value)) throw new Error('--provider は auto|gemini|groq で指定してください');
        options.provider = value;
      } else {
        options.timeoutSeconds = Number(value);
        if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error('--timeout は正の秒数で指定してください');
      }
    } else if (arg.startsWith('--')) throw new Error(`不明なオプション: ${arg}`);
    else queryParts.push(arg);
  }
  return { ...options, query: queryParts.join(' ').trim() };
}

async function fetchWithTimeout(url, init, timeoutSeconds, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestGeminiSearch({ query, model = DEFAULT_MODELS.gemini, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, apiKey, fetchImpl = globalThis.fetch }) {
  const started = Date.now();
  const url = `${GEMINI_API_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithTimeout(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: query }] }], tools: [{ google_search: {} }] }),
  }, timeoutSeconds, fetchImpl);
  if (!response.ok) throw await httpError('Gemini', response);
  const raw = await response.json();
  const candidate = raw.candidates?.[0] ?? {};
  const answer = (candidate.content?.parts ?? []).map((part) => typeof part.text === 'string' ? part.text : '').join('').trim();
  if (!answer) throw new Error('Gemini API の応答本文が空でした');
  return { raw, answer, urls: extractGroundingUrls(candidate.groundingMetadata?.groundingChunks), elapsedMs: Date.now() - started };
}

export async function requestGroqSearch({ query, model = DEFAULT_MODELS.groq, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, apiKey, fetchImpl = globalThis.fetch }) {
  const started = Date.now();
  const response = await fetchWithTimeout(GROQ_API_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: `${query}\n\n回答には、根拠として参照した出典URLを必ず付けてください。` }] }),
  }, timeoutSeconds, fetchImpl);
  if (!response.ok) throw await httpError('Groq', response);
  const raw = await response.json();
  const message = raw.choices?.[0]?.message ?? {};
  return { raw, answer: typeof message.content === 'string' ? message.content.trim() : '', urls: extractExecutedToolUrls(message.executed_tools), elapsedMs: Date.now() - started };
}

async function httpError(provider, response) {
  const body = (await response.text().catch(() => '')).slice(0, 300);
  const error = new Error(`${provider} API HTTP ${response.status}: ${body}`);
  error.status = response.status;
  return error;
}

function failureReason(provider, error, timeoutSeconds) {
  if (error.name === 'AbortError') return `${provider}: タイムアウト（${timeoutSeconds}秒）`;
  return `${provider}: ${error.message}`;
}

function printResult(stdout, options, result) {
  const payload = { query: options.query, provider: result.provider, model: result.model, answer: result.answer, urls: result.urls.map(({ url }) => url), elapsedMs: result.elapsedMs };
  if (options.raw) stdout.write(`${JSON.stringify(result.raw)}\n`);
  else if (options.json) stdout.write(`${JSON.stringify(payload)}\n`);
  else {
    stdout.write(`${result.answer || '(回答なし)'}\n`);
    if (result.urls.length) stdout.write(`\n参照した URL:\n${result.urls.map(({ title, url }) => `- ${title ? `${title} — ` : ''}${url}`).join('\n')}\n`);
    stdout.write(`\n[provider: ${result.provider} / model: ${result.model} / ${(result.elapsedMs / 1000).toFixed(1)}s]\n`);
  }
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let options;
  try { options = parseArgs(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}\n`); return 2; }
  if (!options.query) { stderr.write(`調べたいことを指定してください。\n${USAGE}\n`); return 2; }

  const keyOptions = { env: dependencies.env, homeDir: dependencies.homeDir };
  const keys = {
    gemini: dependencies.geminiApiKey ?? loadGeminiApiKey(keyOptions),
    groq: dependencies.groqApiKey ?? dependencies.apiKey ?? loadGroqApiKey(keyOptions),
  };
  const providers = options.provider === 'auto' ? ['gemini', 'groq'] : [options.provider];
  if (providers.every((provider) => !keys[provider])) {
    stderr.write(`${providers.map((provider) => `${provider === 'gemini' ? 'GEMINI' : 'GROQ'}_API_KEY がありません`).join('。')}。環境変数、~/.gemini/.env、~/.claude.json または ~/.claude/groq.env を確認してください。\n`);
    return 2;
  }

  const failures = [];
  for (const provider of providers) {
    if (!keys[provider]) { failures.push(`${provider}: APIキーなし`); continue; }
    const model = options.model || DEFAULT_MODELS[provider];
    try {
      const request = provider === 'gemini' ? requestGeminiSearch : requestGroqSearch;
      const result = await request({ ...options, model, apiKey: keys[provider], fetchImpl: dependencies.fetchImpl ?? globalThis.fetch });
      const usage = result.raw?.usageMetadata || result.raw?.usage || {};
      const row = provider === 'gemini'
        ? { t: new Date().toISOString(), provider, model, in: usage.promptTokenCount || 0, out: usage.candidatesTokenCount || 0, secs: result.elapsedMs / 1000, grounded: result.raw?.candidates?.[0]?.groundingMetadata != null }
        : { t: new Date().toISOString(), provider, model, in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0, secs: result.elapsedMs / 1000 };
      try {
        (dependencies.appendUsage || appendExecutorUsage)(row, { homeDir: dependencies.homeDir, usageFile: dependencies.usageFile });
      } catch (error) {
        stderr.write(`使用量台帳への追記失敗: ${error.message}\n`);
      }
      printResult(stdout, options, { ...result, provider, model });
      return 0;
    } catch (error) {
      failures.push(failureReason(provider, error, options.timeoutSeconds));
      // 429 も再試行せず、auto の場合だけ次のプロバイダへ進む。
    }
  }
  stderr.write(`${failures.join('\n')}\n`);
  if (failures.some((reason) => reason.includes('HTTP 429'))) stderr.write('429 はリトライしていません。時間をおいて再実行してください。\n');
  return 1;
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
