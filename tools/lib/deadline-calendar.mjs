import { createHash } from 'node:crypto';
import { AI_CALENDAR } from './calendar-shared.mjs';

export const calendarBase = id => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`;
export const calendarOptions = { user: 'kim@orgiast.jp', scope: 'https://www.googleapis.com/auth/calendar.events' };
export function calendarIds(config) {
  const kim = config.calendar.kimCalendarId || 'kim@orgiast.jp';
  // A legacy primary setting must not make the hidden destination primary too.
  const configured = config.calendar.calendarId;
  return { kim, task: !configured || ['primary', kim].includes(configured) ? AI_CALENDAR : configured };
}
export const normalizeCase = value => String(value || '').normalize('NFKC').toLowerCase().replace(/株式会社|有限会社|医療法人|\(株\)|様|[\s\p{P}\p{S}]/gu, '');
const validCustomer = value => value && !/^(?:株式会社)?オージャスト(?:株式会社)?$|未特定|^顧客未解決$/.test(value);
export function customerName(row, existing = [], config = {}) {
  if (row.kind === '車検' || row.vehicleName) return '社内・車両';
  const codes = String([row.title, row.action, row.quote, row.notes].join(' ')).match(/\bC\d{4}\b/g) || [];
  const mapped = config.calendar?.customerNames?.[row.id] || codes.map(c => config.calendar?.caseNames?.[c]).find(Boolean);
  if (validCustomer(mapped)) return mapped;
  for (const value of [row.customerName, row.caseName, row.company]) if (validCustomer(value?.trim())) return value.trim().replace(/様$/, '');
  const text = [row.title, row.action, row.quote, row.notes, row.sourceId].filter(Boolean).join('\n');
  const explicit = text.match(/(?:顧客名|顧客|取引先|案件名|案件)\s*[:：]\s*([^\n、;]+)/)?.[1]?.trim();
  if (validCustomer(explicit)) return explicit.replace(/様$/, '');
  const honorific = text.match(/(?:^|[\n【])([^\n【】:：]{2,60}?)\s*様/u)?.[1]?.trim();
  if (validCustomer(honorific)) return honorific;
  for (const e of existing) {
    const name = String(e.description || '').match(/^案件:\s*(.+)$/m)?.[1]?.trim();
    if (validCustomer(name)) return name.replace(/様$/, '');
  }
  if (/\bPR\s*#?\d+|lane-doctor|codex-do|DeadlineWatch|rescue-policy|next-session-rotate|ハートビート|夜間ジョブ/i.test(text)) return '社内開発';
  return '';
}
export function isAiAssignee(assignee) {
  return /Claude|Codex|\bAI\b|\bPC\b|\d{3}|DESKTOP[-_]|LAPTOP[-_]|開発|PR|lane-doctor|夜間/i.test(String(assignee || '').normalize('NFKC'));
}
export function isKimTask(row, config) {
  const text = `${row.action || ''}\n${row.notes || ''}\n${row.assignee || ''}`;
  if (/(?:金さん|金功勇|kim)\s*(?:が|の)?\s*(?:送信(?:を)?承認|承認|操作|確認|判断|送信)/iu.test(text)) return true;
  const needed = row.needsKim ?? text.match(/"needsKim"\s*:\s*"([^"\n]*)"/)?.[1];
  // Session notes often contain stale/conditional approvals for an AI task.
  // An approval/send metadata type with arbitrary needsKim text is not a human
  // assignment (e.g. Claude(対話セッション), needsKim:"2の範囲").
  const required = needed && !/不要|なし|無し|false|^0$|ときだけ|場合だけ/i.test(String(needed));
  if (required && (row.needsKim === true || /^(?:要|true)(?:[（(]|$)/i.test(String(needed)))) return true;
  if (isAiAssignee(row.assignee)) return false;
  return new Set([...(config.kimNames || []), 'kim', '金', '金功勇', '金さん', ''].map(x => String(x).trim().toLowerCase())).has(String(row.assignee || '').trim().toLowerCase());
}
export function sameCase(row, event, customer = '') {
  const source = [row.source, row.sourceId, row.quote].join('\n');
  if (event.htmlLink && source.includes(event.htmlLink)) return true;
  if (event.id && /calendar/i.test(source) && source.includes(event.id)) return true;
  const text = normalizeCase(`${event.summary || ''}\n${event.description || ''}`);
  return [customer, row.caseName, row.company].filter(validCustomer).map(normalizeCase).some(name => name.length >= 3 && text.includes(name));
}
export function readableEvent(row, config, existing = []) {
  const customer = customerName(row, existing, config);
  if (!customer) return null;
  const all = [row.title, row.action].join(' ');
  const codePattern = /\b(?:C\d{4}|D-\d+|S-[A-Z0-9]+|V\d+|EIG-[A-Z0-9]+)\b/g;
  const codes = [...new Set([...(all.match(codePattern) || []), row.id].filter(Boolean))];
  const clean = text => String(text || '').replace(/【(?:期限|案件未特定|重複)】/g, '').replace(codePattern, '').replace(/[（(]\s*[）)]/g, '').replace(/https?:\/\/\S+/g, '').replace(/^[\s:：/・\-]+|[\s:：/・\-]+$/g, '').trim();
  let content = clean(row.title);
  const action = clean(row.action);
  if (action && !content.includes(action)) content = [content, action].filter(Boolean).join('・');
  const customerPrefix = customer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  content = content.replace(new RegExp(`^${customerPrefix}(?:様)?[\\s:：]+`), '');
  if (/(?:金さん|金功勇|kim)\s*(?:が)?\s*送信(?:を)?承認/iu.test(`${row.action || ''} ${row.assignee || ''} ${row.notes || ''}`) && !/承認/.test(content)) content += 'を送信承認';
  content ||= '対応内容を確認';
  const label = /^社内|^(?:株式会社)?オージャスト/.test(customer)
    ? (row.kind === '車検' || /車両/.test(customer) ? '社内・車両' : '社内')
    : customer === '労働審判' || customer.endsWith('様') ? customer : `${customer}様`;
  const url = `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit?authuser=kim@orgiast.jp`;
  return { customer, summary: `【${label}】${content}（${codes.join(' / ')}）`, description: `案件: ${customer}\n担当: ${row.assignee || 'kim'}\nやること: ${row.action || content}\n期限台帳: ${url}\nコード: ${codes.join(' / ')}\n出典: ${row.sourceId || row.quote || ''}` };
}
export async function listCalendarEvents(request, calendar, params) {
  const items = []; let pageToken;
  do {
    const query = new URLSearchParams({ maxResults: '2500', ...params, ...(pageToken ? { pageToken } : {}) });
    const result = await request(`${calendarBase(calendar)}?${query}`, calendarOptions);
    items.push(...result.items || []); pageToken = result.nextPageToken;
  } while (pageToken);
  return items.filter(e => e.status !== 'cancelled');
}
export function belongsToLedger(event, config) {
  const sheet = event.extendedProperties?.private?.deadlineSheetId || String(event.description || '').match(/spreadsheets\/(?:a\/[^/]+\/)?d\/([\w-]+)/)?.[1];
  return !sheet || sheet === config.sheetId;
}
/** Deterministic Calendar event id for a ledger row (sha256 hex). */
export function deadlineEventId(sheetId, rowId) {
  return createHash('sha256').update(`${sheetId}:${rowId}`).digest('hex');
}
/**
 * Own this event for sync/update purposes.
 * The deterministic id encodes sheetId, so a matching id is this ledger's slot even when
 * deadlineSheetId/description still point at a retired ledger copy.
 * A different deadlineId on that slot is a true foreign collision.
 */
export function isDeadlineOwnedEvent(event, row, config) {
  if (!event) return false;
  const privId = event.extendedProperties?.private?.deadlineId;
  if (privId && privId !== row.id) return false;
  if (event.id === deadlineEventId(config.sheetId, row.id)) return true;
  return privId === row.id && belongsToLedger(event, config);
}
export async function moveCalendarEvent(request, event, from, to) {
  if (from === to) return event;
  const moved = await request(`${calendarBase(from)}/${encodeURIComponent(event.id)}/move?${new URLSearchParams({ destination: to, sendUpdates: 'none' })}`, { ...calendarOptions, method: 'POST' });
  if (!moved?.id) throw Error('Calendar move の応答にIDがありません');
  return moved;
}
export async function timedDuplicates(row, due, customer, config, request) {
  const shift = n => new Date(Date.parse(due) + n * 86400000).toISOString().slice(0, 10);
  const events = await listCalendarEvents(request, calendarIds(config).kim, { timeMin: `${shift(-1)}T00:00:00+09:00`, timeMax: `${shift(2)}T00:00:00+09:00`, singleEvents: 'true' });
  return events.filter(e => e.start?.dateTime && sameCase(row, e, customer));
}
