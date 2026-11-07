import path from 'node:path';
import { DAY, dateOnly, getJson, readJson, writePrivate, maskNumbers, reason, auditError } from './common.mjs';
export const PAYEE_SHEETS = Object.freeze({
  old: '1sqFlqPfYzlQtMPE0r3olyHdeVTtkTdiOefCavUIP0LU',
  paypay: '17J0_ahQ4rByhv1jEKL3tRpwFcsM7lV_9Z7_BDhRMNbM',
  form: '1Uu0bdtI9AnHVJ9325SsbGIEWxl1uk3z8e9jzp0aF2RU',
});
export function bankRecipient(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/\s+([\u3099\u309a])/g, '$1').normalize('NFC');
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s))) return dateOnly(s);
  const m = s.match(/(?:普通|当座|貯蓄)(?:預金)?\s*[\d*]+\s*(.+)/u);
  return m ? maskNumbers(m[1].replace(/\(依頼人名[：:].*$/u, '').trim()) : '';
}
const clean = v => String(v ?? '').normalize('NFKC').replace(/\s/g, '');
export const sheetAmount = v => Number(clean(v).replace(/[,¥円]/g, ''));
export function sheetDate(v) {
  const s = String(v ?? '').normalize('NFKC').trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s))) return dateOnly(s);
  const m = s.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日|$|T|\s)/);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d ? d : '';
  }
  if (typeof v === 'number' && v > 30000 && v < 100000) return new Date((Math.floor(v) - 25569) * DAY).toISOString().slice(0, 10);
  return '';
}
export function sheetLayout(rows, kind, tab) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const h = rows[i].map(clean), idx = text => h.findIndex(v => v.includes(text));
    if (kind === 'form' && idx('支払合計金額') >= 0 && idx('対応完了日') >= 0 && idx('対応者名前') >= 0)
      return { header: i, type: 'form', date: idx('対応完了日'), amount: idx('支払合計金額'), name: idx('依頼者'), handler: idx('対応者名前') };
    if (idx('振込予定日') >= 0 && idx('依頼金額') >= 0 && idx('取引先(名前') >= 0)
      return { header: i, type: 'schedule', date: idx('振込予定日'), amount: idx('依頼金額'), name: idx('取引先(名前'), category: idx('業務内容'), bank: idx('振込先'), check: idx('二重チェック') };
    if (idx('振込指定日(年)') >= 0 && idx('受取人名') >= 0 && idx('振込金額') >= 0)
      return { header: i, type: 'bank', year: idx('振込指定日(年)'), month: idx('振込指定日(月)'), day: idx('振込指定日(日)'), amount: idx('振込金額'), name: idx('受取人名'), status: idx('振込状況') };
    if (idx('取引日') >= 0 && idx('取引内容') >= 0 && idx('出金額') >= 0)
      return { header: i, type: 'upload', date: idx('取引日'), amount: idx('出金額'), name: idx('取引内容') };
  }
  // Verified headerless history has a full date, bank details and amount. Never infer a year from an MMDD tab.
  if (kind === 'paypay' && tab === '楽天履歴' && sheetDate(rows[0]?.[0])) return { header: -1, type: 'rakuten', date: 0, name: 1, amount: 2 };
  return null;
}
export function parseSheetRows(rows, { kind, tab, layout = sheetLayout(rows, kind, tab), offset = 0 } = {}) {
  if (!layout) return [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (offset + i <= layout.header) continue;
    const r = rows[i], amount = sheetAmount(r[layout.amount]);
    const date = layout.type === 'bank' ? sheetDate(`${r[layout.year]}/${r[layout.month]}/${r[layout.day]}`) : sheetDate(r[layout.date]);
    let name = String(r[layout.name] || '').normalize('NFKC').trim();
    if (layout.type === 'rakuten') name = bankRecipient(name);
    if (layout.type === 'form') name ||= String(r[layout.handler] || '').normalize('NFKC').trim();
    if (layout.type === 'bank' && /取消|失敗|エラー|返却/.test(r[layout.status] || '')) continue;
    if (!date || !Number.isFinite(amount) || amount <= 0) continue;
    out.push({ date, amount, name: maskNumbers(name), category: maskNumbers(r[layout.category]),
      handler: maskNumbers(r[layout.handler]), bankName: layout.bank >= 0 ? bankRecipient(r[layout.bank]) : '', doubleCheck: layout.check >= 0 ? maskNumbers(r[layout.check]).trim() : null,
      source: kind, tab, row: offset + i + 1, format: layout.type });
  }
  return out;
}
const col = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
export async function collectPayeeSheets({ google, fetchImpl = fetch, signal, stateDir, now = new Date(), secrets = [] } = {}) {
  const file = path.join(stateDir, 'payee-sheet-cache.json'), cache = await readJson(file, {});
  if (cache.version === 2 && +now >= Date.parse(cache.fetchedAt) && +now - Date.parse(cache.fetchedAt) < 7 * DAY) return { ...cache, cached: true };
  const sources = {}, rows = [], structures = [];
  for (const [kind, id] of Object.entries(PAYEE_SHEETS)) try {
    const token = await google.getToken({ scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', impersonate: 'kim@orgiast.jp' });
    const request = url => getJson(url, { headers: { Authorization: `Bearer ${token}` }, fetchImpl, signal });
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
    const meta = await request(`${base}?fields=properties.title,sheets.properties`);
    if (!Array.isArray(meta.sheets)) throw auditError('Sheets タブ情報がありません');
    const tabs = meta.sheets.map(s => s.properties).filter(s => kind === 'form' ? s.title === '購買依頼フォーム' : s.title !== '銀行コード一覧');
    const range = (s, start, end) => `'${s.title.replace(/'/g, "''")}'!A${start}:${col(Math.min(s.gridProperties.columnCount, 45))}${end}`;
    const headersUrl = new URL(`${base}/values:batchGet`);
    for (const tab of tabs) headersUrl.searchParams.append('ranges', range(tab, 1, 5));
    const headers = await request(headersUrl);
    if (headers.valueRanges?.length !== tabs.length) throw auditError('Sheets ヘッダー応答が不完全');
    let count = 0, usable = 0; const excluded = [];
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i], layout = sheetLayout(headers.valueRanges?.[i]?.values || [], kind, tab.title);
      structures.push({ source: kind, tab: tab.title, layout });
      if (!layout) { excluded.push(tab.title); continue; }
      usable++;
      // Bounded reads, batched to stay below the per-user request quota. No raw rows are persisted.
      const url = new URL(`${base}/values:batchGet`), chunks = [];
      for (let start = 1; start <= tab.gridProperties.rowCount; start += 500) { chunks.push(start - 1); url.searchParams.append('ranges', range(tab, start, Math.min(start + 499, tab.gridProperties.rowCount))); }
      const result = await request(url);
      if (result.valueRanges?.length !== chunks.length) throw auditError('Sheets 範囲応答が不完全');
      for (let c = 0; c < chunks.length; c++) {
        const parsed = parseSheetRows(result.valueRanges[c].values || [], { kind, tab: tab.title, layout, offset: chunks[c] });
        count += parsed.length; for (const row of parsed) rows.push(row);
      }
    }
    if (!usable) throw auditError('Sheets 対応するヘッダーがありません');
    sources[`payee-sheet:${kind}`] = { status: excluded.length ? 'partial' : 'ok', count, reason: `読み取り専用・${usable}タブ。${excluded.length ? `日付/対応ヘッダー不足で対象外: ${excluded.join(', ')}` : 'ヘッダー確認済み'}` };
  } catch (e) { sources[`payee-sheet:${kind}`] = { status: 'failed', count: 0, reason: reason(e) }; }
  const result = { version: 2, fetchedAt: now.toISOString(), rows, sources, structures };
  // A failed fetch must be retried next run, never frozen for seven days.
  if (Object.values(sources).every(s => s.status !== 'failed')) await writePrivate(file, result, secrets);
  return result;
}
