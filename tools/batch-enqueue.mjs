#!/usr/bin/env node
// batch-enqueue.mjs — 夜間バッチ用ジョブを ~/.claude/batch-queue/pending.jsonl へ追加する。
// 使い方: node batch-enqueue.mjs --provider <provider> "指示" [--model X] [--system S] [--max N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const PROVIDERS = {
  deepseek: { model: 'deepseek-chat' }, gemini: { model: 'gemini-3.7-flash' },
  openrouter: { model: 'meta-llama/llama-3.3-70b-instruct' }, groq: { model: 'openai/gpt-oss-120b' },
  kimi: { model: 'kimi-k3' }, anthropic: { model: 'claude-haiku-4-5-20251001' },
};

export function userHome() {
  const nativeHome = os.homedir();
  return process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || nativeHome;
}

export function enqueueJob({ provider, prompt, model, system = '', max = 4000, jobType, batchDate }, { home = userHome(), now = new Date() } = {}) {
  const normalizedProvider = String(provider || '').toLowerCase();
  const config = PROVIDERS[normalizedProvider];
  if (!config) throw new Error(`未対応provider: ${provider}`);
  if (!String(prompt || '').trim()) throw new Error('指示テキストがありません');
  const dir = path.join(home, '.claude', 'batch-queue');
  const pending = path.join(dir, 'pending.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  let seq = 1;
  try {
    for (const line of fs.readFileSync(pending, 'utf8').split(/\r?\n/)) {
      try { const id = JSON.parse(line).id || ''; if (id.startsWith(`${stamp}-`)) seq = Math.max(seq, (parseInt(id.slice(stamp.length + 1), 10) || 0) + 1); } catch {}
    }
  } catch {}
  const job = {
    id: `${stamp}-${String(seq).padStart(3, '0')}`, provider: normalizedProvider, model: model || config.model,
    system, prompt: String(prompt).trim(), max: Number(max) || 4000, enqueuedAt: now.toISOString(),
    ...(jobType && { jobType }), ...(batchDate && { batchDate }),
  };
  fs.appendFileSync(pending, `${JSON.stringify(job)}\n`);
  return job;
}

function option(args, name, fallback) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; }

export function runCli(args = process.argv.slice(2)) {
  const provider = String(option(args, '--provider', '')).toLowerCase();
  if (!PROVIDERS[provider]) { console.error('使い方: node batch-enqueue.mjs --provider <deepseek|gemini|openrouter|groq|kimi|anthropic> "指示"|--prompt-file <path> [--model X] [--system S] [--max N]'); return 2; }
  const skip = new Set();
  for (const flag of ['--provider', '--model', '--system', '--max', '--prompt-file']) { const i = args.indexOf(flag); if (i >= 0) { skip.add(i); skip.add(i + 1); } }
  const promptFile = option(args, '--prompt-file', '');
  let prompt = args.filter((value, index) => !value.startsWith('--') && !skip.has(index)).join(' ').trim();
  if (promptFile) {
    try { prompt = fs.readFileSync(promptFile, 'utf8').trim(); }
    catch (error) { console.error(`--prompt-file を読めません: ${promptFile} (${error.code || error.message})`); return 2; }
  }
  if (!prompt) { console.error('指示テキストがありません'); return 2; }
  const job = enqueueJob({ provider, prompt, model: option(args, '--model'), system: option(args, '--system', ''), max: parseInt(option(args, '--max', '4000'), 10) });
  console.log(`${job.id} を夜間バッチに追加 (${job.provider}:${job.model})`);
  console.log(job.provider === 'kimi' ? '→ Kimiは割引待ちせず次回実行時に処理されます。結果は ~/.claude/batch-queue/results-<日付>.jsonl。' : job.provider === 'anthropic' ? '→ Anthropic Message Batchesで常時50%off処理されます。結果は ~/.claude/batch-queue/results-<日付>.jsonl。' : '→ 毎日03:00のoff-peak帯に半額(約50%off)で実行されます。結果は ~/.claude/batch-queue/results-<日付>.jsonl。');
  console.log('→ 今すぐ実行したい場合: node batch-run.mjs --force');
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = runCli();
