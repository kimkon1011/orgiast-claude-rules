#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';
import { extractBody } from './gmail-search.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'kim@orgiast.jp';
const AUTH = 'https://www.googleapis.com/auth/';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const enc = encodeURIComponent;
const quote = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function jstDate(time = Date.now()) { return new Date(time + 9 * 3600000).toISOString().slice(0, 10); }
export function dayBounds(date) {
  const start = Date.parse(`${date}T00:00:00+09:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) || jstDate(start) !== date) throw new Error('invalid --date');
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(start + 86400000).toISOString() };
}
export function excludeCalendar(c, config, state = {}) {
  return c.deleted || c.id === state.calendarId || c.summary === config.prepCalendarName ||
    /祝日|holidays?|案件専用Meet|My proposed times/i.test(c.summary || '') ||
    /#holiday@/.test(c.id || '') || config.excludedCalendarPrefixes.some(p => c.id.startsWith(p));
}
export function isMeeting(e, date) {
  if (!e.start?.dateTime || !e.end?.dateTime || e.status === 'cancelled') return false;
  const b = dayBounds(date), t = Date.parse(e.start.dateTime);
  if (t < Date.parse(b.timeMin) || t >= Date.parse(b.timeMax)) return false;
  if (e.attendees?.some(a => (a.self || a.email?.toLowerCase() === USER) && a.responseStatus === 'declined')) return false;
  if (['outOfOffice', 'focusTime', 'workingLocation', 'birthday'].includes(e.eventType)) return false;
  return !/(?:移動|休暇|有休|有給|作業ブロック|作業時間|集中時間|休憩|昼食|通院|私用|\bfocus\b|\btravel\b|\bvacation\b|\blunch\b|\bwork block\b)/i.test(e.summary || '');
}
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const domains = value => [...String(value || '').toLowerCase().matchAll(/[\w.+-]+@([\w.-]+)/g)].map(m => m[1]);
const genericDomains = new Set(['orgiast.jp', 'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'ymail.com', 'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.jp', 'live.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'msn.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);
const caseIds = c => [c.id, ...(c.aliasIds || [])].filter(Boolean);
function mentionsId(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}
export function meetUrls(e) {
  return [...new Set([...`${e.description || ''} ${e.location || ''} ${e.hangoutLink || ''} ${(e.conferenceData?.entryPoints || []).map(p => p.uri).join(' ')}`
    .matchAll(/https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z-])/gi)].map(m => m[1].toLowerCase()))];
}
export function privateTitle(e) { return !e.summary?.trim() || /名称非公開|非公開の予定|private event|busy/i.test(e.summary); }
export function matchCase(event, cases, meetEvents = []) {
  const raw = `${event.summary || ''}\n${event.description || ''}\n${event.location || ''}`;
  const text = normalize(raw), urls = new Set(meetUrls(event));
  const linked = new Set();
  for (const source of meetEvents) {
    if (!meetUrls(source).some(url => urls.has(url))) continue;
    const m = matchCase(source, cases);
    if (m.case) linked.add(m.case);
  }
  const emailDomains = new Set((event.attendees || []).flatMap(a => domains(a.email)).filter(d => !genericDomains.has(d)));
  const scored = cases.map(c => {
    let score = 0, reason = '';
    if (c.eventId && [event.id, event.iCalUID, event.recurringEventId].includes(c.eventId)) { score = 100; reason = '打合せイベントID'; }
    else if (linked.has(c)) { score = 95; reason = '案件専用Meet URL'; }
    else if (caseIds(c).some(id => mentionsId(raw, id))) { score = 90; reason = '案件ID'; }
    else if (normalize(c.name).length >= 3 && text.includes(normalize(c.name))) { score = 70; reason = '案件名'; }
    else if (normalize(c.client).length >= 3 && text.includes(normalize(c.client))) { score = 40; reason = 'クライアント名'; }
    if (domains(c.email).some(d => emailDomains.has(d))) { score += 20; reason += `${reason ? '+' : ''}顧客メールドメイン`; }
    return { case: c, score, reason };
  }).filter(x => x.score).sort((a, b) => b.score - a.score);
  if (!scored.length) return { case: null, reason: '案件未特定' };
  if (scored[1]?.score === scored[0].score) return { case: null, reason: '複数候補・要確認' };
  return scored[0];
}
export function resolvePC(remoteName, pcMap, beacons = []) {
  const entry = Object.entries(pcMap).find(([label, c]) => !label.startsWith('_') &&
    [label, c.remoteName, c.hostname, ...(c.aliases || [])].includes(remoteName));
  if (entry) return { label: entry[0], ...entry[1], remoteName };
  const b = beacons.find(b => [b.label, b.hostname, b.remoteName].includes(remoteName));
  return b ? { ...b, remoteName } : null;
}
export function routeCase(event, c, config, pcMap, beacons = []) {
  const booth = !!c && [event.organizer, ...(event.attendees || [])].some(a => a?.email?.toLowerCase() === config.teamEmail);
  const rule = booth ? config.booth : config.other;
  let pc = resolvePC(rule.remoteName, pcMap, beacons), note = '';
  if (!pc && rule.fallback) { pc = resolvePC(rule.fallback, pcMap, beacons); note = '014未解決のため008で代行'; }
  return { booth, pc, note, requested: rule.remoteName };
}
export function chooseTransport(evidence = {}, now = Date.now()) {
  const details = { source: evidence.source || '受信側実測情報なし', observedAt: evidence.observedAt || null };
  if (!Number.isFinite(Date.parse(evidence.observedAt)) || Date.parse(evidence.observedAt) > now || !Array.isArray(evidence.accept)) return { ...details, optIn: '不明', method: null, reason: '受信側opt-in未確認' };
  if (!evidence.accept.some(k => ['claude-resume', 'prompt'].includes(k))) return { ...details, optIn: '未承諾', method: null, reason: '受信側にprompt/claude-resumeの承諾なし' };
  if (evidence.accept.includes('claude-resume') && evidence.hub === 'kim-PC' && evidence.cwd && evidence.mailAvailable === true) return { ...details, optIn: 'opt-in 済み', method: 'fleet-mail', reason: 'claude-resume承諾・FLEET_HUB=kim-PC・cwd確認済み', cwd: evidence.cwd };
  if (evidence.accept.includes('prompt') && evidence.directiveAvailable === true) return { ...details, optIn: 'opt-in 済み', method: 'fleet-directive', reason: 'prompt承諾・fleet-agent確認済み（mailのclaude受付未確認）', cwd: evidence.cwd };
  return { ...details, optIn: 'opt-in 済み', method: null, reason: '承諾あり・実行可能な受付経路が未確認' };
}
export function eventKey(e) { return `meeting:${hash(`${e.iCalUID || `${e.calendarId}/${e.id}`}|${e.originalStartTime?.dateTime || e.start.dateTime}`).slice(0, 40)}`; }
export function isActiveCase(c) { return !!c.phase?.trim() && !/完了|失注|中止|キャンセル|アプローチリスト/.test(c.phase); }
export function planJobs({ events, cases, updates = {}, hub = {}, meetEvents = [], skipped = [], date, reviewDay = date, state = {}, config, pcMap, beacons = [] }) {
  const jobs = [], seen = new Set(), meetingCases = new Set();
  for (const e of events) {
    if (!isMeeting(e, date)) continue;
    const key = eventKey(e), match = matchCase(e, cases, meetEvents);
    if (seen.has(key)) continue;
    seen.add(key);
    if (privateTitle(e) || !match.case || match.case.ambiguousId) {
      skipped.push({ title: e.summary || '名称非公開', kind: 'meeting', case: null, pc: null, send: false, reason: privateTitle(e) ? '名称非公開' : match.case?.ambiguousId ? '案件ID重複・要確認' : match.reason });
      continue;
    }
    meetingCases.add(match.case.id);
    if (state.sent?.[`${date}:${key}`]) continue;
    jobs.push({ key, date, kind: 'meeting', event: e, case: match.case, match: match.reason, route: routeCase(e, match.case, config, pcMap, beacons) });
  }
  const batches = Object.values(state.batches || {});
  const used = new Set(batches.flatMap(b => b.jobs.filter(j => j.kind === 'review' && (j.reviewDay || j.date) === reviewDay).map(j => j.key))).size;
  const reviews = [];
  for (const c of cases) {
    const update = updates[c.id];
    if (c.ambiguousId || !isActiveCase(c) || meetingCases.has(c.id) || !update?.modifiedTime) continue;
    if (Date.parse(update.modifiedTime) <= Date.parse(state.reviewed?.[c.id] || '1970-01-01')) continue;
    const key = `review:${c.id}:${hash(update.modifiedTime).slice(0, 16)}`;
    if (state.sent?.[`${date}:${key}`]) continue;
    if (batches.some(b => b.jobs.some(j => j.kind === 'review' && j.case.id === c.id) && b.status !== 'complete')) continue;
    reviews.push({ key, date, reviewDay, kind: 'review', case: c, hub: hub[c.id], update, match: '進行中・Gmailスレッド更新あり', route: routeCase({}, c, config, pcMap, beacons) });
  }
  reviews.sort((a, b) => Date.parse(b.update.modifiedTime) - Date.parse(a.update.modifiedTime) || a.case.id.localeCompare(b.case.id));
  const remaining = Math.max(0, 10 - used);
  for (const j of reviews.slice(remaining)) skipped.push({ title: j.case.name, kind: 'review', case: j.case.id, pc: null, send: false, reason: '日次レビュー上限10案件・次回へ繰越' });
  jobs.push(...reviews.slice(0, remaining));
  return jobs;
}

export function createGoogle({ dryRun = false, user = USER, token = getDriveToken, fetchImpl = fetch } = {}) {
  const tokens = new Map();
  async function request(scope, url, method = 'GET', body, headers = {}) {
    if (dryRun && method !== 'GET') throw new Error(`dry-run write blocked: ${method}`);
    if (!tokens.has(scope)) tokens.set(scope, await token({ scope: AUTH + scope, impersonate: user, signal: AbortSignal.timeout(30000) }));
    const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${tokens.get(scope)}`, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw Object.assign(new Error(`${scope}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`), { status: res.status });
    return res.status === 204 ? {} : res.json();
  }
  async function pages(scope, url, field = 'items') {
    const out = []; let next;
    do { const u = new URL(url); if (next) u.searchParams.set('pageToken', next);
      const page = await request(scope, u.href); out.push(...(page[field] || [])); next = page.nextPageToken;
    } while (next);
    return out;
  }
  return { request, pages };
}
// Reuse the existing DWD grants. Read-only behavior is enforced by request(),
// rather than assuming the narrower drive.readonly grant has also been approved.
const driveScope = () => 'drive';
async function files(g, q, dry = true) {
  return g.pages(driveScope(dry), `${DRIVE}/files?${new URLSearchParams({ q: `trashed=false and (${q})`, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents,appProperties)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`, 'files');
}
function one(rows, name) { if (rows.length > 1) throw new Error(`同名が複数: ${name}`); return rows[0]; }
export function parseCases(values = []) {
  const headerIndex = values.findIndex(row => row.some(v => ['案件id', 'コード'].includes(normalize(v))) && row.some(v => normalize(v) === '案件名'));
  if (headerIndex < 0) throw new Error('案件一覧のヘッダー不一致（案件ID/ｺｰﾄﾞ・案件名が必要）');
  const headers = values[headerIndex].map(normalize);
  const value = (row, ...names) => {
    for (const name of names) for (let i = 0; i < headers.length; i++) {
      if (headers[i] === normalize(name) && row[i] && !String(row[i]).startsWith('#')) return String(row[i]).trim();
    }
    return '';
  };
  const rows = values.slice(headerIndex + 1).map(r => {
    const plan = value(r, '実施計画書ID', '実施計画URL');
    return { id: value(r, '案件ID', 'ｺｰﾄﾞ'), client: value(r, 'クライアント名', '顧客名'), name: value(r, '案件名'),
      phase: value(r, '現在フェーズ', '予算項目'), folderId: value(r, 'Drive フォルダID'),
      planId: plan.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] || (/^[\w-]+$/.test(plan) ? plan : ''),
      projectFolderId: value(r, 'プロジェクトフォルダID'), email: value(r, '顧客メール', 'Mail'), eventId: value(r, '打合せイベントID') };
  }).filter(c => c.id && c.name);
  return [...new Map(rows.map(c => [JSON.stringify(c), c])).values()];
}
export async function loadCases(g, config) {
  const read = async id => parseCases((await g.request('spreadsheets.readonly', `${SHEETS}/${id}/values/${enc("'案件一覧'!A:ZZ")}`)).values);
  const cases = await read(config.caseSheetId);
  if (config.caseDetailsSheetId && config.caseDetailsSheetId !== config.caseSheetId) {
    const details = await read(config.caseDetailsSheetId);
    for (const c of cases) {
      const linked = details.filter(d => c.planId && d.planId === c.planId);
      if (linked.length !== 1) continue;
      const d = linked[0];
      c.aliasIds = d.id === c.id ? [] : [d.id];
      for (const field of ['folderId', 'projectFolderId', 'email', 'eventId']) if (!c[field]) c[field] = d[field];
    }
  }
  // Reused codes must not route different projects to the same review/write key.
  const byId = new Map();
  for (const c of cases) { if (!byId.has(c.id)) byId.set(c.id, []); byId.get(c.id).push(c); }
  for (const group of byId.values()) if (group.length > 1) for (const c of group) c.ambiguousId = true;
  return cases;
}
export async function loadMeetEvents(g, config) {
  if (!config.meetCalendarId) return [];
  return g.pages('calendar.events', `${CAL}/calendars/${enc(config.meetCalendarId)}/events?maxResults=2500&showDeleted=false`);
}
export async function loadMailUpdates({ cases, state = {}, config, until = Date.now(), google }) {
  const since = Date.parse(state.lastReviewScan || state.lastDispatch || new Date(until - 86400000).toISOString());
  if (!Number.isFinite(since) || since > until) throw new Error('Gmail更新カーソル不正');
  const active = cases.filter(c => isActiveCase(c) && !c.ambiguousId);
  const updates = { ...state.reviewUpdates };
  const g = google || createGoogle({ dryRun: true, user: config.teamEmail });
  const query = `after:${Math.floor(since / 1000) - 1} before:${Math.ceil(until / 1000) + 1} -in:drafts`;
  // Same DWD getDriveToken path as schedule-sync/gmail-search; list threads directly
  // to avoid a serial metadata request for every message before reading its thread.
  const threads = active.length ? await g.pages('gmail.readonly', `https://gmail.googleapis.com/gmail/v1/users/me/threads?${new URLSearchParams({ q: query, maxResults: '100' })}`, 'threads') : [];
  const entries = [...new Set(threads.map(t => t.id))];
  for (let offset = 0; offset < entries.length; offset += 5) {
    const results = await Promise.all(entries.slice(offset, offset + 5).map(async id => {
      const thread = await g.request('gmail.readonly', `https://gmail.googleapis.com/gmail/v1/users/me/threads/${enc(id)}?format=full`);
      const messages = (thread.messages || []).filter(m => !m.labelIds?.includes('DRAFT') && Number(m.internalDate) <= until);
      const t = Math.max(0, ...messages.map(m => Number(m.internalDate)));
      if (messages.some(m => !Number.isFinite(Number(m.internalDate)) || !m.internalDate)) throw new Error('Gmailスレッド更新日時未取得');
      const text = messages.map(m => `${m.payload?.headers?.find(h => h.name.toLowerCase() === 'subject')?.value || ''}\n${extractBody(m.payload, Number.MAX_SAFE_INTEGER)}`).join('\n');
      return { id, t, text };
    }));
    for (const { id, t, text } of results) for (const c of active) {
      if (t <= since || t > until) continue;
      if (!caseIds(c).some(cid => mentionsId(text, cid)) && !(normalize(c.name).length >= 3 && normalize(text).includes(normalize(c.name)))) continue;
      if (t > Date.parse(updates[c.id]?.modifiedTime || '1970-01-01')) updates[c.id] = { modifiedTime: new Date(t).toISOString(), threadId: id, source: 'seisaku-team Gmail' };
    }
  }
  return { updates, scannedAt: new Date(until).toISOString(), since: new Date(since).toISOString(), threads: entries.length };
}
export async function loadHub(g) {
  const root = one(await files(g, "name='案件情報ハブ' and mimeType='application/vnd.google-apps.folder'"), '案件情報ハブ');
  if (!root) return { cases: {}, warning: '案件情報ハブ未作成。打合せは情報源fallback、日次レビューはGmail更新で判定' };
  const folder = one(await files(g, `'${quote(root.id)}' in parents and name='cases' and mimeType='application/vnd.google-apps.folder'`), 'cases');
  if (!folder) return { cases: {}, warning: 'ハブcases未作成' };
  const rows = await files(g, `'${quote(folder.id)}' in parents and mimeType='application/vnd.google-apps.document'`);
  const cases = {};
  for (const row of rows) {
    const id = row.name.match(/^(\d{6}[A-Z]{2,6}|C\d{4,})_/i)?.[1];
    if (id) { if (cases[id]) throw new Error(`ハブ案件Doc重複: ${id}`); cases[id] = { docId: row.id, modifiedTime: row.modifiedTime }; }
  }
  return { folderId: root.id, cases };
}
export async function loadEvents(g, config, state, date, dateTo = date) {
  const calendars = await g.pages('calendar.readonly', `${CAL}/users/me/calendarList?maxResults=250&showHidden=true`);
  const events = [], errors = [];
  for (const c of calendars.filter(c => !excludeCalendar(c, config, state))) {
    try {
      const rows = await g.pages('calendar.events', `${CAL}/calendars/${enc(c.id)}/events?${new URLSearchParams({ timeMin: dayBounds(date).timeMin, timeMax: dayBounds(dateTo).timeMax, singleEvents: 'true', maxResults: '2500' })}`);
      events.push(...rows.map(e => ({ ...e, calendarId: c.id, calendarName: c.summary })));
    } catch (e) { errors.push({ calendar: c.summary, error: e.message }); }
  }
  return { calendars, events, errors };
}
export async function ensureCalendar(g, state, config, checkpoint) {
  const list = await g.pages('calendar.readonly', `${CAL}/users/me/calendarList?maxResults=250&showHidden=true`);
  const c = state.calendarId ? list.find(c => c.id === state.calendarId) : one(list.filter(c => c.summary === config.prepCalendarName), config.prepCalendarName);
  if (state.calendarId && !c) throw new Error('準備カレンダーIDがcalendarListに見つかりません');
  if (c && c.accessRole !== 'owner') throw new Error('準備カレンダーはkim所有である必要があります');
  if (!c) {
    const created = await g.request('calendar.calendars', `${CAL}/calendars`, 'POST', { summary: config.prepCalendarName, timeZone: 'Asia/Tokyo', description: '社内の打合せ準備（meeting-prep）' });
    state.calendarId = created.id; checkpoint();
  } else { state.calendarId = c.id; checkpoint(); }
  // A pre-existing calendar must not expose internal agendas to public/domain/other accounts.
  const acl = await g.pages('calendar.acls.readonly', `${CAL}/calendars/${enc(state.calendarId)}/acl`);
  if (acl.some(a => a.role !== 'none' && !(a.scope?.type === 'user' && a.scope.value?.toLowerCase() === USER))) throw new Error('準備カレンダーにkim以外の共有があります。社内資料を書き込まず停止');
  return state.calendarId;
}
export async function upsertPreparation(g, calendarId, job, result = {}, now = new Date().toISOString()) {
  if (job.kind !== 'meeting') return;
  if (calendarId === job.event.calendarId) throw new Error('元の予定への書込禁止');
  const id = `mp${hash(job.key).slice(0, 48)}`;
  const url = `${CAL}/calendars/${enc(calendarId)}/events/${id}`;
  const description = [result.summary || '準備依頼中', ...(result.links || []).map(x => `${x.label}: ${workspaceUrl(x.url)}`),
    job.case?.folderId ? `案件フォルダ: https://drive.google.com/drive/folders/${job.case.folderId}` : '',
    `担当PC: ${job.route.pc?.remoteName || job.route.requested} (${job.route.pc?.label || '未解決'})`, job.route.note, `最終更新: ${now}`].filter(Boolean).join('\n');
  const body = { summary: `📋 準備: ${job.event.summary || '(名称なし)'}`, description, start: job.event.start, end: job.event.end,
    visibility: 'private', transparency: 'transparent', extendedProperties: { private: { sourceEventId: job.event.id, sourceCalendarId: job.event.calendarId, meetingPrepKey: job.key } } };
  let existing;
  try { existing = await g.request('calendar.events', url); } catch (e) { if (e.status !== 404) throw e; }
  if (existing && existing.extendedProperties?.private?.meetingPrepKey !== job.key) throw new Error('準備予定IDの衝突');
  if (existing) await g.request('calendar.events', url, 'PATCH', body);
  else {
    try { await g.request('calendar.events', `${CAL}/calendars/${enc(calendarId)}/events`, 'POST', { id, ...body }); }
    catch (e) { if (e.status !== 409) throw e; return upsertPreparation(g, calendarId, job, result, now); }
  }
  const actual = await g.request('calendar.events', url);
  if (actual.description !== description || actual.summary !== body.summary || Date.parse(actual.start?.dateTime) !== Date.parse(body.start.dateTime) || Date.parse(actual.end?.dateTime) !== Date.parse(body.end.dateTime)) throw new Error('準備予定read-back不一致');
  return actual;
}
export function workspaceUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['docs.google.com', 'drive.google.com'].includes(u.hostname)) throw new Error('Google Workspace以外の成果物URL');
  if (u.hostname === 'docs.google.com') {
    u.pathname = u.pathname.replace(/^\/a\/[^/]+/, '');
    if (u.pathname.startsWith('/spreadsheets/')) {
      if (!/^#gid=\d+$/.test(u.hash)) throw new Error('シートURLにはgidが必要');
      u.pathname = '/a/orgiast.jp' + u.pathname;
    }
  }
  return u.href;
}

const TABS = { plan: ['Claude_次回MTGアジェンダ', 'Claude_実施計画更新', '制作物一覧', '制作物デザイン'], confirmation: ['確認事項'], submission: ['Claude_提出依頼'] };
const HEADERS = {
  'Claude_次回MTGアジェンダ': ['No', '議題', '目的', '背景', 'この場で決めること', '選択肢', '所要分'],
  'Claude_実施計画更新': ['項目', '確定内容', '根拠', '更新日時'],
  '制作物デザイン': ['制作物', 'デザイン案リンク', 'サイズ', '入稿期限', '状態', 'メモ'],
  '確認事項': ['確認ID', 'フェーズ', 'カテゴリ', '確認内容', '回答', 'ステータス', '起票日時'],
  'Claude_提出依頼': ['提出物', '目的', '期限', '状態', '備考']
};
function colNumber(col) { return [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }
export function validateWrite(w) {
  if (!TABS[w.target]?.includes(w.tab)) throw new Error('許可されていない書込先（アイテムリスト等）');
  const m = /^([A-Z]{1,2})([1-9]\d*):([A-Z]{1,2})([1-9]\d*)$/.exec(w.range || '');
  if (!m) throw new Error('明示的な矩形A1範囲が必要');
  const x = colNumber(m[1]), y = +m[2], width = colNumber(m[3]) - x + 1, height = +m[4] - y + 1;
  if (w.create && y === 1) throw new Error('新規タブのヘッダーはapplierが設定。データは2行目以降');
  if (width < 1 || height < 1 || width > 100 || height > 1000 || y + height > 10001) throw new Error('範囲上限超過');
  for (const rows of [w.before, w.values]) {
    if (!Array.isArray(rows) || rows.length !== height || rows.some(r => !Array.isArray(r) || r.length !== width || r.some(v => !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 10000))) throw new Error('before/valuesの寸法・値が不正');
  }
  if (w.target === 'confirmation' && x <= 5 && x + width > 5 && w.before.some((r, i) => String(r[5 - x]) !== String(w.values[i][5 - x]))) throw new Error('確認事項の回答列は変更禁止');
  if (w.create && w.tab === '制作物一覧') throw new Error('制作物一覧は既存レイアウトを読む');
  return { x, y, width, height };
}
const matrix = (rows, h, w) => Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => String(rows?.[i]?.[j] ?? '')));
const same = (a, b, h, w) => JSON.stringify(matrix(a, h, w)) === JSON.stringify(matrix(b, h, w));
export async function applySheetWrite(g, spreadsheetId, w) {
  const { height, width } = validateWrite(w);
  const base = `${SHEETS}/${enc(spreadsheetId)}`;
  const meta = await g.request('spreadsheets', base + '?fields=sheets.properties');
  let sheet = meta.sheets?.find(s => s.properties.title === w.tab)?.properties;
  if (!sheet) {
    if (!w.create || !HEADERS[w.tab]) throw new Error(`タブ未作成: ${w.tab}`);
    // The headers are managed separately, so a failed create can be retried safely.
    await g.request('spreadsheets', base + ':batchUpdate', 'POST', { requests: [{ addSheet: { properties: { title: w.tab } } }] });
    const created = await g.request('spreadsheets', base + '?fields=sheets.properties');
    sheet = created.sheets?.find(s => s.properties.title === w.tab)?.properties;
    if (!sheet) throw new Error('タブ作成read-back不一致');
  }
  if (w.create && HEADERS[w.tab]) {
    const header = HEADERS[w.tab], range = enc(`'${w.tab}'!A1:${String.fromCharCode(64 + header.length)}1`);
    const current = await g.request('spreadsheets', `${base}/values/${range}`);
    if (!current.values?.flat().some(v => v !== '')) {
      await g.request('spreadsheets', `${base}/values/${range}?valueInputOption=RAW`, 'PUT', { values: [header] });
    } else if (!same(current.values, [header], 1, header.length)) throw new Error('新規タブのヘッダー衝突');
    const actual = await g.request('spreadsheets', `${base}/values/${range}`);
    if (!same(actual.values, [header], 1, header.length)) throw new Error('ヘッダーread-back不一致');
  }
  const url = `${base}/values/${enc(`'${w.tab}'!${w.range}`)}`;
  const current = await g.request('spreadsheets', url + '?valueRenderOption=FORMULA');
  if (!same(current.values, w.values, height, width)) {
    if (!same(current.values, w.before, height, width)) throw new Error(`競合: ${w.tab}!${w.range}（再読込が必要）`);
    await g.request('spreadsheets', url + '?valueInputOption=RAW', 'PUT', { values: w.values });
  }
  const actual = await g.request('spreadsheets', url + '?valueRenderOption=FORMULA');
  if (!same(actual.values, w.values, height, width)) throw new Error('シートread-back不一致');
  return { label: w.tab, url: `https://docs.google.com/a/orgiast.jp/spreadsheets/d/${spreadsheetId}/edit#gid=${sheet.sheetId}` };
}
function docText(doc) {
  const content = doc.body?.content || [];
  if (content.some(c => c.table || c.sectionBreak && c.startIndex > 0)) throw new Error('補足Docに非テキスト構造あり・自動置換禁止');
  return content.flatMap(c => (c.paragraph?.elements || []).map(e => e.textRun?.content || '')).join('').replace(/\n$/, '');
}
async function applyDocument(g, job, d) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(d.key) || typeof d.text !== 'string' || !d.text.trim() || d.text.length > 100000 || typeof d.beforeText !== 'string') throw new Error('補足Doc形式不正');
  const folder = job.case.projectFolderId || job.case.folderId;
  if (!folder) throw new Error('制作フォルダ未特定');
  const name = `${job.date}_打合せ補足資料`;
  let file = one(await files(g, `'${quote(folder)}' in parents and name='${quote(name)}'`, false), name);
  if (!file) {
    file = await g.request('drive', `${DRIVE}/files?supportsAllDrives=true&fields=id`, 'POST', { name, mimeType: 'application/vnd.google-apps.document', parents: [folder], appProperties: { meetingPrep: job.case.id } });
  }
  const doc = await g.request('documents', `${DOCS}/${file.id}`), current = docText(doc);
  if (current !== d.text) {
    if (current !== d.beforeText) throw new Error('補足Docが更新済み・競合');
    const requests = [];
    if (current.length) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: current.length + 1 } } });
    requests.push({ insertText: { location: { index: 1 }, text: d.text } });
    await g.request('documents', `${DOCS}/${file.id}:batchUpdate`, 'POST', { writeControl: { requiredRevisionId: doc.revisionId }, requests });
  }
  if (docText(await g.request('documents', `${DOCS}/${file.id}`)) !== d.text) throw new Error('補足Doc read-back不一致');
  return { label: name, url: `https://docs.google.com/a/orgiast.jp/document/d/${file.id}/edit` };
}
async function targetIds(g, c) {
  const rows = c.folderId ? await files(g, `'${quote(c.folderId)}' in parents`, false) : [];
  if (c.projectFolderId && c.projectFolderId !== c.folderId) rows.push(...await files(g, `'${quote(c.projectFolderId)}' in parents`, false));
  const unique = [...new Map(rows.map(f => [f.id, f])).values()].filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
  return { plan: c.planId, confirmation: one(unique.filter(f => f.name === '確認シート'), '確認シート')?.id,
    submission: one(unique.filter(f => f.name === `${c.id}_${c.name}_ご提出フォーマット`), 'ご提出フォーマット')?.id };
}
export async function applyResult(g, job, result) {
  if (!job.case) throw new Error('案件未特定のため代行書込不可');
  const writes = result.writes || [], documents = result.documents || [];
  if (!writes.length && !documents.length) throw new Error('applyに書込内容がありません');
  if (documents.length > 1 || writes.length > 100) throw new Error('書込上限超過');
  const rects = [];
  for (const w of writes) {
    const r = validateWrite(w);
    if (rects.some(v => v.target === w.target && v.tab === w.tab && r.x < v.x + v.width && v.x < r.x + r.width && r.y < v.y + v.height && v.y < r.y + r.height)) throw new Error('書込範囲重複');
    rects.push({ ...r, target: w.target, tab: w.tab });
  }
  const ids = await targetIds(g, job.case);
  for (const w of writes) if (!ids[w.target]) throw new Error(`案件の${w.target}が未作成・未特定`);
  const links = [], substitutions = {};
  for (const d of documents) { const link = await applyDocument(g, job, d); links.push(link); substitutions[d.key] = link.url; }
  for (const w of writes) {
    const values = w.values.map(row => row.map(v => typeof v === 'string' ? v.replace(/\{\{document:([\w-]+)\}\}/g, (_, key) => {
      if (!substitutions[key]) throw new Error('補足Doc参照未解決'); return substitutions[key];
    }) : v));
    links.push(await applySheetWrite(g, ids[w.target], { ...w, values }));
  }
  return { ...result, status: 'ready', verified: true, links: [...(result.links || []), ...links] };
}

export function parseAnswer(raw) {
  let text = String(raw || '').trim();
  // Fleet's execution envelope may wrap stdout. Do not evaluate arbitrary text.
  try { const x = JSON.parse(text); if (x.version === 1) return x; if (typeof x.result === 'string') text = x.result; } catch { /* inspect a fenced JSON block below */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  else { const start = text.indexOf('{'), end = text.lastIndexOf('}'); if (start >= 0) text = text.slice(start, end + 1); }
  const answer = JSON.parse(text);
  if (answer.version !== 1 || typeof answer.batchId !== 'string' || !Array.isArray(answer.results)) throw new Error('結果JSONのversion/batchId/results不正');
  return answer;
}
export async function collectAnswers({ state, answers, google, checkpoint, now = new Date().toISOString() }) {
  const errors = [];
  for (const envelope of answers) {
    try {
      const answer = parseAnswer(envelope.body), batch = state.batches?.[answer.batchId];
      if (!batch || envelope.from !== batch.pc || (batch.method === 'fleet-mail' && envelope.replyTo !== batch.mailId)) continue;
      const keys = new Set();
      for (const r of answer.results) {
        if (keys.has(r.key) || !batch.jobs.some(j => j.key === r.key)) throw new Error('結果の対象key重複または未知');
        keys.add(r.key);
        if (!['ready', 'apply', 'needsReview'].includes(r.status) || typeof r.summary !== 'string') throw new Error('結果status/summary不正');
        for (const link of r.links || []) workspaceUrl(link.url);
        if (r.status === 'ready' && (r.verified !== true || !r.links?.length)) throw new Error('readyには検証済み成果物URLが必要');
      }
      batch.completed ||= {};
      for (const raw of answer.results) {
        if (batch.completed[raw.key]) continue;
        const job = batch.jobs.find(j => j.key === raw.key);
        let result = raw;
        if (raw.status === 'apply') result = await applyResult(google, job, raw);
        if (job.kind === 'meeting') {
          if (!state.calendarId) throw new Error('準備カレンダー未作成');
          await upsertPreparation(google, state.calendarId, job, result, now);
        }
        if (result.status !== 'ready') { batch.needsReview ||= {}; batch.needsReview[job.key] = result; checkpoint(); continue; }
        batch.completed[job.key] = { at: now, result };
        if (job.kind === 'review') { state.reviewed ||= {}; state.reviewed[job.case.id] = (job.update || job.hub).modifiedTime; }
        checkpoint();
      }
      if (batch.jobs.every(j => batch.completed[j.key])) { batch.status = 'complete'; checkpoint(); }
    } catch (e) { errors.push({ from: envelope.from, replyTo: envelope.replyTo, error: e.message }); }
  }
  return errors;
}

export function renderPrompt(template, batch) {
  const payload = { batchId: batch.id, jobs: batch.jobs.map(j => ({ ...j, route: undefined, assignedPC: j.route.pc?.remoteName, routingNote: j.route.note })) };
  const body = template.replace('{{PAYLOAD}}', JSON.stringify(payload, null, 2));
  // fleet-mail truncates at 20,000 characters. Never silently lose jobs / reply instructions.
  if (body.length > 19000) throw new Error(`担当PC ${batch.pc}: 本文がfleet-mail上限を超えます (${body.length}文字)。未送信`);
  return body;
}
export async function dispatchJobs({ jobs, state, config, receivers, template, send, checkpoint, google, now = new Date().toISOString() }) {
  state.batches ||= {}; state.sent ||= {};
  const groups = new Map();
  for (const job of jobs) {
    if (!job.case || job.case.ambiguousId || (job.kind === 'meeting' && privateTitle(job.event))) throw new Error('案件未特定・案件ID重複・名称非公開は配送禁止');
    if (!job.route.pc) throw new Error(`担当PC未解決: ${job.route.requested}`);
    const pc = job.route.pc.label;
    if (!groups.has(pc)) groups.set(pc, []);
    groups.get(pc).push(job);
  }
  // Validate all destinations and body sizes before any external side effect.
  const batches = [...groups].map(([pc, items]) => {
    const transport = chooseTransport(receivers[pc]);
    if (!transport.method) throw new Error(`${pc}: ${transport.reason}`);
    const id = `prep-${hash(`${items[0].date}|${pc}|${items.map(j => j.key).sort().join('|')}`).slice(0, 32)}`;
    const batch = { id, pc, jobs: items, ...transport, status: 'pending', createdAt: now };
    return { batch, body: renderPrompt(template, batch) };
  });
  if (jobs.some(j => j.kind === 'meeting')) await ensureCalendar(google, state, config, checkpoint);
  for (const { batch, body } of batches) {
    if (state.batches[batch.id]) continue;
    state.batches[batch.id] = batch;
    // Claim before send. An uncertain timeout must never result in an automatic duplicate send.
    for (const j of batch.jobs) state.sent[`${j.date}:${j.key}`] = batch.id;
    batch.status = 'sending'; checkpoint();
    try {
      const receipt = await send(batch, body);
      if (!receipt.id) throw new Error('送信IDが返りませんでした');
      batch.mailId = receipt.id; batch.status = 'sent'; checkpoint();
      for (const j of batch.jobs) await upsertPreparation(google, state.calendarId, j, {}, now);
    } catch (e) { batch.error = e.message; checkpoint(); throw e; }
  }
}
function lines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function inspectFleet(home, config, { fetchBeacons } = {}) {
  fetchBeacons ||= (await import('./fleet-beacon.mjs')).fetchBeacons;
  const directory = await fetchBeacons({ home });
  // Raw read only: do not poll/ack unrelated mail or inspect per-message pending files.
  const inboxDir = path.join(home, '.claude/fleet-inbox');
  let names = [];
  try { names = (await fs.promises.readdir(inboxDir)).filter(n => /^mail-[\w-]+\.json$/.test(n)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const inbox = [];
  for (let offset = 0; offset < names.length; offset += 32) {
    const chunk = await Promise.all(names.slice(offset, offset + 32).map(async n => {
      try { return JSON.parse(await fs.promises.readFile(path.join(inboxDir, n), 'utf8')); } catch { return null; }
    }));
    inbox.push(...chunk.filter(Boolean));
  }
  const receivers = { ...config.receivers, ...readJson(path.join(home, '.claude/meeting-prep/receivers.json'), {}) };
  for (const [label, evidence] of Object.entries(receivers)) receivers[label] = { ...evidence, source: `受信側実測登録: ${label}` };
  // Only explicit machine-readable receiver reports count as opt-in evidence.
  // Sender-side opt-in and mere successful note delivery do not prove execution capability.
  for (const mail of inbox.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    try {
      const report = JSON.parse(mail.body);
      if (report.type !== 'meeting-prep-receiver' || report.label !== mail.from || !Array.isArray(report.accept)) continue;
      if (!receivers[mail.from] || Date.parse(receivers[mail.from].observedAt) < Date.parse(mail.createdAt)) receivers[mail.from] = { ...report, observedAt: mail.createdAt, source: `受信側fleet-mail報告: ${mail.from}` };
    } catch { /* non-receiver reply */ }
  }
  return { ...directory, inbox, receivers };
}
function execute(tool, args, home) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, ORGIAST_HOME: home }, cwd: ROOT });
}
function sender(home, dir) {
  return async (batch, body) => {
    const file = path.join(dir, `${batch.id}.md`); fs.writeFileSync(file, body, { mode: 0o600 });
    let output;
    if (batch.method === 'fleet-mail') {
      output = execute('fleet-mail.mjs', ['--send', '--to', batch.pc, '--kind', 'prompt', '--exec', 'claude', '--exec-cwd', batch.cwd,
        '--body-file', file, '--why', `打合せ準備 ${batch.id}`, '--expires-hours', '24'], home);
      const id = output.match(/送信済み:\s*(mail-[\w-]+)/)?.[1];
      if (!id) throw new Error('fleet-mailが送信成功IDを返していません');
      return { id };
    }
    const { main: sendDirective } = await import('./fleet-directive-send.mjs');
    const result = sendDirective(['--kind', 'prompt', '--targets', batch.pc, '--body-file', file, '--why', `打合せ準備 ${batch.id}`,
      '--expires-hours', '24', '--push', ...(batch.cwd ? ['--cwd', batch.cwd] : [])], { home, repo: ROOT });
    return { id: result.id || result.directive?.id };
  };
}
async function fetchAnswers(home, state, fleet, checkpoint) {
  const { createClient } = await import('./fleet-mail.mjs');
  const { parseEnvText } = await import('./env-kv.mjs');
  const env = parseEnvText(fs.readFileSync(path.join(home, '.claude/fleet-sheet.env'), 'utf8'));
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('fleet-sheet.env未設定');
  const request = createClient({ url: env.FLEET_SHEET_URL, token: env.FLEET_SHEET_TOKEN });
  const answers = fleet.inbox.filter(m => m.from && m.body).map(m => ({ from: m.from, replyTo: m.replyTo, body: m.body }));
  const log = lines(path.join(home, '.claude/fleet-mail-sent.jsonl'));
  for (const batch of Object.values(state.batches || {})) {
    if (batch.status === 'complete' || batch.method !== 'fleet-mail') continue;
    if (!batch.mailId) {
      const prior = log.filter(r => r.action === 'send-attempt' && r.to === batch.pc && r.why?.includes(batch.id));
      if (prior.length === 1) { batch.mailId = prior[0].id; checkpoint(); }
    }
    if (!batch.mailId) continue;
    const response = await request('mail-get', { id: batch.mailId });
    if (!response.ok) throw new Error(`結果回収失敗: ${response.error || 'mail-get'}`);
    const mail = response.mail;
    if (mail?.status === 'done' && mail.resultBody) answers.push({ from: mail.to, replyTo: mail.id, body: mail.resultBody });
    if (['failed', 'expired'].includes(mail?.status)) { batch.status = mail.status; batch.error = mail.failReason || mail.status; checkpoint(); }
  }
  return answers;
}
function lock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run.lock');
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid meeting-prep lock');
    try { process.kill(pid, 0); throw new Error('meeting-prep is running'); } catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(file); fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  }
  return () => fs.unlinkSync(file);
}
export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (['--date', '--date-to', '--home'].includes(argv[i])) { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('missing option value'); options[argv[i]] = argv[++i]; }
    else if (['--dry-run', '--live', '--collect', '--identify-014'].includes(argv[i])) options[argv[i]] = true;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (options['--live'] && options['--dry-run']) throw new Error('--live と --dry-run は併用不可');
  if (options['--collect'] && options['--identify-014']) throw new Error('実行モードは1つ');
  const dryRun = !options['--live'];
  const home = options['--home'] || process.env.ORGIAST_HOME || os.homedir();
  const config = readJson(path.join(ROOT, 'config/meeting-prep-routing.json'));
  const dir = path.join(home, '.claude/meeting-prep'), stateFile = path.join(dir, 'state.json');
  const release = dryRun ? () => {} : lock(dir);
  try {
    const state = readJson(stateFile, { version: 1, sent: {}, batches: {}, reviewed: {} });
    const checkpoint = () => { if (!dryRun) save(stateFile, state); };
    const date = options['--date'] || jstDate(Date.now() + 86400000); dayBounds(date);
    const dateTo = options['--date-to'] || date; dayBounds(dateTo);
    if (dateTo < date || Date.parse(dateTo) - Date.parse(date) > 31 * 86400000) throw new Error('日付範囲は開始日以降31日以内');
    if (!dryRun && dateTo !== date) throw new Error('--date-to はdry-run専用');
    const dates = [];
    for (let t = Date.parse(dayBounds(date).timeMin); t <= Date.parse(dayBounds(dateTo).timeMin); t += 86400000) dates.push(jstDate(t));
    const google = createGoogle({ dryRun });
    if (options['--identify-014']) {
      const body = '作業用014 の特定（読み取りのみ）。このPCの hostname、Chromeリモートデスクトップ名、ログインアカウント、fleet-agent-optin.json の accept/acceptedAt、FLEET_HUB（秘密値を除く）、nightly-repoの実在パスを自己申告してください。設定変更・インストール・業務データ書込はしない。014以外はその旨を報告。';
      if (dryRun) { console.log(JSON.stringify({ dryRun, kind: 'status', targets: 'all', body }, null, 2)); return 0; }
      const file = path.join(dir, 'identify-014.txt'); fs.writeFileSync(file, body);
      const { main: sendDirective } = await import('./fleet-directive-send.mjs');
      console.log(JSON.stringify(sendDirective(['--kind', 'status', '--targets', 'all', '--body-file', file, '--why', '作業用014 の特定（読取のみ）', '--expires-hours', '72', '--push'], { home, repo: ROOT }), null, 2)); return 0;
    }
    const fleet = await inspectFleet(home, config);
    if (options['--collect']) {
      if (dryRun) { console.log(JSON.stringify({ dryRun, pending: Object.values(state.batches || {}).filter(b => b.status !== 'complete').map(b => ({ id: b.id, pc: b.pc, status: b.status })) }, null, 2)); return 0; }
      const answers = await fetchAnswers(home, state, fleet, checkpoint);
      if (Object.values(state.batches || {}).some(b => b.jobs.some(j => j.kind === 'meeting'))) await ensureCalendar(google, state, config, checkpoint);
      const errors = await collectAnswers({ state, answers, google, checkpoint });
      state.lastCollect = { at: new Date().toISOString(), errors }; checkpoint(); console.log(JSON.stringify(state.lastCollect, null, 2)); return errors.length ? 1 : 0;
    }
    const scanUntil = Date.now();
    const settled = await Promise.allSettled([loadEvents(google, config, state, date, dateTo), loadCases(google, config), loadHub(google), loadMeetEvents(google, config)]);
    const errors = settled.flatMap((r, i) => r.status === 'rejected' && i !== 2 ? [{ source: ['calendar', 'cases', 'hub', 'meet'][i], error: r.reason.message }] : []);
    const calendar = settled[0].status === 'fulfilled' ? settled[0].value : { events: [], errors: [], calendars: [] };
    errors.push(...calendar.errors);
    const cases = settled[1].status === 'fulfilled' ? settled[1].value : [];
    const hub = settled[2].status === 'fulfilled' ? settled[2].value : { cases: {}, warning: `ハブ読取不可・Gmailで継続: ${settled[2].reason.message}` };
    const meetEvents = settled[3].status === 'fulfilled' ? settled[3].value : [];
    let mail = { updates: {}, threads: 0 };
    if (settled[1].status === 'fulfilled') {
      try { mail = await loadMailUpdates({ cases, state, config, until: scanUntil }); }
      catch (e) { errors.push({ source: 'gmail', error: e.message }); }
    }
    const pcMap = readJson(path.join(ROOT, 'fleet-pc-map.json'), {});
    const skipped = [], jobs = [];
    for (const targetDate of dates) {
      const daySkipped = [];
      jobs.push(...planJobs({ events: calendar.events, cases, updates: targetDate === date ? mail.updates : {}, hub: hub.cases, meetEvents,
        skipped: daySkipped, date: targetDate, reviewDay: jstDate(scanUntil), state, config, pcMap, beacons: fleet.beacons }));
      skipped.push(...daySkipped.map(row => ({ date: targetDate, ...row })));
    }
    const rows = jobs.map(j => ({ date: j.date, title: j.event?.summary || j.case?.name, kind: j.kind, case: `${j.case.id} ${j.case.name}`, match: j.match,
      pc: j.route.pc ? `${j.route.pc.remoteName} (${j.route.pc.label})` : `${j.route.requested} 未解決`, note: j.route.note, transport: chooseTransport(fleet.receivers[j.route.pc?.label]),
      send: !!j.route.pc && !!chooseTransport(fleet.receivers[j.route.pc?.label]).method && !errors.length }));
    const report = { dryRun, date, dateTo, calendars: calendar.calendars.length, events: calendar.events.length,
      caseInventory: { sheetId: config.caseSheetId, count: cases.length, ongoing: cases.filter(isActiveCase).length,
        withMeetingEventId: cases.filter(c => c.eventId).length, ambiguousIdRows: cases.filter(c => c.ambiguousId).length,
        meetEvents: meetEvents.length },
      gmail: { since: mail.since, scannedAt: mail.scannedAt, updatedThreads: mail.threads, updatedCases: Object.keys(mail.updates).length },
      matchedMeetings: jobs.filter(j => j.kind === 'meeting').length, targets: rows, skipped,
      receivers: Object.fromEntries(['作業用014', '作業用008'].map(name => { const pc = resolvePC(name, pcMap, fleet.beacons); return [name, { label: pc?.label || '未解決', ...chooseTransport(fleet.receivers[pc?.label]) }]; })),
      beacon: { ok: fleet.ok, count: fleet.beacons.length },
      warnings: [hub.warning, !fleet.ok ? `beacon未確認: ${fleet.reason}` : null].filter(Boolean), errors };
    console.log(JSON.stringify(report, null, 2));
    if (errors.length) return 1; // Partial calendar/case inventories must not silently dispatch wrong assignments.
    if (dryRun) return 0;
    await dispatchJobs({ jobs, state, config, receivers: fleet.receivers, template: fs.readFileSync(path.join(ROOT, 'templates/meeting-prep-prompt.md'), 'utf8'), send: sender(home, dir), checkpoint, google });
    state.reviewUpdates = mail.updates; state.lastReviewScan = mail.scannedAt;
    state.lastDispatch = new Date().toISOString(); checkpoint(); return 0;
  } finally { release(); }
}
if (isEntry(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(e => { console.error(`meeting-prep: ${e.message}`); process.exitCode = 1; });
