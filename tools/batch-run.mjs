// batch-run.mjs — pending.jsonl を実行し、成功結果と使用量を記録する夜間バッチ実行器。
// DeepSeekはUTC 16:30〜00:30だけ実行。--force で時間帯を無視、--dry で対象表示のみ。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const PROVIDERS = {
  deepseek: { base: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY', keyFile: 'deepseek.env', model: 'deepseek-chat' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyEnv: 'GEMINI_API_KEY', keyFile: 'gemini.env', model: 'gemini-3.7-flash' },
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: 'meta-llama/llama-3.3-70b-instruct', extraHeaders: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast' } },
  groq: { base: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', keyFile: 'groq.env', model: 'llama-3.3-70b-versatile' },
  kimi: { base: 'https://api.moonshot.ai/v1/chat/completions', keyEnv: 'MOONSHOT_API_KEY', keyFile: 'kimi-api.env', model: 'kimi-k3' },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry');
const dir = path.join(os.homedir(), '.claude', 'batch-queue');
const pending = path.join(dir, 'pending.jsonl');
const ledger = path.join(os.homedir(), '.claude', 'executor-usage.jsonl');
fs.mkdirSync(dir, { recursive: true });

function offPeak(now = new Date()) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 16 * 60 + 30 || mins < 30;
}
function loadKey(provider) {
  const P = PROVIDERS[provider];
  if (process.env[P.keyEnv]) return process.env[P.keyEnv];
  const files = [path.join(os.homedir(), '.claude', P.keyFile)];
  if (provider === 'gemini') files.unshift(path.join(os.homedir(), '.gemini', '.env'));
  for (const f of files) {
    try { for (const l of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) { if (l.startsWith(P.keyEnv + '=')) return l.slice(P.keyEnv.length + 1).trim(); } } catch {}
  }
  return '';
}
function messages(job) {
  const out = [];
  if (job.system) out.push({ role: 'system', content: job.system });
  out.push({ role: 'user', content: job.prompt });
  return out;
}
function usageRecord(provider, model, usage = {}) {
  const input = usage.prompt_tokens ?? usage.promptTokenCount ?? 0;
  const output = usage.completion_tokens ?? usage.candidatesTokenCount ?? 0;
  try { fs.appendFileSync(ledger, JSON.stringify({ t: new Date().toISOString(), provider, model, in: input, out: output }) + '\n'); } catch {}
  return { in: input, out: output };
}
function saveResult(job, text, usage, mode = 'standard') {
  const date = new Date().toISOString().slice(0, 10);
  const rec = { id: job.id, provider: job.provider, model: job.model, text, usage, mode, completedAt: new Date().toISOString() };
  fs.appendFileSync(path.join(dir, `results-${date}.jsonl`), JSON.stringify(rec) + '\n');
}
async function runStandard(job) {
  const P = PROVIDERS[job.provider];
  const key = loadKey(job.provider);
  if (!key) throw new Error(`${P.keyEnv} 未設定`);
  const payload = { model: job.model || P.model, messages: messages(job), max_tokens: job.max || 4000, stream: false };
  if (job.provider === 'kimi') Object.assign(payload, { reasoning_effort: 'none', temperature: 0.6 });
  const r = await fetch(P.base, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(P.extraHeaders || {}) }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => '')).slice(0, 400)}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? {}, mode: 'standard' };
}
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
for (const group of geminiGroups.values()) {
  try {
    const outputs = await runGeminiBatch(group);
    for (let i = 0; i < outputs.length; i++) {
      const job = group[i]; const out = outputs[i];
      if (out.error) {
        try { const fallback = await runStandard(job); const usage = usageRecord(job.provider, job.model, fallback.usage); saveResult(job, fallback.text, usage, fallback.mode); completed.add(job.id); console.log(`OK ${job.id} standard`); }
        catch (err) { console.error(`FAIL ${job.id}: ${out.error}; fallback: ${err.message}`); }
      } else {
        const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode); completed.add(job.id); console.log(`OK ${job.id} gemini-batch`);
      }
    }
  } catch (e) {
    console.error(`Gemini Batch不可、通常APIへ切替: ${e.message}`);
    for (const job of group) {
      try { const out = await runStandard(job); const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode); completed.add(job.id); console.log(`OK ${job.id} standard`); }
      catch (err) { console.error(`FAIL ${job.id}: ${err.message}`); }
    }
  }
}
for (const job of runnable.filter((j) => j.provider !== 'gemini')) {
  try { const out = await runStandard(job); const usage = usageRecord(job.provider, job.model, out.usage); saveResult(job, out.text, usage, out.mode); completed.add(job.id); console.log(`OK ${job.id} standard`); }
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
