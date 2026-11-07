import { inflateRawSync } from 'node:zlib';
import { getDriveToken } from './drive-auth.mjs';
import { gwsFetch } from './gws-proxy.mjs';
export const INQUIRY_SHEET = '1AZVagLiJ4kz3CGyvzXFGuRFM3HFmqhQym5Ts8NIa244';
export const CASES_SHEET = '14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY';
export const INQUIRY_TAB = 'フォームの回答 1';
export const normalize = v => String(v ?? '').normalize('NFKC').toLowerCase().trim();
export const companyName = v => normalize(v).replace(/株式会社|有限会社|合同会社|\(株\)|\s+/g, '');
export function dateISO(value) {
  const text = String(value || '');
  const local = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const date = local ? `${local[1]}-${local[2].padStart(2, '0')}-${local[3].padStart(2, '0')}T${(local[4] || '00').padStart(2, '0')}:${local[5] || '00'}:${local[6] || '00'}+09:00` : text;
  return Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
}
export function columnName(i) { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }
export function searchRows(values, terms, { sheetId = INQUIRY_SHEET, tab = INQUIRY_TAB, matchedRows } = {}) {
  const headers = values[0] || [], needles = terms.map(normalize).filter(Boolean);
  if (!needles.length && !matchedRows) return [];
  return values.slice(1).flatMap((row, i) => {
    if (matchedRows ? !matchedRows.has(i + 2) : !needles.some(term => row.some(cell => normalize(cell).includes(term)))) return [];
    const width = Math.max(headers.length, row.length);
    return [{ source: sheetId === INQUIRY_SHEET ? 'inquiry-sheet' : 'cases-sheet', row: i + 2,
      date: dateISO(row[0]), title: sheetId === INQUIRY_SHEET ? `${row[5] || ''} ${row[1] || ''}`.trim() : row.filter(Boolean).slice(0, 3).join(' / '),
      excerpt: sheetId === INQUIRY_SHEET ? String(row[4] || '') : row.join(' / '),
      columns: Array.from({ length: width }, (_, col) => ({ column: columnName(col), name: headers[col] || '(空)', value: row[col] ?? '' })),
      url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#range=${encodeURIComponent(`'${tab}'!A${i + 2}:${columnName(width - 1)}${i + 2}`)}` }];
  });
}
export function excludedInquiry(row, headers = []) {
  return row.some((value, i) => (i === 12 || i === 16 || /営業|対応状況/.test(headers[i] || '')) && /除外|対象外/.test(String(value)));
}
const PUBLIC_DOMAINS = new Set(['orgiast.jp', 'gmail.com', 'yahoo.co.jp', 'outlook.com', 'hotmail.com', 'icloud.com', 'googlemail.com']);
export function matchMeetingInquiries(values, job) {
  const domains = (job.event?.attendees || []).map(a => normalize(a.email).split('@')[1]).filter(d => d && !PUBLIC_DOMAINS.has(d));
  const client = companyName(job.case?.client);
  const title = companyName(job.event?.summary);
  const matched = values.slice(1).flatMap((r, i) => {
    const company = companyName(r[5]);
    const emails = [r[2], r[7]].map(normalize);
    return (domains.some(d => emails.some(e => e.split('@')[1] === d)) || (company.length >= 2 && (company === client || title.includes(company)))) ? [i + 2] : [];
  });
  const rows = new Set(matched);
  return searchRows(values, [], { matchedRows: rows });
}
// Drive export supports the existing keyless proxy. Read the named worksheet, never assume the first tab.
const xml = s => String(s).replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, n, named) => n ? String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()]);
const attrs = s => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], xml(m[2])]));
export function xlsxRows(buffer, tab) {
  let end = buffer.length - 22;
  while (end >= Math.max(0, buffer.length - 65557) && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, buffer.length - 65557)) throw Error('Invalid XLSX archive');
  const files = new Map(); let offset = buffer.readUInt32LE(end + 16), total = 0;
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid XLSX directory');
    const size = buffer.readUInt32LE(offset + 20), expanded = buffer.readUInt32LE(offset + 24), method = buffer.readUInt16LE(offset + 10);
    const nameLen = buffer.readUInt16LE(offset + 28), name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString();
    const local = buffer.readUInt32LE(offset + 42), start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (/^xl\/.*\.xml$/.test(name) || name === 'xl/_rels/workbook.xml.rels') {
      total += expanded; if (total > 64 * 1024 * 1024) throw Error('XLSX expanded size limit');
      const data = buffer.subarray(start, start + size);
      if (![0, 8].includes(method)) throw Error('Unsupported XLSX compression');
      files.set(name, (method === 8 ? inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : data).toString('utf8'));
    }
    offset += 46 + nameLen + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  const sheet = [...(files.get('xl/workbook.xml') || '').matchAll(/<sheet\s([^>]+)\/?\s*>/g)].map(m => attrs(m[1])).find(s => s.name === tab);
  if (!sheet) throw Error(`XLSX: タブ「${tab}」未確認`);
  const relation = [...(files.get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\s([^>]+)\/?\s*>/g)].map(m => attrs(m[1])).find(r => r.Id === sheet['r:id']);
  const target = relation?.Target?.replace(/^\//, '');
  const content = files.get(target?.startsWith('xl/') ? target : `xl/${target}`);
  if (!content) throw Error('XLSX: worksheet missing');
  const texts = s => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => xml(m[1])).join('');
  const strings = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const rows = [];
  for (const m of content.matchAll(/<row\s([^>]+)>([\s\S]*?)<\/row>/g)) {
    const number = Number(attrs(m[1]).r); if (!Number.isSafeInteger(number) || number < 1 || number > 1000000) throw Error('Invalid XLSX row');
    const row = [];
    for (const cell of m[2].matchAll(/<c\s([^>]+)>([\s\S]*?)<\/c>/g)) {
      const a = attrs(cell[1]), letters = a.r?.match(/^[A-Z]+/)?.[0]; if (!letters) throw Error('Invalid XLSX cell');
      const col = [...letters].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0) - 1;
      if (col > 16383) throw Error('Invalid XLSX column');
      const v = xml(cell[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] || '');
      row[col] = a.t === 's' ? strings[Number(v)] ?? '' : a.t === 'inlineStr' ? texts(cell[2]) : v;
    }
    rows[number - 1] = row;
  }
  return Array.from({ length: rows.length }, (_, i) => rows[i] || []);
}
export async function readSheet(sheetId, tab, { getToken = getDriveToken, fetchImpl = gwsFetch, signal } = {}) {
  const request = async (token, url) => {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: signal || AbortSignal.timeout(30000) });
    if (!r.ok) throw Error(`シート取得 HTTP ${r.status}`);
    return r;
  };
  try {
    const token = await getToken({ scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', signal });
    const response = await request(token, `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`'${tab.replace(/'/g, "''")}'`)}`);
    return (await response.json()).values || [];
  } catch (directError) {
    try {
      const token = await getToken({ scope: 'https://www.googleapis.com/auth/drive', signal });
      const response = await request(token, `https://www.googleapis.com/drive/v3/files/${sheetId}/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet`);
      const rows = xlsxRows(Buffer.from(await response.arrayBuffer()), tab);
      // XLSX exports dates as Excel serial numbers; inquiry dates are Japan local time.
      if (sheetId === INQUIRY_SHEET) for (const row of rows.slice(1)) if (/^\d+(?:\.\d+)?$/.test(row[0] || '')) row[0] = new Date(Math.round((Number(row[0]) - 25569) * 86400000) - 9 * 3600000).toISOString();
      return rows;
    } catch (relayError) { throw Error(`Sheets: ${directError.message}; Drive: ${relayError.message}`); }
  }
}
