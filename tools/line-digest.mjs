import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { callWithFallback, FALLBACK_CHAIN } from './llm-fallback.mjs';

const CATEGORIES = new Set(['cost', 'quality', 'model-release', 'tool', 'prompt-technique', 'other']);
const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', env: 'GROQ_API_KEY', file: 'groq.env', model: 'openai/gpt-oss-120b' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', env: 'CEREBRAS_API_KEY', file: 'cerebras.env', model: 'zai-glm-4.7' },
  deepseek: { url: 'https://api.deepseek.com/chat/completions', env: 'DEEPSEEK_API_KEY', file: 'deepseek.env', model: 'deepseek-chat' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', env: 'OPENROUTER_API_KEY', file: 'openrouter.env', model: 'openai/gpt-oss-120b', extraHeaders: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast' } },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', env: 'GEMINI_API_KEY', file: 'gemini.env', model: 'gemini-3.7-flash' },
  kimi: { url: 'https://api.moonshot.ai/v1/chat/completions', env: 'MOONSHOT_API_KEY', file: 'kimi-api.env', model: 'kimi-k3', special: 'kimi' },
  grok: { url: 'https://api.x.ai/v1/chat/completions', env: 'XAI_API_KEY', file: 'xai.env', model: 'grok-3' },
};

export function parseEnvText(text) {
  const result = {};
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = raw.trim().match(/^(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function canonicalText(text) { return String(text).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }
function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

export function preprocessMessages(messages) {
  const seen = new Set();
  const greeting = /^(了解(しました)?|ありがとうございます|ありがとう|おつかれさまです|お疲れ様です|なるほど|よろしくお願いします|👍|🙏|はい|承知しました)[!！。\s]*$/iu;
  const attachment = /(スタンプ|写真|画像|ファイル|動画)を送信しました/u;
  const model = /(GPT|Claude|Gemini|Llama|DeepSeek|Grok|Qwen|Mistral|Copilot|AI|LLM)[-\s\w.]*/iu;
  return messages.filter((message) => {
    const text = String(message.text ?? '').trim();
    const normalized = canonicalText(text);
    if (!text || greeting.test(text) || attachment.test(text)) return false;
    if ([...text].length < 20 && !/https?:\/\//iu.test(text) && !model.test(text)) return false;
    const key = hash(normalized);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repairJson(text) {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').replace(/,\s*([}\]])/g, '$1');
}

export function parseClassifications(raw) {
  const clean = repairJson(String(raw ?? ''));
  const results = [];
  const add = (item) => {
    if (!item || !Number.isInteger(Number(item.i))) return;
    const category = CATEGORIES.has(item.category) ? item.category : 'other';
    const score = Math.max(0, Math.min(3, Number(item.score) || 0));
    results.push({ i: Number(item.i), keep: typeof item.keep === 'boolean' ? item.keep : score >= 2, category, score, why: String(item.why || '') });
  };
  const addValue = (value) => {
    const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [value];
    items.forEach(add);
  };
  const starts = [clean.indexOf('['), clean.indexOf('{')].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    for (let end = clean.length; end > start; end--) {
      try {
        const value = JSON.parse(clean.slice(start, end));
        addValue(value);
        if (results.length) return results;
      } catch {}
    }
  }
  for (const match of clean.matchAll(/\{[^{}]*\}/g)) { try { add(JSON.parse(repairJson(match[0]))); } catch {} }
  return results;
}

export function replaceMarkerSection(existing, body) {
  const start = '<!-- AI-NEWS-START -->';
  const end = '<!-- AI-NEWS-END -->';
  const section = `${start}\n${body.trim()}\n${end}`;
  const lines = String(existing ?? '').split(/\r?\n/);
  const a = lines.indexOf(start), b = lines.indexOf(end, a + 1);
  if (a >= 0 && b > a) return [...lines.slice(0, a), ...section.split('\n'), ...lines.slice(b + 1)].join('\n');
  const prefix = String(existing ?? '').trimEnd();
  return `${prefix}${prefix ? '\n\n' : ''}${section}\n`;
}

function normalizeTitle(title) { return canonicalText(title); }
export function appendUniqueProposals(existingText, proposals, now = new Date()) {
  const records = String(existingText ?? '').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const pending = new Set(records.filter((r) => r.status === 'pending').map((r) => normalizeTitle(r.title)));
  let next = records.reduce((max, r) => Math.max(max, Number(String(r.id || '').match(/P-(\d+)/)?.[1]) || 0), 0) + 1;
  const added = [];
  for (const proposal of proposals) {
    const title = String(proposal.title || '').trim();
    if (!title || pending.has(normalizeTitle(title))) continue;
    const record = { id: `P-${String(next++).padStart(4, '0')}`, createdAt: now.toISOString(), status: 'pending', title, action: String(proposal.action || ''), evidence: String(proposal.evidence || '').slice(0, 120), category: CATEGORIES.has(proposal.category) ? proposal.category : 'other', confidence: ['high', 'medium', 'low'].includes(proposal.confidence) ? proposal.confidence : 'low' };
    records.push(record); added.push(record); pending.add(normalizeTitle(title));
  }
  return { text: records.map(JSON.stringify).join('\n') + (records.length ? '\n' : ''), added, records };
}

function readJsonLines(text) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export function updateTopics(existingText, digestLines, ts, now = Date.now()) {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const records = readJsonLines(existingText).filter((topic) => Number(topic.ts) >= cutoff);
  const ids = new Set(records.map((topic) => topic.id));
  for (const value of digestLines) {
    const line = String(value).trim();
    if (!line) continue;
    const id = hash(canonicalText(line)).slice(0, 12);
    if (ids.has(id)) continue;
    records.push({ id, ts: Number(ts), category: CATEGORIES.has(value.category) ? value.category : 'other', line });
    ids.add(id);
  }
  records.sort((a, b) => Number(b.ts) - Number(a.ts));
  return { text: records.map(JSON.stringify).join('\n') + (records.length ? '\n' : ''), records };
}

export function selectUnprocessed(messages, state, since) {
  const processed = new Set(since ? [] : (state?.processedIds || []));
  const cutoff = since ? new Date(since).getTime() : -Infinity;
  return messages.filter((m) => Number(m.ts) >= cutoff && !processed.has(m.id));
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function readMessages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse().flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)).sort((a, b) => Number(b.ts) - Number(a.ts));
}

function loadKey(home, provider) {
  const p = PROVIDERS[provider];
  if (process.env[p.env]) return process.env[p.env];
  try { return parseEnvText(fs.readFileSync(path.join(home, '.claude', p.file), 'utf8'))[p.env] || ''; } catch { return ''; }
}

export function createLlmClient({ home = os.homedir(), fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), usageFile } = {}) {
  return async ({ provider, messages, maxTokens = 4000, responseFormat }) => {
    const run = async (format) => callWithFallback({
      start: { provider, model: PROVIDERS[provider]?.model }, chain: FALLBACK_CHAIN, fetchImpl, sleepImpl: sleep, ledgerFile: usageFile,
      cooldownFile: path.join(home, '.claude', 'provider-cooldown.json'),
      payloadFor(candidate) {
        const p = PROVIDERS[candidate.provider], key = p && loadKey(home, candidate.provider);
        if (!p || !key) return null;
        const body = { model: candidate.model || p.model, messages, max_tokens: maxTokens, stream: false };
        if (format) body.response_format = format;
        if (p.special === 'kimi') Object.assign(body, { reasoning_effort: 'none', temperature: 0.6 });
        return { url: p.url, init: { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(p.extraHeaders || {}) }, body: JSON.stringify(body) } };
      },
      async onAttempt(info) {
        const usage = info.status === 'ok' ? (await info.response.clone().json().catch(() => ({}))).usage || {} : {};
        const rec = { t: new Date().toISOString(), tool: 'line-digest', provider: info.candidate.provider, model: info.candidate.model, in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0, secs: Number(info.secs.toFixed(3)), status: info.status, attempt: info.attempt, failover: info.failover, ok: info.status === 'ok' };
        try { fs.mkdirSync(path.dirname(usageFile), { recursive: true }); fs.appendFileSync(usageFile, `${JSON.stringify(rec)}\n`); } catch {}
      },
    });
    let result;
    try { result = await run(responseFormat); }
    catch (error) {
      const has400 = error.failures?.some(({ reason }) => /^HTTP400\b/.test(reason));
      if (!responseFormat || !has400) throw error;
      result = await run(undefined);
    }
    const json = await result.response.json();
    return { text: String(json.choices?.[0]?.message?.content || ''), provider: result.candidate.provider, model: result.candidate.model };
  };
}

export function filterDigestLines(lines) {
  const caution = /(伝聞|未検証|要検証|裏付け|情報は限定的)/u;
  const concrete = /(https?:\/\/|\d|[A-Za-z]|[ァ-ヶー])/u;
  return lines.map(String).map((line) => line.trim()).filter((line) => {
    if (!line || [...line].length > 80 || concrete.test(line) || !caution.test(line)) return Boolean(line);
    const remainder = line
      .replace(/[「」『』（）()【】\[\]、。,.!！?？:：・\s]/gu, '')
      .replace(/(?:この|その|上記の)?(?:情報|内容|発言|投稿|共有)?(?:自体)?(?:は|が|について|であり|である|です|とされる|されている|のみ|まだ|現時点で|十分な)?/gu, '')
      .replace(/(?:伝聞|未検証|要検証|裏付け(?:が|は)?(?:ない|ありません|不足している|不十分)|情報は限定的)/gu, '');
    return remainder.length > 2;
  });
}

function parseSummary(raw) {
  const clean = repairJson(raw); let value;
  for (const start of [clean.indexOf('{')].filter((x) => x >= 0)) for (let end = clean.length; end > start; end--) { try { value = JSON.parse(clean.slice(start, end)); break; } catch {} if (value) break; }
  if (!value) throw new Error('Stage 2のJSONを復旧できません');
  return { digest: filterDigestLines(Array.isArray(value.digest) ? value.digest : String(value.digest || '').split(/\r?\n/)).slice(0, 10), proposals: Array.isArray(value.proposals) ? value.proposals : [] };
}

function parseArgs(args) {
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  return { dryRun: args.includes('--dry-run'), seed: args.includes('--seed'), list: args.includes('--list'), done: value('--done'), reject: value('--reject'), since: value('--since'), limit: Math.max(1, Number(value('--limit', 200)) || 200), provider: value('--provider', 'groq') };
}

export async function runDigest(options = {}) {
  const home = options.home || os.homedir(), args = options.args || [], log = options.log || console.log;
  const cli = parseArgs(args);
  if (!PROVIDERS[cli.provider]) throw new Error('--provider は groq または deepseek を指定してください');
  const base = path.join(home, '.claude'), inputDir = path.join(base, 'line-openchat'), stateFile = path.join(inputDir, 'state.json'), proposalFile = path.join(base, 'ai-news-proposals.jsonl'), digestFile = path.join(base, 'ai-news-digest.md'), topicsFile = path.join(base, 'ai-news-topics.jsonl');
  let proposalText = fs.existsSync(proposalFile) ? fs.readFileSync(proposalFile, 'utf8') : '';
  if (cli.list || cli.done || cli.reject) {
    const records = proposalText.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (cli.done || cli.reject) { const id = cli.done || cli.reject, item = records.find((r) => r.id === id); if (!item) throw new Error(`${id} が見つかりません`); item.status = cli.done ? 'done' : 'rejected'; if (!cli.dryRun) fs.writeFileSync(proposalFile, records.map(JSON.stringify).join('\n') + '\n'); }
    records.filter((r) => r.status === 'pending').forEach((r) => log(`${r.id} ${r.title} — ${r.action}`)); return { processed: 0 };
  }
  if (cli.seed) {
    const seed = { id: `seed-${Date.now()}`, chat: '生成AI', sender: 'サンプル参加者', text: 'Claudeの新モデルが公開されたという情報です。料金と性能は公式情報で要検証です。', ts: Date.now(), receivedAt: new Date().toISOString() };
    if (cli.dryRun) log(`[dry-run] サンプルを ${inputDir} に投入`); else { fs.mkdirSync(inputDir, { recursive: true }); const month = new Date().toISOString().slice(0, 7); fs.appendFileSync(path.join(inputDir, `${month}.jsonl`), `${JSON.stringify(seed)}\n`); }
  }
  if (!fs.existsSync(inputDir)) {
    const status = 'skip:入力ディレクトリなし';
    log(status);
    return { processed: 0, status };
  }
  const state = readJson(stateFile, { lastTs: 0, lastId: '', processedIds: [] });
  const candidates = selectUnprocessed(readMessages(inputDir), state, cli.since).slice(0, cli.limit);
  const messages = preprocessMessages(candidates);
  if (!candidates.length) {
    const status = 'skip:新規メッセージなし';
    log('未処理メッセージはありません。');
    log(status);
    return { processed: 0, status };
  }
  const llm = options.llm || createLlmClient({ home, usageFile: path.join(base, 'executor-usage.jsonl') });
  const kept = [], successfullyClassified = new Set(), held = [];
  const classificationSystem = '生成AI・LLMのコスト、品質、新モデル、ツール、プロンプト技法について各入力を分類する。JSONオブジェクトのみを返し、前置き・説明・コードフェンスは禁止。形式は {"items":[{"i":<入力と同じ番号>,"category":"cost|quality|model-release|tool|prompt-technique|other","score":<0-3>}]}。入力の全要素に対して必ず1件ずつ同じiで返す。scoreは0=無関係、1=雑談程度、2=有用、3=自社の設定変更を検討すべき。';
  for (let offset = 0; offset < messages.length; offset += 40) {
    const batch = messages.slice(offset, offset + 40);
    const prompt = batch.map((m, i) => ({ i, text: m.text })).map(JSON.stringify).join('\n');
    let response = await llm({ provider: cli.provider, messages: [{ role: 'system', content: classificationSystem }, { role: 'user', content: prompt }], responseFormat: { type: 'json_object' } });
    let parsed = parseClassifications(response.text);
    if (!parsed.length) {
      response = await llm({ provider: cli.provider, messages: [{ role: 'system', content: `${classificationSystem} 前回の応答はJSONとして解釈できなかった。JSONオブジェクトのみを返せ。` }, { role: 'user', content: prompt }], responseFormat: { type: 'json_object' } });
      parsed = parseClassifications(response.text);
    }
    const byIndex = new Map(parsed.map((r) => [r.i, r]));
    if (!parsed.length) { held.push(...batch); continue; }
    batch.forEach((m, i) => { const c = byIndex.get(i); if (!c) { held.push(m); return; } successfullyClassified.add(m.id); if (c.score >= 2) kept.push({ ...m, classification: c }); });
  }
  const filteredIds = candidates.filter((m) => !messages.includes(m)).map((m) => m.id);
  filteredIds.forEach((id) => successfullyClassified.add(id));
  let digestLines = [], proposals = [];
  const recentKept = kept.filter((m) => Number(m.ts) >= Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (recentKept.length) {
    const grouped = Object.groupBy ? Object.groupBy(recentKept, (m) => m.classification.category) : recentKept.reduce((a, m) => ((a[m.classification.category] ||= []).push(m), a), {});
    const response = await llm({ provider: cli.provider, messages: [{ role: 'system', content: '発言は伝聞であり裏取りされていない。JSONオブジェクトのみを返す。形式は {"digest":["1行目","2行目",...],"proposals":[{"title":"...","action":"...","evidence":"...","category":"cost|quality|model-release|tool|prompt-technique|other","confidence":"high|medium|low"}]}。digestは日本語で3〜10行、具体的な情報のみを1トピック1行で書き、同じ発言を複数行に分割しない。事実のみとし、「伝聞」「未検証」「要検証」「情報が不足」など注意書きだけの行を作らない。提案は必ず要検証と分かる形にし、evidenceは120字以内。発言者名は出さず「参加者」とする。' }, { role: 'user', content: JSON.stringify(grouped) }], responseFormat: { type: 'json_object' } });
    ({ digest: digestLines, proposals } = parseSummary(response.text));
  }
  if (!successfullyClassified.size && candidates.length) throw new Error(`処理できたメッセージがありません（保留 ${held.length}件）`);
  const appended = appendUniqueProposals(proposalText, proposals);
  const pending = appended.records.filter((r) => r.status === 'pending');
  const topicTs = recentKept.reduce((latest, message) => Math.max(latest, Number(message.ts) || 0), 0) || Date.now();
  const topicText = fs.existsSync(topicsFile) ? fs.readFileSync(topicsFile, 'utf8') : '';
  const topics = updateTopics(topicText, digestLines, topicTs);
  const topicLines = topics.records.slice(0, 30).map((topic) => `- ${topic.line.replace(/\b[^\s]+さん/gu, '参加者')}`);
  if (!topicLines.length) topicLines.push('（直近30日で拾えた情報はありません）');
  const body = [`## 📡 生成AI最新情報（LINEオープンチャット / ${new Date().toLocaleString('ja-JP')}）`, ...topicLines, '', `### 未処理の提案 ${pending.length}件`, ...pending.map((p) => `- [${p.id}] ${p.title} — ${p.action}（確度: ${p.confidence} / 要検証）`)].join('\n');
  const existingDigest = fs.existsSync(digestFile) ? fs.readFileSync(digestFile, 'utf8') : '';
  const newDigest = replaceMarkerSection(existingDigest, body);
  const processedIds = [...new Set([...(state.processedIds || []), ...successfullyClassified])].slice(-5000);
  const processedMessages = candidates.filter((m) => successfullyClassified.has(m.id));
  const newest = processedMessages.sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  const nextState = { lastTs: newest?.ts || state.lastTs || 0, lastId: newest?.id || state.lastId || '', processedIds };
  if (cli.dryRun) log(`[dry-run] ${successfullyClassified.size}件処理、${held.length}件保留、提案${appended.added.length}件を更新予定`);
  else {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(digestFile, newDigest); fs.writeFileSync(proposalFile, appended.text); fs.writeFileSync(topicsFile, topics.text); fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2) + '\n');
    log(`line-digest: ${successfullyClassified.size}件処理 / ${held.length}件保留 / トピック${digestLines.length}件 / 新規提案${appended.added.length}件`);
  }
  const status = `ok:${successfullyClassified.size}件処理`;
  log(status);
  return { processed: successfullyClassified.size, held: held.length, proposals: appended.added.length, status };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) runDigest({ args: process.argv.slice(2) }).catch((error) => { console.error(error.message); process.exitCode = 1; });
