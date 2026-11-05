#!/usr/bin/env node
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';
import { isEntry } from './is-entry.mjs';

export const TITLE = 'LINE受信ログ（自動・毎時）';
export const TAB = '受信ログ';
export const HEADERS = ['受信日時(JST)', 'グループ名', 'スレッドID', '表示名', '方向', '本文', '添付の保存パス', 'メッセージID'];
export const INITIAL_CURSOR = '2026-10-01T00:00:00+09:00';
const RANGE = `'${TAB}'!A2:H`;
class SafeError extends Error {}

export function maskDigits(text) {
  return String(text ?? '').replace(/(?<![\d０-９])(?:\d{4}[- ]\d{4}[- ]\d{4}|[\d０-９]{12})(?![\d０-９])/gu,
    value => value.slice(0, -4).replace(/[\d０-９]/gu, '*') + value.slice(-4));
}
export function toJst(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new SafeError('Invalid received_at timestamp');
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
export function jstToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new SafeError('Invalid sheet timestamp');
  const date = new Date(`${value.replace(' ', 'T')}+09:00`);
  if (!Number.isFinite(date.getTime()) || toJst(date) !== value) throw new SafeError('Invalid sheet timestamp');
  return date.toISOString();
}
export function attachmentPaths(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map(item => {
    const value = typeof item?.url === 'string' ? item.url.trim() : '';
    if (/^https?:/i.test(value)) {
      try { return new URL(value).pathname.match(/^\/storage\/v1\/object\/(?:sign|public|authenticated)\/(.+)$/)?.[1] ?? ''; }
      catch { return ''; }
    }
    return value.split('?')[0];
  }).filter(Boolean).join('\n');
}
export function toSheetRow(msg) {
  return [toJst(msg.received_at), maskDigits(String(msg.subject ?? '').replace(/^LINE: /, '')),
    String(msg.external_thread_id ?? ''), maskDigits(msg.sender_display_name),
    ({ inbound: '受信', outbound: '送信' })[msg.direction] ?? String(msg.direction ?? ''),
    maskDigits(msg.body).slice(0, 45000), attachmentPaths(msg.attachments), String(msg.external_message_id ?? '')];
}
export function dedupe(messages, existingIds = []) {
  const seen = new Set(existingIds);
  return messages.filter(msg => {
    const id = msg.external_message_id;
    if (typeof id !== 'string' || !id) throw new SafeError('Missing external_message_id');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
export function buildRows(messages, existingRows = []) {
  return dedupe(messages, existingRows.map(row => row[7])).map(toSheetRow);
}
function latestFrom(rows) {
  let latest = null;
  for (const row of rows) {
    if (!row[0] || row[0] === HEADERS[0]) continue;
    jstToIso(row[0]);
    if (latest === null || row[0] > latest) latest = row[0];
  }
  return latest;
}
export function cursorFrom(rows) {
  const latest = latestFrom(rows);
  return latest ? jstToIso(latest) : INITIAL_CURSOR;
}

function readConfig(file, io) {
  const values = {};
  for (const line of io.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^["']/.test(value)) value = value.slice(1, value.indexOf(value[0], 1));
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  const url = new URL(values.NEXT_PUBLIC_SUPABASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !values.SUPABASE_SERVICE_ROLE_KEY) {
    throw new SafeError('Invalid Supabase configuration');
  }
  return { url: url.href.replace(/\/$/, ''), key: values.SUPABASE_SERVICE_ROLE_KEY };
}
export async function fetchMessages({ url, key, cursor, fetchImpl = fetch }) {
  const messages = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({ channel: 'eq.line', received_at: `gte.${cursor}`,
      select: 'external_message_id,external_thread_id,direction,sender_display_name,subject,body,attachments,received_at',
      order: 'received_at.asc,external_message_id.asc', limit: '1000', offset: String(offset) });
    let response;
    try {
      response = await fetchImpl(`${url}/rest/v1/channel_messages?${query}`, { method: 'GET',
        headers: { apikey: key, Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch { throw new SafeError('Supabase GET failed'); }
    if (!response.ok) throw new SafeError(`Supabase GET HTTP ${response.status}`);
    let page;
    try { page = await response.json(); } catch { throw new SafeError('Supabase GET invalid JSON'); }
    if (!Array.isArray(page)) throw new SafeError('Supabase GET invalid response');
    messages.push(...page);
    if (page.length < 1000) return messages;
  }
}

// All error output is controlled here; external errors may contain keys or message bodies.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const io = deps.fs ?? fs, home = deps.home ?? homedir(), env = deps.env ?? process.env;
  const output = deps.output ?? console.log;
  const idFile = env.LINE_LOG_SHEET_ID_FILE ?? join(home, '.claude', 'line-log-sheet-id.txt');
  const stateFile = join(home, '.claude', 'line-log-export-state.json');
  const lastRunAt = new Date((deps.now ?? (() => new Date()))()).toISOString();
  let stage = 'Configuration', error, sheetId = null, appended = 0, totalRows = 0, latest = null;
  const save = (file, content) => { io.mkdirSync(dirname(file), { recursive: true }); io.writeFileSync(file, content, 'utf8'); };
  try {
    if (argv.some(arg => arg !== '--dry-run')) throw new SafeError('Only --dry-run is supported');
    const dryRun = argv.includes('--dry-run');
    const config = readConfig(env.LINE_LOG_ENV_FILE ?? join(home, 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.env.local'), io);
    stage = 'Sheet ID read';
    try { sheetId = io.readFileSync(idFile, 'utf8').trim() || null; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!sheetId) {
      stage = 'Drive lookup';
      const token = await (deps.getToken ?? getDriveToken)({ scope: 'https://www.googleapis.com/auth/drive', impersonate: 'kim@orgiast.jp', signal: AbortSignal.timeout(30_000) });
      const drive = async (url, options = {}) => (await (deps.driveApi ?? driveApi)(token, url, { ...options, signal: AbortSignal.timeout(30_000) })).json();
      const params = new URLSearchParams({ q: `name='${TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and 'me' in owners`, fields: 'files(id)', pageSize: '1' });
      sheetId = (await drive(`https://www.googleapis.com/drive/v3/files?${params}`)).files?.[0]?.id ?? null;
      if (!sheetId && !dryRun) {
        stage = 'Drive creation';
        sheetId = (await drive('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: TITLE, mimeType: 'application/vnd.google-apps.spreadsheet' }) })).id;
        if (!sheetId) throw new SafeError('Drive creation returned no ID');
      }
      if (sheetId && !/^[\w-]+$/.test(sheetId)) throw new SafeError('Invalid sheet ID');
      if (sheetId && !dryRun) { stage = 'Sheet ID save'; save(idFile, `${sheetId}\n`); }
    }
    if (sheetId && !/^[\w-]+$/.test(sheetId)) throw new SafeError('Invalid sheet ID');
    const sheets = deps.sheets ?? createSheetsClient({ fetchImpl: deps.fetchImpl, getToken: deps.getToken });
    let rows = [];
    stage = 'Sheet read';
    if (sheetId) {
      if (!dryRun) await sheets.ensure(sheetId, TAB, HEADERS);
      const hasTab = !dryRun || (await sheets.metadata(sheetId)).sheets?.some(s => s.properties.title === TAB);
      if (hasTab) rows = (await sheets.get(sheetId, RANGE)).filter(row => row.some(value => value !== '' && value != null));
    }
    totalRows = rows.length;
    latest = latestFrom(rows);
    const cursor = cursorFrom(rows);
    stage = 'Supabase GET';
    const additions = buildRows(await fetchMessages({ ...config, cursor, fetchImpl: deps.fetchImpl }), rows);
    if (dryRun) output(JSON.stringify({ '追記予定件数': additions.length, cursor }));
    else {
      stage = 'Sheet append';
      for (let i = 0; i < additions.length; i += 500) {
        const batch = additions.slice(i, i + 500);
        await sheets.append(sheetId, `'${TAB}'!A:H`, batch);
        appended += batch.length;
        totalRows += batch.length;
        latest = latestFrom([...rows, ...additions.slice(0, appended)]);
      }
    }
  } catch (e) { error = e instanceof SafeError ? e.message : `${stage} failed`; }
  let ok = !error;
  try { save(stateFile, JSON.stringify({ lastRunAt, ok, appended, totalRows, latest, ...(error ? { error } : {}) }) + '\n'); }
  catch { ok = false; error = error ? `${error}; State save failed` : 'State save failed'; }
  const result = { ok, sheetId, appended, totalRows, latest, ...(error ? { error } : {}) };
  output(JSON.stringify(result));
  return result;
}
if (isEntry(import.meta.url)) main().then(result => { process.exitCode = result.ok ? 0 : 1; }).catch(() => { console.error('LINE log export failed'); process.exitCode = 1; });
