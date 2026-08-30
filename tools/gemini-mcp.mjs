#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 300_000;

export function buildArgs(prompt, model) {
  const args = ['-p', prompt, '--skip-trust'];
  if (model) args.push('-m', model);
  return args;
}

export function resolveGeminiCmd(env = process.env) {
  if (env.ORGIAST_GEMINI_CMD) return env.ORGIAST_GEMINI_CMD;
  if (env.APPDATA) {
    const installed = path.join(env.APPDATA, 'npm', 'gemini.cmd');
    if (fs.existsSync(installed)) return installed;
  }
  return 'gemini.cmd';
}

function cleanOutput(value) {
  // CLI の装飾や端末能力の警告を MCP の回答本文へ混ぜないため、行単位で除去する。
  return value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*Warning:\s*True color\b/i.test(line))
    .join('\n')
    .trim();
}

function timeoutMs(env = process.env) {
  const configured = Number(env.ORGIAST_GEMINI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

export function runGemini(prompt, model, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const args = buildArgs(prompt, model);
  const command = platform === 'win32' ? (env.ComSpec || 'cmd.exe') : 'gemini';
  // .cmd は CreateProcess で直接起動できないため、Windows だけ cmd.exe を明示して経由する。
  const commandArgs = platform === 'win32' ? ['/c', resolveGeminiCmd(env), ...args] : args;
  const limit = timeoutMs(env);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawnImpl(command, commandArgs, {
      env: { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      windowsVerbatimArguments: false,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      // クォータ枯渇など、タイムアウトまでに出た原因を失わないよう末尾の出力を添える。
      // stderr が空の CLI にも対応して stdout を代替として使う。
      const clue = cleanOutput((stderr || stdout).slice(-400));
      finish({ ok: false, text: `gemini timeout after ${limit / 1000}s${clue ? `: ${clue}` : ''}` });
    }, limit);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, text: `gemini launch failed: ${error.message}` }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, text: cleanOutput(stdout) });
      else finish({ ok: false, text: `gemini exited with code ${code}: ${cleanOutput(stderr).slice(0, 800)}` });
    });
    // 親の標準入力を継承せず、Gemini が追加入力待ちで止まらないよう必ず EOF を送る。
    child.stdin?.end();
  });
}

const tools = [
  {
    name: 'googleSearch',
    description: 'Gemini CLI を使って Google 検索を行う',
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
    description: 'Gemini CLI にプロンプトを渡す',
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
      prompt = `Search for: ${input.query}`;
      if (input.limit !== undefined) prompt += ` (return up to ${input.limit} results)`;
      if (input.raw === true) prompt += '. Return raw search results including URLs and snippets.';
    }
    if (prompt === undefined) {
      return result(message.id, { content: [{ type: 'text', text: 'invalid tool name or required argument' }], isError: true });
    }
    const executed = await runGemini(prompt, input.model);
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
