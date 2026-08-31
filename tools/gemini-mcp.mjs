#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isEntry } from './is-entry.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 300_000;
// Gemini CLI 経路は使えない(2026-08-30 実測): OAuth は Google 側で個人向け無料枠が終了(UNSUPPORTED_CLIENT)、
// API キー認証でも CLI は旧世代モデルを掴んで 429(free tier 20回/日, gemini-3.5-flash)。REST を直接叩けば 200 が返る。
const DEFAULT_MODEL = 'gemini-3.6-flash';

function apiKey(env, homeDir = os.homedir()) {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  try {
    const dotenv = fs.readFileSync(path.join(homeDir, '.gemini', '.env'), 'utf8');
    const match = dotenv.match(/^\s*GEMINI_API_KEY\s*=\s*(.*?)\s*$/m);
    if (!match) return undefined;
    return match[1].replace(/^(['"])(.*)\1$/, '$2');
  } catch {
    return undefined;
  }
}

function timeoutMs(env = process.env) {
  const configured = Number(env.ORGIAST_GEMINI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

export async function runGemini(prompt, model, options = {}) {
  const env = options.env ?? process.env;
  const key = apiKey(env, options.homeDir);
  if (!key) return { ok: false, text: 'GEMINI_API_KEY が見つかりません' };
  const selectedModel = model || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limit = timeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (options.googleSearch === true) body.tools = [{ google_search: {} }];

  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const responseText = await response.text();
    if (!response.ok) {
      // 検索グラウンディングは無料枠に割り当てが無く、素の生成が 200 でもここだけ 429 になる(2026-08-30 実測)。
      // 黙って検索なしで答えると「検索した結果」に見えてしまうので、失敗のまま理由だけ足して返す。
      const hint = response.status === 429 && options.googleSearch === true
        ? '\n(googleSearch の Google 検索グラウンディングは無料枠では使えません。geminiChat は使えます)'
        : '';
      return { ok: false, text: `gemini REST ${response.status}: ${responseText.slice(0, 800)}${hint}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return { ok: false, text: `gemini REST: 応答に text がありません: ${responseText.slice(0, 400)}` };
    }
    // parts には thoughtSignature など text を持たない要素が混ざるため、text だけを拾って連結する。
    const text = parsed.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('');
    if (!text) {
      return { ok: false, text: `gemini REST: 応答に text がありません: ${responseText.slice(0, 400)}` };
    }
    return { ok: true, text };
  } catch (caught) {
    if (controller.signal.aborted) {
      return { ok: false, text: `gemini timeout after ${limit / 1000}s` };
    }
    return { ok: false, text: `gemini REST failed: ${caught instanceof Error ? caught.message : String(caught)}` };
  } finally {
    clearTimeout(timer);
  }
}

const tools = [
  {
    name: 'googleSearch',
    description: 'Gemini の Google 検索グラウンディングで調べる',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        raw: { type: 'boolean' },
        model: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'geminiChat',
    description: 'Gemini にプロンプトを渡す',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, model: { type: 'string' } },
      required: ['prompt'],
    },
  },
];

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message) {
  const hasId = Object.hasOwn(message, 'id');
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'initialize') {
    if (!hasId) return null;
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'orgiast-gemini-mcp', version: '1.0.0' },
    });
  }
  if (message.method === 'tools/list') return hasId ? result(message.id, { tools }) : null;
  if (message.method === 'tools/call') {
    if (!hasId) return null;
    const name = message.params?.name;
    const input = message.params?.arguments ?? {};
    let prompt;
    if (name === 'geminiChat' && typeof input.prompt === 'string') prompt = input.prompt;
    if (name === 'googleSearch' && typeof input.query === 'string') {
      prompt = `Google 検索で次を調べてください: ${input.query}`;
      if (input.limit !== undefined) prompt += `。結果は最大 ${input.limit} 件にしてください`;
      if (input.raw === true) prompt += '。URL とスニペットを含めてください';
    }
    if (prompt === undefined) {
      return result(message.id, { content: [{ type: 'text', text: 'invalid tool name or required argument' }], isError: true });
    }
    const executed = await runGemini(prompt, input.model, { googleSearch: name === 'googleSearch' });
    return result(message.id, {
      content: [{ type: 'text', text: executed.text }],
      ...(executed.ok ? {} : { isError: true }),
    });
  }
  return hasId ? error(message.id, -32601, 'Method not found') : null;
}

export function startServer(input = process.stdin, output = process.stdout) {
  // readline はチャンク境界を跨ぐ行を保持するため、分割受信でも一行一 JSON を崩さない。
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let response;
    try {
      response = await handle(JSON.parse(line));
    } catch (caught) {
      response = error(null, -32700, caught instanceof SyntaxError ? 'Parse error' : 'Internal error');
      if (!(caught instanceof SyntaxError)) console.error(caught);
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  });
}

// junction 経由(~/orgiast-claude-rules → Downloads)でも判定が外れないよう is-entry を使う。
if (isEntry(import.meta.url)) startServer();
