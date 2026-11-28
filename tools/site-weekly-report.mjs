#!/usr/bin/env node
/**
 * site-weekly-report.mjs — コーポレートサイト週次レポート＋対応漏れ検出
 *
 * 週次: GA4 セッション（月〜日）＋問い合わせ一覧を Discord チャンネルへ投稿
 * 対応漏れ: 問い合わせシート M列が「完了」でない・受付24h超を1日1回まとめて投稿
 *
 *   node tools/site-weekly-report.mjs [--dry-run] [--json] [--discover]
 *   node tools/site-weekly-report.mjs --check-unanswered [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getToken } from './google-property-check.mjs';
import { defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { INQUIRY_SHEET, INQUIRY_TAB, readSheet, excludedInquiry, dateISO } from './lib/inquiry-sheet.mjs';
import { searchGmail } from './gmail-search.mjs';
import { gate, commit, fingerprint, recordRun } from './lib/change-gate.mjs';
import { resolveDiscordBotToken } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(REPO_ROOT, 'config', 'site-weekly-report.json');
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GA4_ADMIN_URL = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200';
const DISCORD_API = 'https://discord.com/api/v10';
const CHANGE_GATE_WEEKLY = 'site-weekly-report';
const CHANGE_GATE_UNANSWERED = 'site-weekly-unanswered';

export function statePath(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'state', 'site-weekly-report.json');
}

export function loadState(home) {
  try { return JSON.parse(fs.readFileSync(statePath(home), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { notifiedUnanswered: {} }; throw e; }
}

export function saveState(state, home) {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function loadConfig(configPath = DEFAULT_CONFIG) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function saveConfig(config, configPath = DEFAULT_CONFIG) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** JST の年月日部品 */
export function jstParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: parts.weekday, // Mon,Tue,...
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

function jstDateUtc(y, m, d) {
  // JST 0:00 を UTC Date に
  return new Date(Date.UTC(y, m - 1, d, -9, 0, 0));
}

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

/**
 * 直近の完了した月〜日（JST）。実行日が水曜なら直前の月〜日。
 */
export function weekRange(now = new Date()) {
  const p = jstParts(now);
  const todayIdx = WEEKDAY_INDEX[p.weekday];
  // 直近の日曜（今日が日曜なら今日、それ以外は前の日曜）
  const daysSinceSunday = todayIdx === 0 ? 0 : todayIdx;
  // 完了週: 今日が日曜以外なら「前の日曜」を週末日、今日が日曜ならその週は当日まで未完了なのでさらに前週
  const endOffset = todayIdx === 0 ? 7 : daysSinceSunday;
  const end = jstDateUtc(p.year, p.month, p.day);
  end.setUTCDate(end.getUTCDate() - endOffset);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - 6);
  const iso = (d) => {
    const x = jstParts(d);
    return `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}`;
  };
  const md = (d) => {
    const x = jstParts(d);
    return `${x.month}/${x.day}`;
  };
  return {
    startDate: iso(start),
    endDate: iso(end),
    prevStartDate: iso(prevStart),
    prevEndDate: iso(prevEnd),
    label: `${md(start)}〜${md(end)}`,
    startMs: start.getTime(),
    endMs: end.getTime() + 24 * 3600 * 1000 - 1, // 日曜 23:59:59.999 JST 相当
  };
}

export function parseArgs(argv) {
  const out = { flags: new Set(), config: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--json' || a === '--discover' || a === '--check-unanswered' || a === '--help' || a === '-h') {
      out.flags.add(a.replace(/^--/, '').replace(/^-/, ''));
      if (a === '-h') out.flags.add('help');
      continue;
    }
    if (a === '--config') { out.config = argv[++i]; continue; }
    if (a.startsWith('--')) throw new Error(`不明な引数: ${a}`);
  }
  return out;
}

function loadSaKey() {
  const keyPath = process.env.GOOGLE_SA_KEY || defaultDriveKeyPath();
  if (!fs.existsSync(keyPath)) throw new Error(`SA鍵が見つかりません: ${keyPath}`);
  return { key: JSON.parse(fs.readFileSync(keyPath, 'utf8')), keyPath };
}

export async function fetchGa4Sessions(propertyId, startDate, endDate, { token, fetchImpl = globalThis.fetch, signal } = {}) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const res = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'sessions' }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error?.message || `GA4 HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.detail = json;
    throw err;
  }
  const value = Number(json.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export async function listGa4Properties({ token, fetchImpl = globalThis.fetch, signal } = {}) {
  const out = [];
  let pageToken;
  do {
  const res = await fetchImpl(GA4_ADMIN_URL + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''), {
    signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Admin API HTTP ${res.status}`);
  for (const account of json.accountSummaries || []) {
    for (const p of account.propertySummaries || []) {
      const id = String(p.property || '').replace(/^properties\//, '');
      out.push({
        propertyId: id,
        displayName: p.displayName || '',
        account: account.displayName || '',
      });
    }
  }
  pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export function matchProperty(properties, site) {
  if (site.propertyId) {
    const hit = properties.find(p => p.propertyId === String(site.propertyId));
    return { propertyId: String(site.propertyId), matchedBy: 'config', displayName: hit?.displayName || site.name };
  }
  const needles = [site.domain, site.name, site.id].filter(Boolean).map(s => String(s).toLowerCase());
  const hit = properties.find(p => {
    const hay = `${p.displayName} ${p.account}`.toLowerCase();
    return needles.some(n => n && hay.includes(n.toLowerCase()));
  });
  if (hit) return { propertyId: hit.propertyId, matchedBy: 'name', displayName: hit.displayName };
  return null;
}

export function pctChange(current, previous) {
  if (previous == null || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export function formatPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '前週比 —';
  const sign = pct > 0 ? '+' : '';
  return `前週比 ${sign}${pct}%`;
}

export function inWeek(isoOrMs, week) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return false;
  return ms >= week.startMs && ms <= week.endMs;
}

export function sheetInquiries(values, week) {
  const headers = values[0] || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (excludedInquiry(row, headers)) continue;
    const date = dateISO(row[0]);
    if (!date || !inWeek(date, week)) continue;
    rows.push({
      key: `sheet:${i + 1}`,
      row: i + 1,
      date,
      company: String(row[5] || '').trim() || '（会社名なし）',
      body: String(row[4] || '').trim(),
      status: String(row[12] || '').trim(),
      source: 'orgiast',
    });
  }
  return rows;
}

/** テスト／検証用の問い合わせ行（催促対象外） */
export function isTestInquiry(row = []) {
  const hay = [row[1], row[4], row[5]].map(v => String(v || '')).join('\n');
  return /テスト|test\b|動作確認/i.test(hay);
}

/**
 * 対応漏れ候補: 完了以外・受付 minAge〜maxAge・除外/テスト以外・未通知。
 * maxAgeMs 未指定時は上限なし（後方互換）。催促経路では unansweredMaxAgeDays を渡す。
 */
export function unansweredRows(values, {
  now = Date.now(),
  notified = {},
  minAgeMs = 24 * 3600 * 1000,
  maxAgeMs,
} = {}) {
  const headers = values[0] || [];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (excludedInquiry(row, headers)) continue;
    if (isTestInquiry(row)) continue;
    const status = String(row[12] || '').trim();
    if (/^完了(?:$|[（(\s])/.test(status)) continue;
    const date = dateISO(row[0]);
    if (!date) continue;
    const age = now - Date.parse(date);
    if (!Number.isFinite(age) || age <= minAgeMs) continue;
    if (Number.isFinite(maxAgeMs) && age > maxAgeMs) continue;
    const key = String(i + 1);
    if (notified[key]) continue;
    out.push({
      key,
      row: i + 1,
      date,
      company: String(row[5] || '').trim() || '（会社名なし）',
      body: String(row[4] || '').trim(),
      status: status || '（未記入）',
    });
  }
  return out;
}

export function gmailQueryForSite(site, week) {
  // Gmail date-only queries use Pacific time; epoch seconds preserve JST boundaries.
  const after = `after:${Math.floor(Date.parse(`${week.startDate}T00:00:00+09:00`) / 1000) - 1}`;
  const before = `before:${Math.floor(Date.parse(`${addDays(week.endDate, 1)}T00:00:00+09:00`) / 1000)}`;
  if (site.gmailQuery) return `(${site.gmailQuery}) ${after} ${before}`;
  const hints = (site.gmailQueryHints || [site.domain, site.name]).filter(Boolean);
  const or = hints.map(h => `"${String(h).replace(/"/g, '')}"`).join(' OR ');
  return `{${or}} ${after} ${before}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function gmailToInquiry(message, siteId) {
  const date = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : dateISO(message.date);
  const subject = String(message.subject || '').trim();
  const raw = String(message.body || message.snippet || '').trim();
  const contentMatch = raw.match(/お問い合わせ内容[:：]\s*([\s\S]+)/);
  const body = (contentMatch ? contentMatch[1] : raw).replace(/\s+/g, ' ').trim().slice(0, 800);
  return {
    key: `gmail:${message.id || subject}:${date}`,
    date,
    company: guessCompany(subject, raw) || '（会社名なし）',
    body: body || subject,
    source: siteId,
    subject,
  };
}

export function guessCompany(subject, snippet) {
  const text = `${subject}\n${snippet}`;
  const labeled = text.match(/(?:会社名|御社名|貴社名|Company)[:：\s]*([^\n\r|]{2,40})/i);
  if (labeled) return labeled[1].trim();
  // 「伊勢湾陸運株式会社」を「株式会社マリン…」と誤読しないよう、接尾辞型を先に取る
  const corp = text.match(/([A-Za-z0-9０-９ァ-ヶー一-龥]{2,30})株式会社/);
  if (corp) return `${corp[1]}株式会社`;
  // ひらがなは「の」「と申します」等の助詞なので会社名から除外
  const intro = text.match(/(?:^|[\s　\n「『（(：:])株式会社[\s　]*([A-Za-z0-9０-９ァ-ヶー一-龥]{1,40})/);
  if (intro) return `株式会社${intro[1]}`;
  return '';
}

export async function defaultAskLlm(prompt, { providers = ['deepseek', 'groq', 'mistral'] } = {}) {
  const tool = path.join(__dirname, 'llm-ask.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-weekly-'));
  const promptFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  const fail = [];
  try {
    for (const provider of providers) {
      try {
        const { stdout } = await execFileAsync(process.execPath, [
          tool, '--provider', provider, '--prefer-provider', '--no-fallback',
          '--category', 'summarize', '--max', '80', '--prompt-file', promptFile,
        ], { timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true, env: process.env });
        const out = String(stdout || '').trim();
        if (out && out !== '(出力なし)') return out.replace(/\s+/g, ' ').slice(0, 40);
      } catch (e) {
        fail.push(`${provider}:${e.message}`);
      }
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function fallbackSummary(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '（内容なし）';
}

export async function summarizeInquiries(inquiries, { askLlm = defaultAskLlm, skipLlm = false } = {}) {
  const out = [];
  for (const item of inquiries) {
    let summary = null;
    if (!skipLlm) {
      const prompt = `次の問い合わせを日本語で30字以内に要約せよ。会社名や固有名詞は残す。要約本文のみ出力。\n会社: ${item.company}\n内容: ${item.body}`;
      try { summary = await askLlm(prompt); } catch { summary = null; }
    }
    out.push({ ...item, summary: summary ? [...String(summary).replace(/\s+/g, ' ').trim()].slice(0, 30).join('') : fallbackSummary(item.body) });
  }
  return out;
}

export function formatDateMd(iso) {
  if (!iso) return '日付不明';
  const p = jstParts(new Date(iso));
  return `${p.month}/${p.day}`;
}

export function formatWeeklyMessage({ week, sites, inquiriesBySite }) {
  const lines = [`【自動】今週のサイト状況（${week.label}）`, '', '■ アクセス（セッション）'];
  for (const s of sites) {
    if (s.status === 'ok') {
      lines.push(`${s.name}: ${s.sessions}（${formatPct(s.pct)}）`);
    } else {
      lines.push(`${s.name}: 未接続（${s.reason || '取得不可'}）`);
    }
  }
  lines.push('', '■ 問い合わせ');
  for (const s of sites) {
    const list = inquiriesBySite[s.id] || [];
    if (s.inquiryStatus !== 'ok') {
      lines.push(`【${s.name}】未接続（${s.inquiryReason || '取得不可'}）`);
      continue;
    }
    const note = s.inquiryStatus === 'ok' ? '' : ` ※${s.inquiryReason || '未接続'}`;
    lines.push(`【${s.name}】${list.length}件${note}`);
    if (!list.length) {
      lines.push('・なし');
      continue;
    }
    for (const item of list) {
      lines.push(`・${item.summary}　${item.company}　${formatDateMd(item.date)}`);
    }
  }
  return lines.join('\n');
}

export function formatUnansweredMessage(rows, now = new Date(), { maxAgeDays } = {}) {
  const p = jstParts(now);
  const ageNote = Number.isFinite(maxAgeDays) && maxAgeDays > 0
    ? `受付から24時間超〜${maxAgeDays}日以内`
    : '受付から24時間超';
  const lines = [
    `【自動】対応漏れ検知（${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}）`,
    `${ageNote}・対応状況が「完了」でない問い合わせです（新着即時通知とは別経路。営業除外・テスト行は対象外）。`,
    '',
  ];
  for (const r of rows) {
    const summary = fallbackSummary(r.body);
    lines.push(`・行${r.row}　${summary}　${r.company}　${formatDateMd(r.date)}　状態:${r.status}`);
  }
  return lines.join('\n');
}

/** Discord 2000字制限で分割（見出しを先頭に残す） */
export function splitDiscordMessages(text, limit = 2000) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function postChannelMessages(contents, {
  channelId, token, fetchImpl = globalThis.fetch, dryRun = false,
} = {}) {
  if (dryRun) return contents.map((content, i) => ({ dryRun: true, index: i, content, id: null }));
  if (!token) throw new Error('Discord Bot トークンがありません');
  const posted = [];
  for (const content of contents) {
    const res = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'orgiast-site-weekly-report',
      },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Discord POST HTTP ${res.status}: ${String(json.message || '').slice(0, 200)}`);
    posted.push({ id: json.id, content, channelId });
  }
  return posted;
}

export async function readBackMessage(messageId, { channelId, token, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'orgiast-site-weekly-report' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord GET HTTP ${res.status}`);
  return json;
}

async function resolveGa4Token(deps) {
  if (deps.ga4Token) return deps.ga4Token;
  const { key } = deps.key ? { key: deps.key } : loadSaKey();
  const subject = process.env.GOOGLE_IMPERSONATE || 'kim@orgiast.jp';
  return getToken({ key, subject, scope: GA4_SCOPE, signal: deps.signal });
}

export async function collectSiteMetrics(config, week, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sitesOut = [];
  let properties = deps.properties || null;
  let token = null;
  try {
    token = await resolveGa4Token(deps);
  } catch (e) {
    for (const site of config.sites) {
      sitesOut.push({
        ...site,
        status: site.propertyId ? 'error' : 'unconnected',
        reason: e.message,
        sessions: null,
        prevSessions: null,
        pct: null,
      });
    }
    return { sites: sitesOut, properties: [], tokenError: e.message };
  }
  let discoveryError;
  if (!properties) {
    try { properties = await listGa4Properties({ token, fetchImpl, signal: deps.signal }); }
    catch (e) { properties = []; discoveryError = e.message; }
  }

  for (const site of config.sites) {
    const matched = matchProperty(properties, site);
    if (!matched) {
      sitesOut.push({
        ...site,
        status: 'unconnected',
        reason: discoveryError || `GA4プロパティ未検出（domain=${site.domain}）`,
        sessions: null,
        prevSessions: null,
        pct: null,
      });
      continue;
    }
    try {
      const [sessions, prevSessions] = await Promise.all([
        fetchGa4Sessions(matched.propertyId, week.startDate, week.endDate, { token, fetchImpl, signal: deps.signal }),
        fetchGa4Sessions(matched.propertyId, week.prevStartDate, week.prevEndDate, { token, fetchImpl, signal: deps.signal }),
      ]);
      sitesOut.push({
        ...site,
        propertyId: matched.propertyId,
        displayName: matched.displayName,
        status: 'ok',
        sessions,
        prevSessions,
        pct: pctChange(sessions, prevSessions),
      });
    } catch (e) {
      sitesOut.push({
        ...site,
        propertyId: matched.propertyId,
        status: 'unconnected',
        reason: e.message,
        sessions: null,
        prevSessions: null,
        pct: null,
      });
    }
  }
  return { sites: sitesOut, properties };
}

export async function collectInquiries(config, week, deps = {}) {
  const bySite = {};
  const siteMeta = {};
  for (const site of config.sites) {
    bySite[site.id] = [];
    siteMeta[site.id] = { inquiryStatus: 'ok', inquiryReason: '' };
    try {
      if (site.inquirySource === 'sheet') {
        const values = deps.sheetValues
          || await (deps.readSheetImpl || readSheet)(INQUIRY_SHEET, INQUIRY_TAB, { signal: deps.signal });
        bySite[site.id] = sheetInquiries(values, week);
      } else if (site.inquirySource === 'gmail') {
        const search = deps.searchGmailImpl || searchGmail;
        const messages = [];
        let pageToken;
        do {
        const result = await search({
          user: config.gmailUser || 'seisaku-team@orgiast.jp',
          query: gmailQueryForSite(site, week),
          max: 100,
          pageToken,
          withBody: true,
          bodyLimit: 2000,
          signal: deps.signal,
          ...(deps.gmailAuth || {}),
        });
        messages.push(...(result.messages || []));
        pageToken = result.nextPageToken;
        } while (pageToken);
        if (site.inquiryVerified === false) {
          siteMeta[site.id] = { inquiryStatus: 'unconnected', inquiryReason: site.inquiryNote || 'フォーム通知経路未確認' };
        }
        bySite[site.id] = [...new Map(messages.map(m => [m.id, m])).values()]
          .map(m => gmailToInquiry(m, site.id))
          .filter(i => i.date && inWeek(i.date, week));
      }
    } catch (e) {
      siteMeta[site.id] = { inquiryStatus: 'unconnected', inquiryReason: e.message };
      bySite[site.id] = [];
    }
  }
  return { bySite, siteMeta };
}

export async function runWeekly(args = {}, deps = {}) {
  const home = deps.home || process.env.ORGIAST_HOME || os.homedir();
  const config = deps.config || loadConfig(args.config || DEFAULT_CONFIG);
  const week = deps.week || weekRange(deps.now || new Date());
  const dryRun = Boolean(args.flags?.has?.('dry-run') ?? args.dryRun);

  if (args.flags?.has?.('discover') || args.discover) {
    const token = await resolveGa4Token(deps);
    const properties = await listGa4Properties({ token, fetchImpl: deps.fetchImpl, signal: deps.signal });
    for (const site of config.sites) {
      const matched = matchProperty(properties, site);
      if (matched) site.propertyId = matched.propertyId;
    }
    if (!deps.skipConfigWrite) saveConfig(config, args.config || DEFAULT_CONFIG);
    return { mode: 'discover', properties, config };
  }

  const metrics = await collectSiteMetrics(config, week, deps);
  // 発見した propertyId を config に固定（未設定だったものだけ）
  if (!deps.skipConfigWrite) {
    let changed = false;
    for (const s of metrics.sites) {
      const cfg = config.sites.find(c => c.id === s.id);
      if (cfg && s.propertyId && cfg.propertyId !== s.propertyId) {
        cfg.propertyId = s.propertyId;
        changed = true;
      }
    }
    if (changed) saveConfig(config, args.config || DEFAULT_CONFIG);
  }

  const inquiries = await collectInquiries(config, week, deps);
  for (const s of metrics.sites) {
    const meta = inquiries.siteMeta[s.id] || {};
    s.inquiryStatus = meta.inquiryStatus;
    s.inquiryReason = meta.inquiryReason;
  }

  const flat = Object.values(inquiries.bySite).flat();
  const fp = fingerprint(flat.map(i => ({ k: i.key, b: i.body, c: i.company })));
  const g = (deps.gateImpl || gate)(CHANGE_GATE_WEEKLY, { fingerprint: fp, items: flat });
  let llmInvoked = false;
  let summarizedBySite = {};
  if (!g.changed) {
    summarizedBySite = Object.fromEntries(
      Object.entries(inquiries.bySite).map(([id, list]) => [id, list.map(i => ({ ...i, summary: fallbackSummary(i.body) }))]),
    );
    (deps.recordRunImpl || recordRun)(CHANGE_GATE_WEEKLY, { changed: false, llmInvoked: false, items: flat.length, note: g.reason });
  } else {
    llmInvoked = flat.length > 0;
    for (const [id, list] of Object.entries(inquiries.bySite)) {
      summarizedBySite[id] = await summarizeInquiries(list, {
        askLlm: deps.askLlm || defaultAskLlm,
        skipLlm: !llmInvoked,
      });
    }
    (deps.recordRunImpl || recordRun)(CHANGE_GATE_WEEKLY, { changed: true, llmInvoked, items: flat.length });
  }

  const text = formatWeeklyMessage({ week, sites: metrics.sites, inquiriesBySite: summarizedBySite });
  const chunks = splitDiscordMessages(text);
  const channelId = config.channelId;
  const token = deps.token !== undefined ? deps.token : resolveDiscordBotToken(home);
  const posted = await postChannelMessages(chunks, {
    channelId, token, fetchImpl: deps.fetchImpl, dryRun,
  });
  if (!dryRun && g.changed) (deps.commitImpl || commit)(CHANGE_GATE_WEEKLY, { fingerprint: fp });

  let readBack = null;
  if (!dryRun && posted[0]?.id && deps.readBack !== false) {
    try {
      readBack = await readBackMessage(posted[0].id, { channelId, token, fetchImpl: deps.fetchImpl });
    } catch (e) {
      readBack = { error: e.message };
    }
  }

  return {
    mode: 'weekly',
    week,
    sites: metrics.sites,
    inquiriesBySite: summarizedBySite,
    text,
    chunks,
    posted,
    readBack,
    changeGate: g,
    llmInvoked,
    dryRun,
  };
}

export async function runUnanswered(args = {}, deps = {}) {
  const home = deps.home || process.env.ORGIAST_HOME || os.homedir();
  const config = deps.config || loadConfig(args.config || DEFAULT_CONFIG);
  const dryRun = Boolean(args.flags?.has?.('dry-run') ?? args.dryRun);
  const now = deps.now || new Date();
  const state = deps.state || loadState(home);
  const today = new Date((now.getTime?.() ?? now) + 9 * 3600000).toISOString().slice(0, 10);
  const lastDay = state.lastUnansweredAt ? new Date(Date.parse(state.lastUnansweredAt) + 9 * 3600000).toISOString().slice(0, 10) : null;
  if (lastDay === today) return { mode: 'unanswered', rows: [], text: '', posted: [], skipped: 'already-today', dryRun };
  const values = deps.sheetValues
    || await (deps.readSheetImpl || readSheet)(INQUIRY_SHEET, INQUIRY_TAB, { signal: deps.signal });
  const maxAgeDays = Number(config.unansweredMaxAgeDays ?? 14);
  const maxAgeMs = Number.isFinite(maxAgeDays) && maxAgeDays > 0
    ? maxAgeDays * 24 * 3600 * 1000
    : undefined;
  const rows = unansweredRows(values, {
    now: now.getTime?.() ?? now,
    notified: state.notifiedUnanswered || {},
    maxAgeMs,
  });
  const fp = fingerprint(rows.map(r => r.key));
  const g = (deps.gateImpl || gate)(CHANGE_GATE_UNANSWERED, { fingerprint: fp, items: rows });
  (deps.recordRunImpl || recordRun)(CHANGE_GATE_UNANSWERED, {
    changed: g.changed, llmInvoked: false, items: rows.length, note: g.reason,
  });

  if (!rows.length) {
    return { mode: 'unanswered', rows: [], text: '', posted: [], skipped: 'none', changeGate: g, dryRun };
  }
  if (!g.changed && !deps.force) {
    return { mode: 'unanswered', rows, text: '', posted: [], skipped: 'no-change', changeGate: g, dryRun };
  }

  const text = formatUnansweredMessage(rows, now instanceof Date ? now : new Date(now), { maxAgeDays });
  const chunks = splitDiscordMessages(text);
  const token = deps.token !== undefined ? deps.token : resolveDiscordBotToken(home);
  const posted = await postChannelMessages(chunks, {
    channelId: config.channelId, token, fetchImpl: deps.fetchImpl, dryRun,
  });

  if (!dryRun) {
    const notified = { ...(state.notifiedUnanswered || {}) };
    for (const r of rows) notified[r.key] = new Date().toISOString();
    // Keep notified row IDs even after completion: never remind the same row again.
    const next = { ...state, notifiedUnanswered: notified, lastUnansweredAt: new Date(now).toISOString() };
    if (!deps.skipStateWrite) saveState(next, home);
    (deps.commitImpl || commit)(CHANGE_GATE_UNANSWERED, { fingerprint: fp });
  }

  return { mode: 'unanswered', rows, text, chunks, posted, changeGate: g, dryRun };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.flags.has('help')) {
    console.log(`使い方:
  node tools/site-weekly-report.mjs [--dry-run] [--json] [--discover] [--config PATH]
  node tools/site-weekly-report.mjs --check-unanswered [--dry-run]`);
    return 0;
  }
  const result = args.flags.has('check-unanswered')
    ? await runUnanswered(args, deps)
    : await runWeekly(args, deps);

  if (args.flags.has('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.mode === 'discover') {
    console.log(JSON.stringify({ properties: result.properties, sites: result.config.sites }, null, 2));
  } else {
    if (result.text) console.log(result.text);
    else if (result.skipped) console.log(`[site-weekly-report] unanswered skipped: ${result.skipped}`);
    if (result.posted?.length && !result.dryRun) {
      console.error(`[posted] ${result.posted.map(p => p.id).filter(Boolean).join(', ')}`);
    }
  }
  return 0;
}

if (isEntry(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(e => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
