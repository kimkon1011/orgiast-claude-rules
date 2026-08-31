#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';
import { readEnvValue } from './env-kv.mjs';

const BASE = 'https://makimono-md.vercel.app';
const currentHome = () => process.env.ORGIAST_HOME || os.homedir();
const homeFile = (name, home = currentHome()) => path.join(home, '.claude', name);
const DAY_MS = 24 * 60 * 60 * 1000;
export const INTERNAL_NAMES = ['オージャスト', 'Reブース', 'Re:ブース', 'NEXTForward', '東邦鋼業', 'ネクサス', 'アウジャスト'];
const patterns = [
  ['APIキー', /sk-[A-Za-z0-9_-]{16,}|mk_[A-Za-z0-9_.-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9_.-]+|github_pat_[A-Za-z0-9_.-]+|xoxb-[A-Za-z0-9_.-]+|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.|Bearer\s+[A-Za-z0-9_.-]{20,}/i],
  ['Webhook URL', /discord(?:app)?\.com\/api\/webhooks\/|hooks\.slack\.com\/|chat\.googleapis\.com\//i],
  ['社内ドメイン', /@orgiast\.jp|orgiast-manual\.com|\.ts\.net\b/i],
  ['Supabaseプロジェクト', /:\/\/[a-z0-9]{15,}\.supabase\.co/i],
  ['GoogleリソースID', /docs\.google\.com\/(?:spreadsheets|document|presentation|forms)\/d\/[A-Za-z0-9_-]{25,}|drive\.google\.com\/(?:file\/d|drive\/folders)\/[A-Za-z0-9_-]{25,}|script\.google\.com\/.*\/d\/[A-Za-z0-9_-]{25,}/i],
  ['Google ID設定', /(?:spreadsheetId|scriptId|folderId|SHEET_ID|FOLDER_ID).*?[A-Za-z0-9_-]{40,}/i],
  ['メールアドレス', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['電話番号', /0\d{1,4}-\d{1,4}-\d{3,4}/],
  ['Windowsユーザーパス', /C:\\Users\\[^\\/\s"']+/i],
  ...INTERNAL_NAMES.map((name) => [`社内固有名:${name}`, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]),
];
function hasNonPlaceholderEmail(line) {
  const withoutBracketed = String(line).replace(/<[^<>\r\n]+>@<[^<>\r\n]+>/g, '').replace(/\{\{[^{}\r\n]+\}\}@\{\{[^{}\r\n]+\}\}/g, '');
  const emails = withoutBracketed.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return emails.some((email) => !/^[^@]+@(?:example(?:\.com|\.org|\.net|\.jp)?|example)$/i.test(email));
}
export function scanForbidden(text, allowed = []) {
  const allow = new Set(allowed); const findings = [];
  String(text).split(/\r?\n/).forEach((line, i) => { for (const [pattern, regex] of patterns) if (!allow.has(pattern) && regex.test(line) && (pattern !== 'メールアドレス' || hasNonPlaceholderEmail(line))) findings.push({ line: i + 1, pattern, sample: redactSecrets(line.trim()).slice(0, 240) }); });
  return findings;
}
function envValues(home = currentHome()) { const result = {}; try { for (const line of fs.readFileSync(homeFile('makimono.env', home), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m) result[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); } } catch {} return result; }
function saveEnv(values, home = currentHome()) { const envFile = homeFile('makimono.env', home); let lines = []; try { lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/); } catch {} for (const [key, value] of Object.entries(values)) { const i = lines.findIndex((x) => x.startsWith(`${key}=`)); if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`); } fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 }); fs.chmodSync(envFile, 0o600); }
export function pickTrustedKey({ home = currentHome(), email }) {
  try {
    const raw = readEnvValue(homeFile('makimono-trusted.env', home), 'MAKIMONO_TRUSTED_KEYS');
    if (!raw) return undefined;
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return undefined;
    const keys = JSON.parse(raw);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return undefined;
    const match = Object.entries(keys).find(([address, key]) => String(address).trim().toLowerCase() === wanted && typeof key === 'string' && key);
    return match?.[1];
  } catch { return undefined; }
}
export async function ensureKey({ home = currentHome(), logTrusted = false, fetchImpl = fetch } = {}) {
  const env = envValues(home);
  let email = env.MAKIMONO_EMAIL || process.env.MAKIMONO_EMAIL || '';
  if (!email) try { email = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress || ''; } catch {}
  if (!email) try { email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim(); } catch {}
  const trustedKey = pickTrustedKey({ home, email });
  if (trustedKey) { if (logTrusted) console.log(`信頼済みキーで出品します（メール: ${email.trim()}）`); return { key: trustedKey, email }; }
  if (env.MAKIMONO_KEY) return { key: env.MAKIMONO_KEY, email: env.MAKIMONO_EMAIL || email };
  if (!email) throw new Error('メールアドレスが特定できないため出品キーを発行できません');
  const response = await fetchImpl(`${BASE}/api/v1/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`キー発行 HTTP ${response.status}`); const data = await response.json(); saveEnv({ MAKIMONO_KEY: data.apiKey, MAKIMONO_EMAIL: email }, home); return { key: data.apiKey, email };
}
const val = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const allows = (args) => args.flatMap((x, i) => x === '--allow' ? [args[i + 1]] : []).filter(Boolean);
function showFindings(findings) { findings.forEach((x) => console.error(`${x.line}行目 [${x.pattern}] ${x.sample}`)); }
function slugify(s) { return String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'draft'; }
function normalizedTitle(title) { return String(title ?? '').normalize('NFKC').replace(/\s/gu, '').toLowerCase(); }
function similarityText(value) { return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function bigrams(value) {
  const normalized = similarityText(value); const result = new Set();
  for (let i = 0; i < normalized.length - 1; i++) result.add(normalized.slice(i, i + 2));
  return result;
}
const SIMILARITY_STOP_WORDS = new Set(['する', 'こと', 'ため', '方法', '手順', '対策', '問題', '自動', '設定', '確認', '作る', '直す', '止める', '使う', '実装', '運用', '場合', '内容', '状態', '必要', '処理', '仕組み', '全部', '毎回']);
function terms(title, summary) {
  const matches = `${String(title ?? '')} ${String(summary ?? '')}`.normalize('NFKC').match(/[ァ-ヶー]{2,}|[A-Za-z][A-Za-z0-9.+#-]{1,}|[一-龠々]{2,}/gu) || [];
  return new Set(matches.map((term) => term.toLowerCase()).filter((term) => !SIMILARITY_STOP_WORDS.has(term)));
}
function overlapSize(left, right) { let count = 0; for (const value of left) if (right.has(value)) count++; return count; }
// 出品後は取り下げられないため、文字面か特徴語の片方が近ければ警告して取りこぼしを避ける。
// threshold 0.3 は実データで決めた値。審査待ち31件を投稿順に再生すると、
// 既知の重複8件(MCP「接続済み」6件 / 記憶索引 / 夜間バッチ)を全部止めつつ誤検知は3件で済む。
// 0.35 まで上げると言い換えの大きい2件を取り逃がし、0.25 まで下げると16件が止まり警告が形骸化する。
export function findSimilarPending(logs, candidate, { threshold = 0.3, limit = 5 } = {}) {
  const candidateBigrams = bigrams(candidate?.title); const candidateTerms = terms(candidate?.title, candidate?.summary);
  return (Array.isArray(logs) ? logs : []).filter((entry) => entry?.status !== 'published' && entry?.status !== 'rejected').map((entry) => {
    const entryBigrams = bigrams(entry?.title); const entryTerms = terms(entry?.title, entry?.summary);
    const diceBigram = candidateBigrams.size && entryBigrams.size ? (2 * overlapSize(candidateBigrams, entryBigrams)) / (candidateBigrams.size + entryBigrams.size) : 0;
    const termOverlap = candidateTerms.size && entryTerms.size ? overlapSize(candidateTerms, entryTerms) / Math.min(candidateTerms.size, entryTerms.size) : 0;
    return { title: entry?.title, submissionId: entry?.submissionId, at: entry?.at, rawScore: Math.max(diceBigram, termOverlap) };
  }).filter((entry) => entry.rawScore >= threshold).sort((a, b) => b.rawScore - a.rawScore || (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0)).slice(0, Math.max(0, limit)).map(({ rawScore, ...entry }) => ({ ...entry, score: Math.round(rawScore * 100) / 100 }));
}
export function reconcileSubmissions(logs, listings, now, staleDays) {
  const nowMs = new Date(now).getTime();
  const publishedByTitle = new Map((Array.isArray(listings) ? listings : []).map((listing) => [normalizedTitle(listing?.title), listing]));
  const nextLogs = (Array.isArray(logs) ? logs : []).map((entry) => {
    if (entry?.status === 'published') return entry;
    const listing = publishedByTitle.get(normalizedTitle(entry?.title));
    if (!listing) return entry;
    return { ...entry, status: 'published', slug: listing.slug, publishedSeenAt: new Date(nowMs).toISOString() };
  });
  const pendingItems = nextLogs.filter((entry) => entry?.status !== 'published' && entry?.status !== 'rejected').map((entry) => {
    const atMs = new Date(entry?.at).getTime();
    const ageMs = Number.isFinite(atMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - atMs) : 0;
    return { title: entry?.title || '(無題)', submissionId: entry?.submissionId || '', days: Math.floor(ageMs / DAY_MS), stale: ageMs > Number(staleDays) * DAY_MS };
  });
  return {
    logs: nextLogs,
    published: nextLogs.filter((entry) => entry?.status === 'published').length,
    pending: pendingItems.length,
    rejected: nextLogs.filter((entry) => entry?.status === 'rejected').length,
    stale: pendingItems.filter((item) => item.stale).length,
    pendingItems,
  };
}
function readSubmissionLogs(home = currentHome()) {
  try { const logs = JSON.parse(fs.readFileSync(homeFile('makimono-submissions.json', home), 'utf8')); return Array.isArray(logs) ? logs : []; } catch { return []; }
}
function bodyHash(body) { return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16); }
function queueDir(home = currentHome()) { return homeFile('makimono-queue', home); }
function saveForbiddenDraft({ home, title, body, findings, now = new Date() }) {
  const draft = path.join(home, '.claude', 'makimono-drafts', `${new Date(now).toISOString().slice(0, 10)}-${slugify(title)}.md`);
  fs.mkdirSync(path.dirname(draft), { recursive: true }); fs.writeFileSync(draft, body);
  showFindings(findings); console.error(`送信せず下書きへ退避: ${draft}\n一般名に置換してから出品してください`);
  return draft;
}
function showSimilar(similarPending) {
  console.error('審査待ちに近い題名があります（取り下げ経路は無いので出す前に確認してください）');
  similarPending.forEach((entry) => console.error(`- ${entry.title} (${entry.submissionId} / 出品 ${String(entry.at ?? '').slice(0, 10)} / 類似度 ${entry.score})`));
}
function queuedMetadata(home) {
  const dir = queueDir(home); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
    try { return [{ name, data: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }]; } catch { return []; }
  });
}
export async function queueSubmission({ home = currentHome(), fetchImpl = fetch, body, inputFile, title = '', summary = '', category = '', scratchTokens = 0, withMdTokens = 0, price = 0, allowed = [], force = false, dry = false, now = new Date() } = {}) {
  body = body ?? fs.readFileSync(inputFile, 'utf8');
  const findings = scanForbidden(body, allowed);
  if (findings.length) { saveForbiddenDraft({ home, title, body, findings, now }); return { ok: false, reason: 'forbidden', findings }; }
  const reasons = []; if (title.length < 5) reasons.push('title は5文字以上'); if (summary.length < 20) reasons.push('summary は20文字以上'); if (body.length < 200) reasons.push('body は200文字以上');
  const categoriesResponse = await fetchImpl(`${BASE}/api/v1/categories`, { signal: AbortSignal.timeout(8000) });
  if (!categoriesResponse.ok) throw new Error(`カテゴリ取得 HTTP ${categoriesResponse.status}`);
  const categories = (await categoriesResponse.json()).categories?.map((x) => x.name) || [];
  if (!categories.includes(category)) reasons.push(`category は既存カテゴリから選択: ${categories.join(' / ')}`);
  if (reasons.length) { reasons.forEach((x) => console.error(x)); return { ok: false, reason: 'validation', reasons }; }
  if (Number(price) !== 0) { console.error('price は常に 0（無料）です'); return { ok: false, reason: 'price' }; }
  const logs = readSubmissionLogs(home); const sha256 = bodyHash(body);
  const similarPending = findSimilarPending(logs, { title, summary });
  if (similarPending.length) {
    showSimilar(similarPending);
    if (!force) { console.error('同主題なら出品せず既存に寄せる。別主題だと確認できたら `--force` を付けて再実行してください'); return { ok: false, reason: 'similar', similarPending }; }
  }
  const acknowledgedSimilar = similarPending.map((entry) => entry.submissionId).filter(Boolean);
  const at = new Date(now).toISOString();
  const metadata = { at, title, summary, category, scratchTokens: Number(scratchTokens || 0), withMdTokens: Number(withMdTokens || 0), price: 0, sha256, bodyFile: '', acknowledgedSimilar };
  const basename = `${at.replace(/[:.]/g, '-')}-${slugify(title)}`; metadata.bodyFile = `${basename}.md`;
  if (dry) { console.log(JSON.stringify({ ...metadata, body: `${body.slice(0, 200)}… (${body.length}文字)` }, null, 2)); return { ok: true, dry: true, metadata }; }
  if (logs.some((x) => x.sha256 === sha256)) { console.log('同一内容を出品済み'); return { ok: true, duplicate: 'submitted' }; }
  if (queuedMetadata(home).some(({ data }) => data.sha256 === sha256)) { console.log('同一内容がキュー済み'); return { ok: true, duplicate: 'queued' }; }
  const dir = queueDir(home); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, metadata.bodyFile), body);
  const jsonName = `${basename}.json`; fs.writeFileSync(path.join(dir, jsonName), `${JSON.stringify(metadata, null, 2)}\n`);
  const result = { queued: jsonName, acknowledgedSimilar }; console.log(JSON.stringify(result)); return { ok: true, ...result };
}
async function notifyHeld(held, { home, fetchImpl, webhookUrl }) {
  if (!held.length) return;
  const webhook = webhookUrl || readEnvValue(homeFile('cost-reporter.env', home), 'DISCORD_COST_WEBHOOK');
  if (!webhook) { console.error('DISCORD_COST_WEBHOOK が未設定のため通知しません'); return; }
  const content = `📜 マキモノ: キュー保留 ${held.length}件\n${held.map((item) => `- ${item.title || '(無題)'} / ${item.reason} / ${item.file}`).join('\n')}`.slice(0, 1900);
  const response = await fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Discord通知 HTTP ${response.status}`);
}
export async function drainQueue({ home = currentHome(), fetchImpl = fetch, notify = false, webhookUrl, check = true } = {}) {
  const dir = queueDir(home); const held = []; let sent = 0;
  const entries = queuedMetadata(home).sort((a, b) => String(a.data?.at || '').localeCompare(String(b.data?.at || '')));
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json'))) if (!entries.some((entry) => entry.name === name)) console.error(`warn: 壊れたキューJSONを飛ばします: ${name}`);
  for (const { name, data } of entries) {
    const bodyPath = path.join(dir, path.basename(String(data.bodyFile || ''))); let body;
    try { body = fs.readFileSync(bodyPath, 'utf8'); } catch { console.error(`warn: 本文を読めません: ${name}`); held.push({ title: data.title, reason: '本文を読めない', file: name }); continue; }
    const findings = scanForbidden(body);
    if (findings.length) { console.error(`warn: 送信禁止パターンを検出: ${name}`); held.push({ title: data.title, reason: '送信禁止パターン', file: name }); continue; }
    let logs = readSubmissionLogs(home); const sha256 = bodyHash(body);
    if (logs.some((entry) => entry.sha256 === sha256)) { fs.unlinkSync(path.join(dir, name)); fs.unlinkSync(bodyPath); continue; }
    const acknowledged = new Set(Array.isArray(data.acknowledgedSimilar) ? data.acknowledgedSimilar : []);
    const unseen = findSimilarPending(logs, data).filter((entry) => !acknowledged.has(entry.submissionId));
    if (unseen.length) { held.push({ title: data.title, reason: `未確認の近似 ${unseen.map((x) => x.submissionId).join(',')}`, file: name }); continue; }
    try {
      const auth = await ensureKey({ home, fetchImpl });
      const payload = { title: data.title, summary: data.summary, category: data.category, body, scratchTokens: Number(data.scratchTokens || 0), withMdTokens: Number(data.withMdTokens || 0), price: 0 };
      const response = await fetchImpl(`${BASE}/api/v1/listings`, { method: 'POST', headers: { authorization: `Bearer ${auth.key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      const result = await response.json(); if (!response.ok) throw new Error(`出品 HTTP ${response.status}: ${result.error || '失敗'}`);
      logs.push({ at: new Date().toISOString(), title: data.title, summary: data.summary, category: data.category, submissionId: result.submissionId, status: result.status, email: auth.email, sha256 });
      const logFile = homeFile('makimono-submissions.json', home); fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `${JSON.stringify(logs, null, 2)}\n`);
      fs.unlinkSync(path.join(dir, name)); fs.unlinkSync(bodyPath); sent++;
    } catch (error) { const reason = String(error?.message || error).split(/\r?\n/, 1)[0]; console.error(`warn: ${name}: ${reason}`); held.push({ title: data.title, reason, file: name }); }
  }
  if (sent && check) await safeCheck([], { compact: true, home, fetchImpl });
  if (notify && held.length) try { await notifyHeld(held, { home, fetchImpl, webhookUrl }); } catch (error) { console.error(`warn: 保留通知失敗: ${error.message}`); }
  const remaining = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length : 0;
  const summary = { sent, held: held.length, remaining }; console.log(JSON.stringify(summary)); return summary;
}
function listingsFromSearch(data) { return Array.isArray(data) ? data : data?.listings || data?.files || data?.results || []; }
function formatCheckSummary(result) { return `公開済み ${result.published}件 / 審査待ち ${result.pending}件 / 却下 ${result.rejected}件`; }
export async function notifyStale(result, staleDays, { forceNotify = false, now = new Date(), fetchImpl = fetch, stateFile = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'makimono-notify-state.json'), webhookUrl } = {}) {
  if (!result.stale) return;
  const staleIds = result.pendingItems.filter((item) => item.stale).map((item) => item.submissionId || '').sort();
  let previous;
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const previousIds = Array.isArray(previous?.staleIds) ? [...previous.staleIds].sort() : [];
  const sameIds = staleIds.length === previousIds.length && staleIds.every((id, index) => id === previousIds[index]);
  const lastMs = new Date(previous?.notifiedAt).getTime();
  const reminderDue = !Number.isFinite(lastMs) || new Date(now).getTime() - lastMs >= 7 * DAY_MS;
  if (!forceNotify && previous && previous.stale === result.stale && sameIds && !reminderDue) {
    console.log(`前回と同内容のため通知しません（前回 ${previous.notifiedAt}）`);
    return false;
  }
  const webhook = webhookUrl || readEnvValue(homeFile('cost-reporter.env'), 'DISCORD_COST_WEBHOOK');
  if (!webhook) { console.error('DISCORD_COST_WEBHOOK が未設定のため通知しません'); return; }
  const titles = result.pendingItems.slice(0, 5).map((item) => `- ${item.title}`).join('\n');
  const content = `📜 マキモノ: 審査待ち ${result.pending}件(うち ${staleDays}日超 ${result.stale}件)${titles ? `\n${titles}` : ''}\n承認は本体リポ側で docs/makimono-auto-approve.md の実行が必要です。`.slice(0, 1900);
  const response = await fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Discord通知 HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ notifiedAt: new Date(now).toISOString(), pending: result.pending, stale: result.stale, staleIds }, null, 2)}\n`);
  return true;
}
async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length); let cursor = 0;
  async function worker() { while (cursor < items.length) { const index = cursor++; results[index] = await mapper(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
export async function checkSubmissions(args, { compact = false, home = currentHome(), fetchImpl = fetch, now = new Date() } = {}) {
  const logFile = homeFile('makimono-submissions.json', home);
  if (!fs.existsSync(logFile)) { console.log('出品ログなし'); return null; }
  const logs = readSubmissionLogs(home);
  const staleDays = Math.max(0, Number(val(args, '--stale-days') ?? 3) || 0);
  const unresolved = logs.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry?.status !== 'published' && entry?.submissionId);
  let auth;
  try { auth = await ensureKey({ home, fetchImpl }); } catch {}
  const statusResults = await mapLimited(unresolved, 4, async ({ entry, index }) => {
    try {
      if (!auth?.key) return { index, failed: true };
      const response = await fetchImpl(`${BASE}/api/v1/listings/${encodeURIComponent(entry.submissionId)}`, { headers: { authorization: `Bearer ${auth.key}` }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return { index, failed: true };
      const data = await response.json();
      if (!['pending', 'published', 'rejected'].includes(data?.status)) return { index, failed: true };
      return { index, data };
    } catch { return { index, failed: true }; }
  });
  const statusLogs = logs.map((entry) => entry);
  const failedIndexes = new Set(logs.map((_, index) => index));
  for (const item of statusResults) if (!item.failed) { statusLogs[item.index] = { ...statusLogs[item.index], status: item.data.status, ...(item.data.slug ? { slug: item.data.slug } : {}) }; failedIndexes.delete(item.index); }
  let listings = [];
  try { const response = await fetchImpl(`${BASE}/api/v1/search?limit=200`, { signal: AbortSignal.timeout(15_000) }); if (response.ok) listings = listingsFromSearch(await response.json()); } catch {}
  const fallbackLogs = statusLogs.map((entry, index) => failedIndexes.has(index) ? entry : { ...entry, status: 'published' });
  const fallback = reconcileSubmissions(fallbackLogs, listings, now, staleDays).logs;
  const mergedLogs = fallback.map((entry, index) => failedIndexes.has(index) ? entry : statusLogs[index]);
  const result = reconcileSubmissions(mergedLogs, [], now, staleDays);
  if (result.logs.some((entry, index) => entry !== logs[index])) fs.writeFileSync(logFile, `${JSON.stringify(result.logs, null, 2)}\n`);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ published: result.published, pending: result.pending, rejected: result.rejected, stale: result.stale, items: result.pendingItems }));
  } else if (compact) {
    console.log(formatCheckSummary(result));
  } else {
    console.log(formatCheckSummary(result));
    result.pendingItems.forEach((item) => console.log(`- ${item.title} (${item.submissionId || 'ID不明'} / 出品から ${item.days}日)`));
    if (result.stale) console.log(`⚠️ ${result.stale}件が既定日数を超えて審査待ちです`);
  }
  if (args.includes('--notify')) await notifyStale(result, staleDays, { forceNotify: args.includes('--force-notify') });
  return result;
}
async function safeCheck(args, options) {
  try { return await checkSubmissions(args, options); } catch (error) { console.error(`マキモノ確認失敗: ${String(error?.message || error).split(/\r?\n/, 1)[0]}`); return null; }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--drain-queue')) { await drainQueue({ notify: args.includes('--notify') }); return; }
  if (args.includes('--check')) { await safeCheck(args); return; }
  if (args.includes('--ensure-key')) { console.log((await ensureKey()).key); return; }
  if (args.includes('--list')) { let logs = []; try { logs = JSON.parse(fs.readFileSync(homeFile('makimono-submissions.json'), 'utf8')); } catch {} console.log(JSON.stringify(logs, null, 2)); return; }
  const inputFile = val(args, '--file'); if (!inputFile) throw new Error('--file が必要です'); const body = fs.readFileSync(inputFile, 'utf8'); const findings = scanForbidden(body, allows(args));
  if (args.includes('--scan')) { if (findings.length) { showFindings(findings); process.exitCode = 2; } else console.log('送信禁止パターン: 0件'); return; }
  if (args.includes('--queue')) {
    const result = await queueSubmission({ body, title: val(args, '--title') || '', summary: val(args, '--summary') || '', category: val(args, '--category') || '', scratchTokens: val(args, '--scratch-tokens'), withMdTokens: val(args, '--with-md-tokens'), price: val(args, '--price') ?? 0, allowed: allows(args), force: args.includes('--force'), dry: args.includes('--dry') });
    if (!result.ok) process.exitCode = 2; return;
  }
  if (!args.includes('--submit')) throw new Error('--submit、--queue、--drain-queue、--scan、--ensure-key、--list のいずれかが必要です');
  const title = val(args, '--title') || '', summary = val(args, '--summary') || '', category = val(args, '--category') || '';
  if (findings.length) { const draft = path.join(currentHome(), '.claude', 'makimono-drafts', `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`); fs.mkdirSync(path.dirname(draft), { recursive: true }); fs.writeFileSync(draft, body); showFindings(findings); console.error(`送信せず下書きへ退避: ${draft}\n一般名に置換してから出品してください`); process.exitCode = 2; return; }
  const reasons = []; if (title.length < 5) reasons.push('title は5文字以上'); if (summary.length < 20) reasons.push('summary は20文字以上'); if (body.length < 200) reasons.push('body は200文字以上');
  const categoriesResponse = await fetch(`${BASE}/api/v1/categories`, { signal: AbortSignal.timeout(8000) }); if (!categoriesResponse.ok) throw new Error(`カテゴリ取得 HTTP ${categoriesResponse.status}`); const categories = (await categoriesResponse.json()).categories?.map((x) => x.name) || []; if (!categories.includes(category)) reasons.push(`category は既存カテゴリから選択: ${categories.join(' / ')}`);
  if (reasons.length) { reasons.forEach((x) => console.error(x)); process.exitCode = 2; return; }
  if (val(args, '--price') && Number(val(args, '--price')) !== 0) { console.error('price は常に 0（無料）です'); process.exitCode = 2; return; }
  let logs = readSubmissionLogs(); const logFile = homeFile('makimono-submissions.json');
  const similarPending = findSimilarPending(logs, { title, summary });
  if (similarPending.length) {
    console.error('審査待ちに近い題名があります（取り下げ経路は無いので出す前に確認してください）');
    similarPending.forEach((entry) => console.error(`- ${entry.title} (${entry.submissionId} / 出品 ${String(entry.at ?? '').slice(0, 10)} / 類似度 ${entry.score})`));
    if (!args.includes('--force')) { console.error('同主題なら出品せず既存に寄せる。別主題だと確認できたら `--force` を付けて再実行してください'); process.exitCode = 2; return; }
    console.error('`--force` が指定されたため出品を続行します');
  }
  const payload = { title, summary, category, body, scratchTokens: Number(val(args, '--scratch-tokens') || 0), withMdTokens: Number(val(args, '--with-md-tokens') || 0), price: 0 };
  if (args.includes('--dry')) { console.log(JSON.stringify({ ...payload, body: `${body.slice(0, 200)}… (${body.length}文字)` }, null, 2)); return; }
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16); if (logs.some((x) => x.sha256 === hash)) { console.log('同一内容を出品済み'); return; }
  const auth = await ensureKey({ logTrusted: true }); const response = await fetch(`${BASE}/api/v1/listings`, { method: 'POST', headers: { authorization: `Bearer ${auth.key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) }); const data = await response.json(); if (!response.ok) throw new Error(`出品 HTTP ${response.status}: ${data.error || '失敗'}`);
  logs.push({ at: new Date().toISOString(), title, summary, category, submissionId: data.submissionId, status: data.status, email: auth.email, sha256: hash }); fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `${JSON.stringify(logs, null, 2)}\n`);
  console.log(JSON.stringify({ submissionId: data.submissionId, status: data.status })); console.log('確認: https://makimono-md.vercel.app/contribute');
  if (!args.includes('--no-check')) await safeCheck(args, { compact: true });
}
if (isEntry(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
