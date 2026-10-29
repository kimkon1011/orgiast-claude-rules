import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const TITLE = 'LINE受信ログ（自動・毎時）';
const HEADERS = ['受信日時(JST)', 'グループ名', 'スレッドID', '表示名', '方向', '本文', '添付の保存パス', 'メッセージID'];
const INITIAL_CURSOR = '2026-10-01T00:00:00+09:00';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const LOOKBACK_MS = 6 * 3600_000;

export function maskPersonalNumbers(text) {
  return String(text ?? '').replace(/(?<![\d０-９])[\d０-９]{12}(?![\d０-９])/gu, digits => `********${digits.slice(-4)}`);
}

export function formatJst(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid received_at timestamp');
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function attachmentPaths(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map(item => typeof item?.url === 'string' ? item.url.trim() : '')
    .filter(value => value && !/^http/i.test(value) && !/token=/i.test(value))
    .join('\n');
}

export function toSheetRow(msg) {
  return [formatJst(msg.received_at), maskPersonalNumbers(String(msg.subject ?? '').replace(/^LINE: /, '')),
    String(msg.external_thread_id ?? ''), maskPersonalNumbers(msg.sender_display_name), String(msg.direction ?? ''),
    maskPersonalNumbers(msg.body).slice(0, 45000), attachmentPaths(msg.attachments), String(msg.external_message_id ?? '')];
}

export function cursorFromSheet(rows) {
  let latest = '';
  for (const row of rows) {
    const value = row?.[0];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      && Number.isFinite(Date.parse(`${value.replace(' ', 'T')}+09:00`)) && value > latest) latest = value;
  }
  return latest ? new Date(`${latest.replace(' ', 'T')}+09:00`).toISOString() : INITIAL_CURSOR;
}

export function selectNewMessages(messages, existingIds) {
  const seen = new Set(existingIds);
  return messages.filter(msg => {
    const id = msg.external_message_id;
    if (typeof id !== 'string' || !id) throw new Error('Missing external_message_id');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function config() {
  const names = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const values = {};
  if (names.some(name => !process.env[name])) {
    let file = process.env.LINE_LOG_ENV_FILE ?? 'C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.env.local';
    if (process.platform !== 'win32' && /^[A-Za-z]:\//.test(file)) file = `/mnt/${file[0].toLowerCase()}${file.slice(2)}`;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { throw new Error('Cannot read LINE_LOG_ENV_FILE'); }
    for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.trim().match(/^(?:export\s+)?(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (/^["']/.test(value)) value = value.slice(1, value.indexOf(value[0], 1));
      else value = value.replace(/\s+#.*$/, '').trim();
      values[match[1]] = value;
    }
  }
  for (const name of names) {
    values[name] = process.env[name] || values[name];
    if (!values[name]) throw new Error(`Missing ${name}`);
  }
  let url;
  try { url = new URL(values.NEXT_PUBLIC_SUPABASE_URL); } catch { throw new Error('Invalid Supabase URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Supabase URL');
  return { url: url.href.replace(/\/$/, ''), key: values.SUPABASE_SERVICE_ROLE_KEY };
}

// Never expose response bodies, request URLs, or underlying errors: they may contain credentials.
async function request(url, options, label) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000), redirect: 'error' }); }
  catch { throw new Error(`${label}: network request failed or timed out`); }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new Error(`${label}: invalid JSON response`); }
}

export async function main({ dryRun = false } = {}) {
  const { url, key } = config();
  let token;
  try {
    token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets', signal: AbortSignal.timeout(60_000) });
  } catch { throw new Error('Google authentication failed (check DWD credentials/relay)'); }
  const google = (endpoint, method = 'GET', body) => request(endpoint, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 'Google API');
  const idFile = path.join(os.homedir(), '.claude', 'line-log-sheet-id.txt');
  let sheetId = '';
  try { sheetId = fs.readFileSync(idFile, 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read sheet ID file'); }
  if (!sheetId) {
    const query = new URLSearchParams({ q: `name='${TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`, fields: 'files(id)', pageSize: '1' });
    const found = await google(`https://www.googleapis.com/drive/v3/files?${query}`);
    sheetId = found.files?.[0]?.id ?? '';
  }
  if (!sheetId && !dryRun) {
    const created = await google(SHEETS, 'POST', {
      properties: { title: TITLE }, sheets: [{ properties: { title: 'ログ', gridProperties: { frozenRowCount: 1 } } }],
    });
    sheetId = created.spreadsheetId;
  }
  if (sheetId && !/^[\w-]+$/.test(sheetId)) throw new Error('Invalid sheet ID');
  let rows = [], range = '';
  if (sheetId) {
    const metadata = await google(`${SHEETS}/${sheetId}?fields=sheets.properties`);
    const first = metadata.sheets?.[0]?.properties;
    if (!first) throw new Error('Spreadsheet has no worksheet');
    const tab = `'${first.title.replace(/'/g, "''")}'`;
    range = `${tab}!A:H`;
    const query = new URLSearchParams();
    query.append('ranges', `${tab}!A:A`);
    query.append('ranges', `${tab}!H:H`);
    const data = await google(`${SHEETS}/${sheetId}/values:batchGet?${query}`);
    const dates = data.valueRanges?.[0]?.values ?? [];
    const ids = data.valueRanges?.[1]?.values ?? [];
    rows = Array.from({ length: Math.max(dates.length, ids.length) }, (_, i) => [dates[i]?.[0] ?? '', ...Array(6).fill(''), ids[i]?.[0] ?? '']);
    // Also repairs a create interrupted before initialization, without changing existing data.
    if (!rows.length && !dryRun) {
      await google(`${SHEETS}/${sheetId}/values/${encodeURIComponent(`${tab}!A1:H1`)}?valueInputOption=RAW`, 'PUT', { values: [HEADERS] });
      await google(`${SHEETS}/${sheetId}:batchUpdate`, 'POST', { requests: [{ updateSheetProperties: {
        properties: { sheetId: first.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount',
      } }] });
    }
    if (!dryRun) {
      try { fs.mkdirSync(path.dirname(idFile), { recursive: true }); fs.writeFileSync(idFile, `${sheetId}\n`, 'utf8'); }
      catch { throw new Error('Cannot save sheet ID file'); }
    }
  }
  // Re-read a few hours before the sheet's latest row: webhook ingestion can land late; IDs dedupe the overlap.
  const latest = cursorFromSheet(rows);
  const cursor = latest === INITIAL_CURSOR ? latest : new Date(Date.parse(latest) - LOOKBACK_MS).toISOString();
  const messages = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({ channel: 'eq.line', received_at: `gte.${cursor}`,
      select: 'external_message_id,external_thread_id,direction,sender_display_name,subject,body,attachments,received_at',
      order: 'received_at.asc,external_message_id.asc', limit: '1000', offset: String(offset) });
    const page = await request(`${url}/rest/v1/channel_messages?${query}`, {
      method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}` },
    }, 'Supabase GET');
    if (!Array.isArray(page)) throw new Error('Supabase GET: expected an array');
    messages.push(...page);
    if (page.length < 1000) break;
  }
  const dataRows = rows.filter(row => row[7] && row[7] !== HEADERS[7]);
  const additions = selectNewMessages(messages, dataRows.map(row => row[7])).map(toSheetRow);
  if (!dryRun) {
    for (let i = 0; i < additions.length; i += 500) {
      const batch = additions.slice(i, i + 500);
      const result = await google(`${SHEETS}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', { values: batch });
      if (result.updates?.updatedRows !== batch.length) throw new Error('Google API: appended row count mismatch');
    }
  }
  return { ok: true, sheetId: sheetId || null, fetched: messages.length, appended: dryRun ? 0 : additions.length,
    totalRows: dataRows.length + (dryRun ? 0 : additions.length),
    latestReceivedJst: formatJst(cursorFromSheet(dryRun ? rows : [...rows, ...additions])),
    ...(dryRun ? { dryRun: true, wouldAppend: additions.length } : {}) };
}

if (isEntry(import.meta.url)) {
  const unknown = process.argv.slice(2).some(arg => arg !== '--dry-run');
  if (unknown) { console.error('Usage: node tools/line-log-export.mjs [--dry-run]'); process.exitCode = 1; }
  else main({ dryRun: process.argv.includes('--dry-run') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
