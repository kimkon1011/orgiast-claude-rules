// grok-x-fetch.mjs — xAI Grok API を使って X(Twitter) の投稿本文を取得する CLI ヘルパー。
// 使い方: node tools/grok-x-fetch.mjs --url <URL> [--model <model>]
// 認証: XAI_API_KEY (env もしくは ~/.claude/xai.env)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const BASE = 'https://api.x.ai/v1/responses';

export function getClaudeDir() {
  const home = process.env.ORGIAST_HOME || os.homedir();
  return path.join(home, '.claude');
}

export function loadKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const envFile = path.join(getClaudeDir(), 'xai.env');
  return readEnvValue(envFile, 'XAI_API_KEY');
}

export function parseArgs(argv) {
  const options = {
    url: '',
    model: 'grok-4.6', // x_search ツールは grok-4.6 でのみ動作確認済み(2026-09-20実機検証)
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' || arg === '-u') {
      options.url = argv[++i] || '';
    } else if (arg === '--model' || arg === '-m') {
      options.model = argv[++i] || '';
    } else if (arg.startsWith('https://x.com/') || arg.startsWith('https://twitter.com/')) {
      options.url = arg;
    }
  }

  return options;
}

export async function fetchXPost(options, dependencies = {}) {
  const {
    fetchFn = globalThis.fetch,
    fsFn = fs,
    getClaudeDirFn = getClaudeDir,
    loadKeyFn = loadKey,
  } = dependencies;

  const KEY = loadKeyFn();
  if (!KEY) {
    throw new Error('XAI_API_KEY 未設定 (env もしくは ~/.claude/xai.env)');
  }

  const { url, model } = options;
  if (!url) {
    throw new Error('URLを指定してください。使い方: node tools/grok-x-fetch.mjs --url <URL>');
  }

  // --- xAI Agent Tools API 技術メモ ---
  // 2026-09-20 に https://api.x.ai/v1/responses へ実際にリクエストして検証済みの正しい形式。
  // 過去に試して失敗した形式(いずれも実機で確認済みのエラー):
  //   - chat completions + `search_parameters: {mode:"on", sources:[{type:"x"}]}` → 廃止(410)
  //   - chat completions + `tools:[{type:"x_search"}]` → 422 (chat completionsはx_search非対応)
  //   - responses API + `tools:[{type:"live_search", sources:[...]}]` → 410 (live searchツール自体が廃止)
  // 正: /v1/responses エンドポイントに model: grok-4.6, input(messages ではない), tools:[{type:"x_search"}]。
  const requestBody = {
    model,
    input: [
      {
        role: 'user',
        content: `Fetch the X (Twitter) post at this URL and reply with only its exact, complete original text content, nothing else: ${url}`
      }
    ],
    tools: [
      { type: 'x_search' }
    ]
  };

  const response = await fetchFn(BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Grok API呼び出し失敗 (Status: ${response.status}): ${errText.slice(0, 300)}`);
  }

  const json = await response.json();
  // Responses API: output は複数アイテムの配列。type:'message' の中の type:'output_text' を拾う。
  const text = json.output_text
    ?? json.output?.flatMap((item) => item.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('\n')
    ?? '';
  const citations = json.output?.flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'source' || c.type === 'citation')
    .map((c) => c.url) ?? [];
  const usage = json.usage ?? {};

  // Log usage into executor-usage.jsonl
  try {
    const usageFilePath = path.join(getClaudeDirFn(), 'executor-usage.jsonl');
    const logLine = JSON.stringify({
      t: new Date().toISOString(),
      provider: 'grok',
      model,
      in: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      out: usage.output_tokens ?? usage.completion_tokens ?? 0,
      x_fetch: true,
    }) + '\n';
    fsFn.appendFileSync(usageFilePath, logLine);
  } catch (e) {
    // Fail silently on usage logging errors
  }

  return {
    text: text.trim() || '(出力なし)',
    citations,
    usage,
  };
}

export async function runCli(argv, dependencies = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
  } = dependencies;

  try {
    const options = parseArgs(argv);
    if (!options.url) {
      stderr.write('使い方: node tools/grok-x-fetch.mjs --url <x.com投稿URL> [--model <model>]\n');
      return 2;
    }

    stdout.write(`Grok X Fetch: URL=${options.url} (Model=${options.model})\n`);
    const result = await fetchXPost(options, dependencies);
    stdout.write('\n--- 投稿本文 ---\n');
    stdout.write(`${result.text}\n`);
    stdout.write('----------------\n');
    if (result.citations?.length) {
      stdout.write(`出典: ${result.citations.join(', ')}\n`);
    }
    const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? 0;
    const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? 0;
    stderr.write(`[grok ${options.model}] in=${inTok} out=${outTok}\n`);
    return 0;
  } catch (error) {
    stderr.write(`エラー: ${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
