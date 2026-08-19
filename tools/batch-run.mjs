// batch-run.mjs — pending.jsonl を実行し、成功結果と使用量を記録する夜間バッチ実行器。
// DeepSeekはUTC 16:30〜00:30だけ実行。--force で時間帯を無視、--dry で対象表示のみ。
// --fallback-standard 指定時だけ、Anthropic Batch失敗後に通常APIで再実行する。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { callWithFallback, classifyFailure, FALLBACK_CHAIN } from './llm-fallback.mjs';

const PROVIDERS = {
  deepseek: { base: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY', keyFile: 'deepseek.env', model: 'deepseek-chat' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyEnv: 'GEMINI_API_KEY', keyFile: 'gemini.env', model: 'gemini-3.7-flash' },
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: 'meta-llama/llama-3.3-70b-instruct', extraHeaders: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast' } },
  groq: { base: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', keyFile: 'groq.env', model: 'llama-3.3-70b-versatile' },
  kimi: { base: 'https://api.moonshot.ai/v1/chat/completions', keyEnv: 'MOONSHOT_API_KEY', keyFile: 'kimi-api.env', model: 'kimi-k3' },
  anthropic: { base: 'https://api.anthropic.com/v1/messages', keyEnv: 'ANTHROPIC_API_KEY', keyFile: 'anthropic.env', model: 'claude-haiku-4-5-20251001' },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry');
const fallbackStandard = args.includes('--fallback-standard');
if (args.includes('--help')) {
  console.log('使い方: node tools/batch-run.mjs [--dry] [--force] [--fallback-standard]');
  console.log('  --fallback-standard  Anthropic Batch失敗時のみ、通常APIで単発再実行する');
  process.exit(0);
}
function userHome() { const h = os.homedir(), m = process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i); return process.env.USERPROFILE || m?.[1] || h; }
const home = userHome();
const dir = path.join(home, '.claude', 'batch-queue');
const pending = path.join(dir, 'pending.jsonl');
const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
fs.mkdirSync(dir, { recursive: true });

function offPeak(now = new Date()) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 16 * 60 + 30 || mins < 30;
}
function loadKey(provider) {
  const P = PROVIDERS[provider];
  if (process.env[P.keyEnv]) return process.env[P.keyEnv];
  const files = [path.join(home, '.claude', P.keyFile)];
  if (provider === 'gemini') files.unshift(path.join(home, '.gemini', '.env'));
  for (const f of files) {
    const value = readEnvValue(f, P.keyEnv); if (value) return value;
  }
  return '';
}
function messages(job) {
  const out = [];
  if (job.system) out.push({ role: 'system', content: job.system });
  out.push({ role: 'user', content: job.prompt });
  return out;
}
function usageRecord(provider, model, usage = {}, extra = {}) {
  const input = usage.prompt_tokens ?? usage.promptTokenCount ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.candidatesTokenCount ?? usage.output_tokens ?? 0;
  if (!usage.__attemptRecorded) try { fs.appendFileSync(ledger, JSON.stringify({ t: new Date().toISOString(), provider, model, in: input, out: output, status: 'ok', attempt: 0, failover: false, ...extra }) + '\n'); } catch {}
  return { in: input, out: output };
}
function saveResult(job, text, usage, mode = 'standard', executedBy) {
  const date = new Date().toISOString().slice(0, 10);
  const rec = { id: job.id, provider: executedBy?.provider || job.provider, model: executedBy?.model || job.model, text, usage, mode, completedAt: new Date().toISOString() };
  fs.appendFileSync(path.join(dir, `results-${date}.jsonl`), JSON.stringify(rec) + '\n');
}
async function runStandard(job) {
  const start = { provider: job.provider, model: job.model || PROVIDERS[job.provider].model };
  const result = await callWithFallback({
    start, chain: FALLBACK_CHAIN,
    payloadFor(candidate) {
      const P = PROVIDERS[candidate.provider]; const key = P && loadKey(candidate.provider);
      if (!P || !key) return null;
      const payload = { model: candidate.model || P.model, messages: messages(job), max_tokens: job.max || 4000, stream: false };
      if (candidate.provider === 'kimi') Object.assign(payload, { reasoning_effort: 'none', temperature: 0.6 });
      return { url: P.base, init: { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(P.extraHeaders || {}) }, body: JSON.stringify(payload) } };
    },
    async onAttempt(info) {
      let usage = {};
      if (info.status === 'ok') usage = (await info.response.clone().json().catch(() => ({}))).usage || {};
      usageRecord(info.candidate.provider, info.candidate.model, usage, { status: info.status, attempt: info.attempt, failover: info.failover, secs: Number(info.secs.toFixed(3)) });
    },
    onFailover({ from, to, reason }) { console.error(`[failover] ${from.provider}:${from.model} ${reason} → ${to.provider}:${to.model}`); },
  });
  const j = await result.response.json();
  const usage = j.usage ?? {};
  Object.defineProperty(usage, '__attemptRecorded', { value: true });
  return { text: j.choices?.[0]?.message?.content ?? '', usage, mode: result.failover ? 'standard-failover' : 'standard', provider: result.candidate.provider, model: result.candidate.model };
}
async function retryFetch(url, init, label) { let last; for (let i = 0; i < 3; i++) { const r = await fetch(url, init); if (r.ok || classifyFailure(r.status) === 'next') return r; last = r; if (i < 2) await delay(1000 * 2 ** i); } return last; }
function anthropicHeaders(key) { return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }; }
function anthropicParams(job) { const p = { model: job.model || PROVIDERS.anthropic.model, max_tokens: job.max || 4000, messages: [{ role: 'user', content: job.prompt }] }; if (job.system) p.system = job.system; return p; }
async function runAnthropicStandard(job) { const P = PROVIDERS.anthropic, key = loadKey('anthropic'); if (!key) throw new Error(`${P.keyEnv} 未設定。環境変数または ~/.claude/${P.keyFile} に ${P.keyEnv}=値 を置いてください`); const r = await retryFetch(P.base, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(anthropicParams(job)) }, 'Anthropic'); if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => '')).slice(0, 400)}`); const j = await r.json(); return { text: (j.content || []).map((x) => x.text || '').join(''), usage: j.usage || {}, mode: 'standard' }; }
function geminiRequest(job) {
  const request = { contents: [{ role: 'user', parts: [{ text: job.prompt }] }], generationConfig: { maxOutputTokens: job.max || 4000 } };
  if (job.system) request.systemInstruction = { parts: [{ text: job.system }] };
  return { request, metadata: { key: job.id } };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runGeminiBatch(jobs) {
  const key = loadKey('gemini');
  if (!key) throw new Error('GEMINI_API_KEY 未設定');
  const model = jobs[0].model || PROVIDERS.gemini.model;
  const uri = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchGenerateContent`;
  const body = { batch: { display_name: `orgiast-${Date.now()}`, input_config: { requests: { requests: jobs.map(geminiRequest) } } } };
  const made = await fetch(uri, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!made.ok) throw new Error(`Batch作成 ${made.status}: ${(await made.text().catch(() => '')).slice(0, 400)}`);
  let batch = await made.json();
  const name = batch.name || batch.batch?.name;
  if (!name) throw new Error('Batch名が応答にありません');
  for (;;) {
    const state = batch.state || batch.batch?.state || '';
    if (/SUCCEEDED$/.test(state)) break;
    if (/FAILED$|CANCELLED$|EXPIRED$/.test(state)) throw new Error(`Batch終了状態: ${state}`);
    await delay(30000);
    const polled = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { headers: { 'x-goog-api-key': key } });
    if (!polled.ok) throw new Error(`Batch確認 ${polled.status}: ${(await polled.text().catch(() => '')).slice(0, 400)}`);
    batch = await polled.json();
  }
  const rows = batch.output?.inlinedResponses?.inlinedResponses || batch.batch?.output?.inlinedResponses?.inlinedResponses || [];
  if (rows.length !== jobs.length) throw new Error(`Batch結果件数不一致 (${rows.length}/${jobs.length})`);
  return rows.map((row) => {
    if (row.error) return { error: row.error.message || 'Gemini Batch内エラー' };
    const response = row.response || {};
    const text = (response.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return { text, usage: response.usageMetadata || {}, mode: 'gemini-batch' };
  });
}
async function runAnthropicBatch(jobs) { const P = PROVIDERS.anthropic, key = loadKey('anthropic'); if (!key) throw new Error(`${P.keyEnv} 未設定。環境変数または ~/.claude/${P.keyFile} に ${P.keyEnv}=値 を置いてください`); const base = 'https://api.anthropic.com/v1/messages/batches'; const made = await retryFetch(base, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify({ requests: jobs.map((j) => ({ custom_id: j.id, params: anthropicParams(j) })) }) }, 'Anthropic Batch作成'); if (!made.ok) throw new Error(`Batch作成 ${made.status}: ${(await made.text().catch(() => '')).slice(0, 400)}`); let batch = await made.json(), wait = 5000; if (!batch.id) throw new Error('Batch IDが応答にありません'); while (batch.processing_status !== 'ended') { await delay(wait); wait = Math.min(wait * 2, 60000); const p = await retryFetch(`${base}/${encodeURIComponent(batch.id)}`, { headers: anthropicHeaders(key) }, 'Anthropic Batch確認'); if (!p.ok) throw new Error(`Batch確認 ${p.status}: ${(await p.text().catch(() => '')).slice(0, 400)}`); batch = await p.json(); } const resultUrl = batch.results_url || `${base}/${encodeURIComponent(batch.id)}/results`; const got = await retryFetch(resultUrl, { headers: anthropicHeaders(key) }, 'Anthropic Batch結果'); if (!got.ok) throw new Error(`Batch結果 ${got.status}: ${(await got.text().catch(() => '')).slice(0, 400)}`); const map = new Map(); for (const line of (await got.text()).split(/\r?\n/).filter(Boolean)) { let row; try { row = JSON.parse(line); } catch { continue; } const type = row.result?.type; if (type !== 'succeeded') { map.set(row.custom_id, { error: row.result?.error?.message || `Anthropic Batch内エラー (${type || 'unknown'})` }); continue; } const msg = row.result.message || {}; map.set(row.custom_id, { text: (msg.content || []).map((x) => x.text || '').join(''), usage: msg.usage || {}, mode: 'batch' }); } return jobs.map((j) => map.get(j.id) || { error: 'Anthropic Batch結果がありません' }); }

let raw = '';
try { raw = fs.readFileSync(pending, 'utf-8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const jobs = [];
for (const line of raw.split(/\r?\n/).filter(Boolean)) {
  try { const job = JSON.parse(line); if (!job.id || !PROVIDERS[job.provider]) throw new Error('必須項目不正'); jobs.push(job); }
  catch (e) { console.error(`不正な行を保持します: ${e.message}`); }
}
if (!jobs.length) { console.log('pendingジョブはありません'); process.exit(0); }
const runnable = jobs.filter((job) => job.provider !== 'deepseek' || force || offPeak());
const skipped = jobs.filter((job) => !runnable.includes(job));
for (const job of skipped) console.log(`SKIP ${job.id} deepseek off-peak時間外`);
if (dry) { for (const job of runnable) console.log(`DRY ${job.id} ${job.provider}:${job.model}`); process.exit(0); }

const completed = new Set();
const geminiGroups = new Map();
for (const job of runnable.filter((j) => j.provider === 'gemini')) {
  const key = job.model || PROVIDERS.gemini.model;
  if (!geminiGroups.has(key)) geminiGroups.set(key, []);
  geminiGroups.get(key).push(job);
}
const anthropicGroups = new Map();
for (const job of runnable.filter((j) => j.provider === 'anthropic')) { const key = job.model || PROVIDERS.anthropic.model; if (!anthropicGroups.has(key)) anthropicGroups.set(key, []); anthropicGroups.get(key).push(job); }
for (const jobsOfModel of anthropicGroups.values()) for (let start = 0; start < jobsOfModel.length; start += 100) { const group = jobsOfModel.slice(start, start + 100); try { const outputs = await runAnthropicBatch(group); for (let i = 0; i < group.length; i++) { const job = group[i], out = outputs[i]; if (out.error) { console.error(`FAIL ${job.id}: ${out.error}`); continue; } const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, 'batch'); completed.add(job.id); console.log(`OK ${job.id} batch`); } } catch (e) { console.error(`Anthropic Batch失敗: ${e.message}`); if (fallbackStandard) { console.error('Anthropic通常APIへ切替'); for (const job of group) { try { const out = await runAnthropicStandard(job); const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode); completed.add(job.id); console.log(`OK ${job.id} standard`); } catch (err) { console.error(`FAIL ${job.id}: ${err.message}`); } } } } }
for (const group of geminiGroups.values()) {
  try {
    const outputs = await runGeminiBatch(group);
    for (let i = 0; i < outputs.length; i++) {
      const job = group[i]; const out = outputs[i];
      if (out.error) {
        try { const fallback = await runStandard(job); const usage = usageRecord(job.provider, job.model, fallback.usage); saveResult(job, fallback.text, usage, fallback.mode, fallback); completed.add(job.id); console.log(`OK ${job.id} standard`); }
        catch (err) { console.error(`FAIL ${job.id}: ${out.error}; fallback: ${err.message}`); }
      } else {
        const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode); completed.add(job.id); console.log(`OK ${job.id} gemini-batch`);
      }
    }
  } catch (e) {
    console.error(`Gemini Batch不可、通常APIへ切替: ${e.message}`);
    for (const job of group) {
      try { const out = await runStandard(job); const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode, out); completed.add(job.id); console.log(`OK ${job.id} standard`); }
      catch (err) { console.error(`FAIL ${job.id}: ${err.message}`); }
    }
  }
}
for (const job of runnable.filter((j) => j.provider !== 'gemini' && j.provider !== 'anthropic')) {
  try { const out = await runStandard(job); const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode, out); completed.add(job.id); console.log(`OK ${job.id} standard`); }
  catch (e) { console.error(`FAIL ${job.id}: ${e.message}`); }
}

// 実行中に追加された行を失わないよう、最新内容から成功IDだけを除去して原子的に置換する。
let latest = '';
try { latest = fs.readFileSync(pending, 'utf-8'); } catch {}
const kept = latest.split(/\r?\n/).filter(Boolean).filter((line) => { try { return !completed.has(JSON.parse(line).id); } catch { return true; } });
const tmp = path.join(dir, `pending-${process.pid}.tmp`);
fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
fs.renameSync(tmp, pending);
console.log(`完了=${completed.size} 保留=${kept.length}`);
