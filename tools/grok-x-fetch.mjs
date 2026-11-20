// grok-x-fetch.mjs — xAI Grok API を使って X(Twitter) の投稿本文を取得する CLI ヘルパー。
// 使い方: node tools/grok-x-fetch.mjs --url <URL> [--model <model>]
// 認証: XAI_API_KEY (env もしくは ~/.claude/xai.env)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { billingFailure, billingWithQuotaHint } from './lib/lane-real-health.mjs';

const BASE = 'https://api.x.ai/v1/responses';
const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';

function postId(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return undefined; }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !/^(?:www\.)?(?:x|twitter)\.com$/.test(parsed.hostname)) return undefined;
  return parsed.pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1];
}

function formatPost(post) {
  const noteText = post.note_tweet?.text ?? post.note_tweet?.note_tweet_results?.result?.text;
  const handle = post.user?.screen_name;
  const lines = [
    handle && `投稿者: @${handle}`,
    post.created_at && `日時: ${post.created_at}`,
    noteText || post.text,
    post.note_tweet && !noteText && '（本文は途中まで）',
    post.article?.title && `記事: ${post.article.title}`,
    post.article?.preview_text,
  ].filter(Boolean);
  for (const media of post.mediaDetails ?? post.entities?.media ?? []) {
    if (media.media_url_https) lines.push(`画像: ${media.media_url_https}`);
    const variants = media.video_info?.variants ?? [];
    const video = variants.reduce((best, variant) =>
      variant.url && (!best || (variant.bitrate ?? 0) > (best.bitrate ?? 0)) ? variant : best, null);
    const videoUrl = video?.url ?? (media.type === 'photo' ? undefined : media.expanded_url);
    if (videoUrl) lines.push(`動画: ${videoUrl}`);
  }
  return lines.join('\n');
}

async function fetchSyndication(fetchFn, url, grokStatus) {
  const id = postId(url);
  if (!id) throw new Error(`X投稿URLから投稿IDを取得できません（Grok 失敗: ${grokStatus}）`);
  try {
    const response = await fetchFn(`${SYNDICATION}?id=${id}&token=a`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const post = await response.json();
    const text = post && formatPost(post);
    if (!text) throw new Error('投稿データなし');
    const quote = post.quoted_tweet && formatPost(post.quoted_tweet);
    return {
      route: `取得経路: syndication（Grok 失敗: ${grokStatus}）`,
      text: quote ? `${text}\n\n--- 引用ポスト ---\n${quote}` : text,
      citations: [url],
      usage: {},
    };
  } catch (error) {
    throw new Error(`syndication 取得失敗（Grok 失敗: ${grokStatus}）: ${error.message}`, { cause: error });
  }
}

async function recordGrokBilling(dir, fsFn, model) {
  const reason = 'insufficient credits or monthly spending limit reached';
  try {
    fsFn.appendFileSync(path.join(dir, 'executor-usage.jsonl'), JSON.stringify({
      t: new Date().toISOString(), provider: 'grok', model, status: 'error',
      httpStatus: 403, reason, in: 0, out: 0, x_fetch: true,
    }) + '\n');
  } catch {}
  try {
    const { readJson, atomicJson } = await import('./lane-doctor.mjs');
    const file = path.join(dir, 'lane-health.json');
    const health = readJson(file);
    if (!health.lanes || typeof health.lanes !== 'object' || Array.isArray(health.lanes)) return;
    const grok = { ...health.lanes.grok, alive: false, reason: 'billing', error: `HTTP 403: ${reason}` };
    delete grok.until;
    health.lanes.grok = grok;
    atomicJson(file, health);
  } catch {}
}

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
    } else if (postId(arg)) {
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

  const { url, model } = options;
  if (!url) {
    throw new Error('URLを指定してください。使い方: node tools/grok-x-fetch.mjs --url <URL>');
  }
  const fallback = (status) => fetchSyndication(fetchFn, url, status);
  const KEY = loadKeyFn();
  if (!KEY) return fallback('XAI_API_KEY 未設定');

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

  let response;
  try {
    response = await fetchFn(BASE, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
  } catch {
    return fallback('ネットワークエラー');
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 403
      && (billingFailure(`403 ${errText}`) || /used all available credits|reached (?:its |the )?monthly spending limit/i.test(errText))
      && !billingWithQuotaHint(errText)) {
      await recordGrokBilling(getClaudeDirFn(), fsFn, model);
    }
    if ([402, 403, 429].includes(response.status) || (response.status >= 500 && response.status < 600)) {
      return fallback(response.status);
    }
    throw new Error(`Grok API呼び出し失敗 (Status: ${response.status}): ${errText.slice(0, 300)}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    if (error instanceof TypeError) return fallback('ネットワークエラー');
    throw error;
  }
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

    const result = await fetchXPost(options, dependencies);
    stdout.write(`${result.route ?? `Grok X Fetch: URL=${options.url} (Model=${options.model})`}\n`);
    stdout.write('\n--- 投稿本文 ---\n');
    stdout.write(`${result.text}\n`);
    stdout.write('----------------\n');
    if (result.citations?.length) {
      stdout.write(`出典: ${result.citations.join(', ')}\n`);
    }
    const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? 0;
    const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? 0;
    if (!result.route) stderr.write(`[grok ${options.model}] in=${inTok} out=${outTok}\n`);
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
