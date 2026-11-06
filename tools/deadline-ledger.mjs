#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDriveToken } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { createSheetsClient, quoteTab } from './lib/sheets-dwd.mjs';
import { parseSheetDate, jstDate, daysUntil, columnLetter } from './vehicle-inspection-watch.mjs';
import { isEntry } from './is-entry.mjs';
export { parseSheetDate, jstDate, daysUntil };
export const HEADERS = ['ID','件名','種別','会社','期限日','残日数','状態','担当','やること','根拠','出典','出典ID','検出日','最終通知日','通知回数','完了日','備考'];
export const FIELDS = ['id','title','kind','company','due','remainingDays','status','assignee','action','quote','source','sourceId','detectedAt','lastNotified','notifyCount','completedAt','notes'];
export const KINDS = ['車検','訴訟・法務','行政・消防','補助金・申請','契約更新','支払','回答・返信','提出','その他'];
export const STATUSES = ['候補','未着手','対応中','完了','不要','延期'];
export const DEFAULT_CONFIG = {
  sheetId: '', mailboxes: ['kim@orgiast.jp','seisaku-team@orgiast.jp'], driveUsers: ['kim@orgiast.jp','seisaku-team@orgiast.jp'],
  lineSheets: ['1sCzmIvFmd2ZnDR2ZUMXmiIKjMJ21O9yMR6trY5e9JGo','1RRBNc_2Dvf5v0vdP2M7OHb6b9KhaNy9AoNo1MhZkUDI'],
  vehicleSheetId: '1mo8-hSCA-qDgblGBND-mjPEAF5fZ73etoz_mPeMZMLA', kimNames: ['kim','金','金功勇',''],
  calendar: { enabled: true, calendarId: 'kim@orgiast.jp' },
};
export const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
export const dataPath = (home, file) => path.join(home, '.claude/deadline-watch', file);
export const sheetUrl = config => `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit`;
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function loadConfig(home) {
  const saved = readJson(dataPath(home, 'config.json'), {});
  return { ...DEFAULT_CONFIG, ...saved, calendar: { ...DEFAULT_CONFIG.calendar, ...saved.calendar } };
}
// All three tools share a local lock, including the candidate/ID allocation step.
export async function withLedgerLock(home, fn) {
  const file = dataPath(home, '.lock'); fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = fs.openSync(file, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('期限台帳のロック所有者が不明です');
      try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') { fs.unlinkSync(file); continue; } throw err; }
      throw new Error('期限台帳を別プロセスが更新中です');
    }
  }
  if (fd === undefined) throw new Error('期限台帳のロックを取得できません');
  fs.writeFileSync(fd, String(process.pid));
  try { return await fn(); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
export function googleClient({ getToken = getDriveToken, fetchImpl = gwsFetch } = {}) {
  const tokens = new Map();
  return async function request(url, { user = 'kim@orgiast.jp', scope = 'https://www.googleapis.com/auth/drive', method = 'GET', body, text = false } = {}) {
    const key = `${user}|${scope}`;
    let token = tokens.get(key);
    if (!token || token.expires < Date.now()) {
      token = { value: await getToken({ impersonate: user, scope, signal: AbortSignal.timeout(30000) }), expires: Date.now() + 45 * 60000 };
      tokens.set(key, token);
    }
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) { const e = new Error(`Google ${method} HTTP ${response.status}`); e.status = response.status; throw e; }
    if (response.status === 204) return null;
    return text ? response.text() : response.json();
  };
}
export function parseRows(values, tab = '期限台帳') {
  const header = values[0] || [];
  if (HEADERS.some(h => !header.includes(h))) throw new Error(`${tab}: 見出しが不足しています`);
  return values.slice(1).flatMap((cells, i) => {
    if (!cells[header.indexOf('ID')] && !cells[header.indexOf('件名')]) return [];
    const row = Object.fromEntries(FIELDS.map((key, j) => [key, cells[header.indexOf(HEADERS[j])] ?? '']));
    return [{ ...row, due: parseSheetDate(row.due), notifyCount: Number(row.notifyCount) || 0, rowNumber: i + 2, tab, header }];
  });
}
export function serializeRow(row) { return FIELDS.map(k => row[k] ?? ''); }
export function createLedger({ sheets = createSheetsClient({ fetchImpl: gwsFetch }), config } = {}) {
  const read = async (tab = '期限台帳') => parseRows(await sheets.get(config.sheetId, `${quoteTab(tab)}!A1:Q`), tab);
  const append = (rows, tab = '期限台帳') => rows.length ? sheets.append(config.sheetId, `${quoteTab(tab)}!A:Q`, rows.map(serializeRow)) : Promise.resolve();
  async function patch(id, changes, tab = '期限台帳') {
    const row = (await read(tab)).find(r => r.id === id);
    if (!row) throw new Error(`${tab}: ${id} が見つかりません`);
    // Commit status last: a failed deferral must never hide the old deadline.
    const entries = Object.entries(changes).sort(([a], [b]) => Number(a === 'status') - Number(b === 'status'));
    for (const [key, value] of entries) {
      const field = FIELDS.indexOf(key); if (field < 0) throw new Error(`未知の列: ${key}`);
      await sheets.update(config.sheetId, `${quoteTab(tab)}!${columnLetter(row.header.indexOf(HEADERS[field]))}${row.rowNumber}`, [[value ?? '']]);
    }
    return { ...row, ...changes };
  }
  return { read, append, patch, sheets };
}
export const normalizeTitle = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
export function isDuplicate(row, rows) {
  return rows.some(r => row.sourceId && r.sourceId === row.sourceId || row.due && r.due && normalizeTitle(row.title) === normalizeTitle(r.title) && Math.abs(daysUntil(r.due, row.due)) <= 2);
}
export function nextId(rows) {
  return `D-${String(Math.max(0, ...rows.map(r => Number(/^D-(\d+)$/.exec(r.id)?.[1]) || 0)) + 1).padStart(3, '0')}`;
}
export function normalizeSeed(input, today = jstDate()) {
  const row = Object.fromEntries(FIELDS.map((key, i) => [key, input[key] ?? input[HEADERS[i]] ?? '']));
  row.title ||= input.subject || ''; row.sourceId ||= input.sourceRef || input.messageId || '';
  row.quote ||= input.evidence || ''; row.notes ||= input.note || '';
  const mailbox = /^gmail:(.+@.+)$/i.exec(row.source)?.[1];
  if (mailbox && row.sourceId && !row.sourceId.startsWith('gmail:')) {
    row.notes = JSON.stringify({ mailbox, messageId: row.sourceId }) + (row.notes ? '\n' + row.notes : '');
    row.sourceId = `gmail:${mailbox}:${row.sourceId}`; row.source = 'Gmail';
  }
  row.due = parseSheetDate(row.due); row.kind = KINDS.includes(row.kind) ? row.kind : 'その他';
  row.assignee ||= row.kind === '支払' ? '経理' : 'kim'; row.detectedAt ||= today;
  row.status = STATUSES.includes(row.status) ? row.status : row.due ? '未着手' : '候補'; row.notifyCount = 0;
  if (!row.title || !row.sourceId) throw new Error('初期データには件名と出典IDが必要です');
  return row;
}
export async function initialize({ home = defaultHome(), sheets = createSheetsClient({ fetchImpl: gwsFetch }), request = googleClient() } = {}) {
  const config = loadConfig(home);
  if (!config.sheetId) {
    const created = await request('https://sheets.googleapis.com/v4/spreadsheets', { scope: 'https://www.googleapis.com/auth/spreadsheets', method: 'POST', body: {
      properties: { title: '期限台帳' }, sheets: ['期限台帳','候補','使い方'].map(title => ({ properties: { title, gridProperties: { columnCount: 17, frozenRowCount: 1 } } })),
    } });
    if (!created.spreadsheetId) throw new Error('期限台帳の作成応答にIDがありません');
    config.sheetId = created.spreadsheetId;
    // Persist immediately: partial sharing/header failure must reuse the same book.
    saveJson(dataPath(home, 'config.json'), config);
  }
  for (const tab of ['期限台帳','候補','使い方']) {
    const meta = await sheets.metadata(config.sheetId);
    if (!meta.sheets.some(s => s.properties.title === tab)) await request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}:batchUpdate`, { scope: 'https://www.googleapis.com/auth/spreadsheets', method: 'POST', body: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { columnCount: 17, frozenRowCount: 1 } } } }] } });
    const expected = tab === '使い方' ? ['期限台帳の使い方'] : HEADERS;
    const existing = await sheets.get(config.sheetId, `${quoteTab(tab)}!A1:Q1`);
    if (!existing.length) await sheets.update(config.sheetId, `${quoteTab(tab)}!A1`, [expected]);
    else if (JSON.stringify(existing[0]) !== JSON.stringify(expected)) throw new Error(`${tab}: 見出しが異なります`);
  }
  await sheets.update(config.sheetId, "'使い方'!A2", [
    ['期限日・担当・やること・根拠を確認。状態は未着手→対応中→完了。不要は不要へ。'],
    ['候補は確認後 node tools/deadline-watch.mjs --approve <候補行番号|全部>。期限未確認の候補は期限日を入力してから承認。'],
    ['延期は --defer D-003 --until YYYY-MM-DD、完了は --done D-003、不要は --drop D-003。'],
    ['残日数と通知履歴は毎朝自動更新。担当がkim以外でも3日前からkimに提示。'],
  ]);
  const permissionsUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(config.sheetId)}/permissions`;
  const permissions = await request(`${permissionsUrl}?fields=permissions(id,emailAddress,role)`);
  for (const emailAddress of ['seisaku-team@orgiast.jp','cr@orgiast.jp']) {
    const existing = permissions.permissions?.find(p => p.emailAddress === emailAddress);
    if (existing && ['owner','writer'].includes(existing.role)) continue;
    await request(existing ? `${permissionsUrl}/${existing.id}` : `${permissionsUrl}?sendNotificationEmail=false`, { method: existing ? 'PATCH' : 'POST', body: existing ? { role: 'writer' } : { type: 'user', role: 'writer', emailAddress } });
  }
  const ledger = createLedger({ sheets, config });
  const all = [...await ledger.read(), ...await ledger.read('候補')];
  const input = readJson(dataPath(home, 'seeds.json'), []);
  const seeds = Array.isArray(input) ? input : input.items || input.seeds || [];
  let added = 0;
  for (const seed of seeds) {
    const row = normalizeSeed(seed);
    if (isDuplicate(row, all)) continue;
    row.id = nextId(all); await ledger.append([row], row.status === '候補' ? '候補' : '期限台帳'); all.push(row); added++;
  }
  saveJson(dataPath(home, 'config.json'), config);
  return { sheetId: config.sheetId, url: sheetUrl(config), added };
}
if (isEntry(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--init') throw new Error('--init を指定してください');
    console.log(JSON.stringify(await withLedgerLock(defaultHome(), () => initialize())));
  } catch (e) { console.error(`deadline-ledger: ${e.message}`); process.exitCode = 1; }
}
