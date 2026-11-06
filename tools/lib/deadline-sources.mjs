import fs from 'node:fs';
import path from 'node:path';
import { searchGmail } from '../gmail-search.mjs';
import { listDecisions } from '../pending-decisions.mjs';
import { readJson, jstDate } from '../deadline-ledger.mjs';
export const KEYWORDS = /期限|締切|締め切り|まで(に)?|満了|提出|回答|返送|納期|支払期日|振込期日|更新|期日|催告|督促|裁判|訴訟|答弁|準備書面|消防|質問書|届出|申請|報告書/;
export const trimBytes = text => Buffer.from(String(text || ''), 'utf8').subarray(0, 30000).toString('utf8').replace(/\uFFFD$/, '');
export function isAutomatic(mail) {
  return /github|fleet-mail|\[lane-health\]/i.test(`${mail.from || ''} ${mail.subject || ''}`)
    || /Claude.*(?:報告|まとめ|通知)|【[^】]*Claude Code】/i.test(`${mail.subject || ''} ${mail.snippet || ''}`)
    || /no-?reply/i.test(mail.from || '') && /自動返信|自動応答|auto.?reply|out of office/i.test(mail.subject || '');
}
export const wantsBody = m => !isAutomatic(m) && KEYWORDS.test(`${m.subject || ''} ${m.snippet || ''}`);
function windowState(previous = {}, now, limit) {
  const day = jstDate(now);
  return { ...previous, day, used: previous.day === day ? previous.used || 0 : 0, until: previous.until || now.toISOString(), limit };
}
function finishWindow(state, pageToken, count) {
  const next = { ...state, used: state.used + count, pageToken: pageToken || null };
  if (!pageToken) { next.watermark = state.until; delete next.until; delete next.query; }
  return next;
}
export async function collectGmail({ user, state, now, search = searchGmail }) {
  const current = windowState(state, now, 80), max = 80 - current.used;
  if (max <= 0) return { documents: [], next: state };
  const since = current.watermark ? ` after:${Math.floor(Date.parse(current.watermark) / 1000) - 1}` : '';
  const query = current.query || `newer_than:3d -category:promotions -category:social -list:googlegroups-manage${since} before:${Math.ceil(Date.parse(current.until) / 1000)}`;
  current.query = query;
  const result = await search({ user, query, max, pageToken: current.pageToken, withBody: true, bodyLimit: 30000, shouldFetchBody: wantsBody, concurrency: 3 });
  const documents = result.messages.filter(m => wantsBody(m) && m.body).map(m => ({
    source: 'Gmail', sourceRef: `gmail:${user}:${m.id}`, text: trimBytes(`${m.subject}\n${m.body}`),
    date: new Date(Number(m.internalDate) || Date.parse(m.date)).toISOString(), url: `https://mail.google.com/mail/u/${encodeURIComponent(user)}/#all/${m.threadId || m.id}`,
    mailbox: user, threadId: m.threadId, to: m.to,
  }));
  return { documents, next: finishWindow(current, result.nextPageToken, result.messages.length + (result.skipped || 0)) };
}
export async function readDriveText(file, { user, request, dryRun }) {
  let id = file.id, temporary;
  if (file.mimeType !== 'application/vnd.google-apps.document') {
    if (dryRun) return ''; // OCR copies are mutations; fixture dry-run supplies extracted text.
    const copy = await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/copy?ocrLanguage=ja&fields=id&ignoreDefaultVisibility=true`, { user, method: 'POST', body: { name: `deadline-ocr-${id}`, mimeType: 'application/vnd.google-apps.document', appProperties: { deadlineWatchOCR: '1' } } });
    if (!copy.id || copy.id === id) throw new Error('OCRコピーのIDが不正です');
    temporary = id = copy.id;
  }
  try { return trimBytes(await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`, { user, text: true })); }
  finally { if (temporary) await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(temporary)}`, { user, method: 'DELETE' }); }
}
export async function collectDrive({ user, state, now, request, dryRun = false }) {
  const current = windowState(state, now, 50), max = 50 - current.used;
  if (max <= 0) return { documents: [], next: state };
  const since = current.watermark || new Date(now.getTime() - 3 * 86400000).toISOString();
  const q = `trashed = false and modifiedTime > '${since}' and modifiedTime <= '${current.until}' and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/pdf' or mimeType contains 'image/') and not appProperties has { key='deadlineWatchOCR' and value='1' }`;
  const params = new URLSearchParams({ q, orderBy: 'modifiedTime', pageSize: String(max), fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)', ...(current.pageToken ? { pageToken: current.pageToken } : {}) });
  const result = await request(`https://www.googleapis.com/drive/v3/files?${params}`, { user });
  const documents = [];
  for (const file of result.files || []) {
    const text = await readDriveText(file, { user, request, dryRun });
    if (text) documents.push({ source: 'Drive', sourceRef: `drive:${file.id}`, text: trimBytes(`${file.name}\n${text}`), date: file.modifiedTime, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` });
  }
  return { documents, next: finishWindow(current, result.nextPageToken, result.files?.length || 0) };
}
function timestamp(value) {
  const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
}
export async function collectLine({ sheetId, state = {}, sheets, now }) {
  const values = await sheets.get(sheetId, 'Messages!A:G');
  const header = values[0] || [];
  if (!['id','ts','text'].every(k => header.includes(k))) throw new Error('LINE履歴の見出しが不足しています');
  const rows = values.slice(1).map(r => Object.fromEntries(header.map((k,i) => [k,r[i]])));
  const since = Date.parse(state.watermark || new Date(now.getTime() - 3 * 86400000).toISOString());
  const documents = rows.filter(r => timestamp(r.ts) > since && timestamp(r.ts) <= now.getTime()).map(r => ({
    source: 'LINE', sourceRef: `line:${sheetId}:${r.id}`, date: new Date(timestamp(r.ts)).toISOString(), text: trimBytes(`${r.sender || ''}: ${r.text || ''}`), url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  }));
  // Timestamp watermark follows actual rows, not wall time: delayed sync remains eligible.
  return { documents, next: { watermark: documents.length ? new Date(Math.max(...documents.map(r => Date.parse(r.date)))).toISOString() : state.watermark || new Date(since).toISOString() } };
}
export async function collectDiscord({ home, state = {}, now }) {
  const intake = readJson(path.join(home, '.claude/discord-inbox-state.json'), null);
  if (!intake) return { documents: [], next: state };
  // The intake state contains a cursor only. Actual imported messages are decisions.
  const since = Date.parse(state.watermark || new Date(now.getTime() - 3 * 86400000).toISOString());
  const documents = listDecisions({ home }).filter(r => r.source === 'discord-inbox' && Date.parse(r.capturedAt) > since && Date.parse(r.capturedAt) <= now.getTime()).map(r => ({ source: 'Discord', sourceRef: `discord:${r.id}`, date: r.capturedAt, text: trimBytes(r.text), url: '' }));
  return { documents, next: { watermark: documents.length ? new Date(Math.max(...documents.map(r => Date.parse(r.date)))).toISOString() : state.watermark || new Date(since).toISOString() } };
}
export function sourceLoaders({ home, config, state, now, sheets, request, search, dryRun }) {
  return [
    ...config.mailboxes.map(user => ({ key: `gmail:${user}`, load: () => collectGmail({ user, state: state.sources?.[`gmail:${user}`], now, search }) })),
    ...config.driveUsers.map(user => ({ key: `drive:${user}`, load: () => collectDrive({ user, state: state.sources?.[`drive:${user}`], now, request, dryRun }) })),
    ...config.lineSheets.map(sheetId => ({ key: `line:${sheetId}`, load: () => collectLine({ sheetId, state: state.sources?.[`line:${sheetId}`], now, sheets }) })),
    { key: 'discord', load: () => collectDiscord({ home, state: state.sources?.discord, now }) },
  ];
}
export function fixtureLoaders(dir) {
  return ['gmail','drive','line','discord'].map(name => ({ key: name, load: async () => ({ documents: readJson(path.join(dir, `${name}.json`), []), next: {} }) }));
}
