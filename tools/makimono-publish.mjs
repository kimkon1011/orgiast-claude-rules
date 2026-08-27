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
const home = process.env.ORGIAST_HOME || os.homedir();
const envFile = path.join(home, '.claude', 'makimono.env');
const logFile = path.join(home, '.claude', 'makimono-submissions.json');
const costReporterEnvFile = path.join(home, '.claude', 'cost-reporter.env');
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
function envValues() { const result = {}; try { for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m) result[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); } } catch {} return result; }
function saveEnv(values) { let lines = []; try { lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/); } catch {} for (const [key, value] of Object.entries(values)) { const i = lines.findIndex((x) => x.startsWith(`${key}=`)); if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`); } fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 }); fs.chmodSync(envFile, 0o600); }
async function ensureKey() {
  const env = envValues(); if (env.MAKIMONO_KEY) return { key: env.MAKIMONO_KEY, email: env.MAKIMONO_EMAIL || '' };
  let email = process.env.MAKIMONO_EMAIL || env.MAKIMONO_EMAIL || '';
  if (!email) try { email = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress || ''; } catch {}
  if (!email) try { email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim(); } catch {}
  if (!email) throw new Error('メールアドレスが特定できないため出品キーを発行できません');
  const response = await fetch(`${BASE}/api/v1/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`キー発行 HTTP ${response.status}`); const data = await response.json(); saveEnv({ MAKIMONO_KEY: data.apiKey, MAKIMONO_EMAIL: email }); return { key: data.apiKey, email };
}
const val = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const allows = (args) => args.flatMap((x, i) => x === '--allow' ? [args[i + 1]] : []).filter(Boolean);
function showFindings(findings) { findings.forEach((x) => console.error(`${x.line}行目 [${x.pattern}] ${x.sample}`)); }
function slugify(s) { return String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'draft'; }
function normalizedTitle(title) { return String(title ?? '').normalize('NFKC').replace(/\s/gu, '').toLowerCase(); }
export function reconcileSubmissions(logs, listings, now, staleDays) {
  const nowMs = new Date(now).getTime();
  const publishedByTitle = new Map((Array.isArray(listings) ? listings : []).map((listing) => [normalizedTitle(listing?.title), listing]));
  const nextLogs = (Array.isArray(logs) ? logs : []).map((entry) => {
    if (entry?.status === 'published') return entry;
    const listing = publishedByTitle.get(normalizedTitle(entry?.title));
    if (!listing) return entry;
    return { ...entry, status: 'published', slug: listing.slug, publishedSeenAt: new Date(nowMs).toISOString() };
  });
  const pendingItems = nextLogs.filter((entry) => entry?.status !== 'published').map((entry) => {
    const atMs = new Date(entry?.at).getTime();
    const ageMs = Number.isFinite(atMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - atMs) : 0;
    return { title: entry?.title || '(無題)', submissionId: entry?.submissionId || '', days: Math.floor(ageMs / DAY_MS), stale: ageMs > Number(staleDays) * DAY_MS };
  });
  return {
    logs: nextLogs,
    published: nextLogs.length - pendingItems.length,
    pending: pendingItems.length,
    stale: pendingItems.filter((item) => item.stale).length,
    pendingItems,
  };
}
function readSubmissionLogs() {
  try { const logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); return Array.isArray(logs) ? logs : []; } catch { return []; }
}
function listingsFromSearch(data) { return Array.isArray(data) ? data : data?.listings || data?.files || data?.results || []; }
function formatCheckSummary(result) { return `公開済み ${result.published}件 / 審査待ち ${result.pending}件`; }
async function notifyStale(result, staleDays) {
  if (!result.stale) return;
  const webhook = readEnvValue(costReporterEnvFile, 'DISCORD_COST_WEBHOOK');
  if (!webhook) { console.error('DISCORD_COST_WEBHOOK が未設定のため通知しません'); return; }
  const titles = result.pendingItems.slice(0, 5).map((item) => `- ${item.title}`).join('\n');
  const content = `📜 マキモノ: 審査待ち ${result.pending}件(うち ${staleDays}日超 ${result.stale}件)${titles ? `\n${titles}` : ''}`.slice(0, 1900);
  const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Discord通知 HTTP ${response.status}`);
}
async function checkSubmissions(args, { compact = false } = {}) {
  if (!fs.existsSync(logFile)) { console.log('出品ログなし'); return null; }
  const logs = readSubmissionLogs();
  const staleDays = Math.max(0, Number(val(args, '--stale-days') ?? 3) || 0);
  const response = await fetch(`${BASE}/api/v1/search?limit=200`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`公開済み一覧取得 HTTP ${response.status}`);
  const result = reconcileSubmissions(logs, listingsFromSearch(await response.json()), new Date(), staleDays);
  if (result.logs.some((entry, index) => entry !== logs[index])) fs.writeFileSync(logFile, `${JSON.stringify(result.logs, null, 2)}\n`);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ published: result.published, pending: result.pending, stale: result.stale, items: result.pendingItems }));
  } else if (compact) {
    console.log(formatCheckSummary(result));
  } else {
    console.log(formatCheckSummary(result));
    result.pendingItems.forEach((item) => console.log(`- ${item.title} (${item.submissionId || 'ID不明'} / 出品から ${item.days}日)`));
    if (result.stale) console.log(`⚠️ ${result.stale}件が既定日数を超えて審査待ちです`);
  }
  if (args.includes('--notify')) await notifyStale(result, staleDays);
  return result;
}
async function safeCheck(args, options) {
  try { return await checkSubmissions(args, options); } catch (error) { console.error(`マキモノ確認失敗: ${String(error?.message || error).split(/\r?\n/, 1)[0]}`); return null; }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) { await safeCheck(args); return; }
  if (args.includes('--ensure-key')) { console.log((await ensureKey()).key); return; }
  if (args.includes('--list')) { let logs = []; try { logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {} console.log(JSON.stringify(logs, null, 2)); return; }
  const inputFile = val(args, '--file'); if (!inputFile) throw new Error('--file が必要です'); const body = fs.readFileSync(inputFile, 'utf8'); const findings = scanForbidden(body, allows(args));
  if (args.includes('--scan')) { if (findings.length) { showFindings(findings); process.exitCode = 2; } else console.log('送信禁止パターン: 0件'); return; }
  if (!args.includes('--submit')) throw new Error('--submit、--scan、--ensure-key、--list のいずれかが必要です');
  const title = val(args, '--title') || '', summary = val(args, '--summary') || '', category = val(args, '--category') || '';
  if (findings.length) { const draft = path.join(home, '.claude', 'makimono-drafts', `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`); fs.mkdirSync(path.dirname(draft), { recursive: true }); fs.writeFileSync(draft, body); showFindings(findings); console.error(`送信せず下書きへ退避: ${draft}\n一般名に置換してから出品してください`); process.exitCode = 2; return; }
  const reasons = []; if (title.length < 5) reasons.push('title は5文字以上'); if (summary.length < 20) reasons.push('summary は20文字以上'); if (body.length < 200) reasons.push('body は200文字以上');
  const categoriesResponse = await fetch(`${BASE}/api/v1/categories`, { signal: AbortSignal.timeout(8000) }); if (!categoriesResponse.ok) throw new Error(`カテゴリ取得 HTTP ${categoriesResponse.status}`); const categories = (await categoriesResponse.json()).categories?.map((x) => x.name) || []; if (!categories.includes(category)) reasons.push(`category は既存カテゴリから選択: ${categories.join(' / ')}`);
  if (reasons.length) { reasons.forEach((x) => console.error(x)); process.exitCode = 2; return; }
  if (val(args, '--price') && Number(val(args, '--price')) !== 0) { console.error('price は常に 0（無料）です'); process.exitCode = 2; return; }
  const payload = { title, summary, category, body, scratchTokens: Number(val(args, '--scratch-tokens') || 0), withMdTokens: Number(val(args, '--with-md-tokens') || 0), price: 0 };
  if (args.includes('--dry')) { console.log(JSON.stringify({ ...payload, body: `${body.slice(0, 200)}… (${body.length}文字)` }, null, 2)); return; }
  let logs = readSubmissionLogs();
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16); if (logs.some((x) => x.sha256 === hash)) { console.log('同一内容を出品済み'); return; }
  const auth = await ensureKey(); const response = await fetch(`${BASE}/api/v1/listings`, { method: 'POST', headers: { authorization: `Bearer ${auth.key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) }); const data = await response.json(); if (!response.ok) throw new Error(`出品 HTTP ${response.status}: ${data.error || '失敗'}`);
  logs.push({ at: new Date().toISOString(), title, category, submissionId: data.submissionId, status: data.status, email: auth.email, sha256: hash }); fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `${JSON.stringify(logs, null, 2)}\n`);
  console.log(JSON.stringify({ submissionId: data.submissionId, status: data.status })); console.log('確認: https://makimono-md.vercel.app/contribute');
  if (!args.includes('--no-check')) await safeCheck(args, { compact: true });
}
if (isEntry(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
