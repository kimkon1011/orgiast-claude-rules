import { getDriveToken } from './drive-auth.mjs';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const quoteTab = (title) => `'${title.replaceAll("'", "''")}'`;

// No mutation retries: an ambiguous append response must be read back by id.
export function createSheetsClient({ fetchImpl = fetch, getToken = getDriveToken } = {}) {
  let token;
  let expires = 0;
  async function request(id, suffix = '', method = 'GET', body) {
    if (!token || Date.now() >= expires) {
      try { token = await getToken({ scope: SCOPE, impersonate: 'kim@orgiast.jp', signal: AbortSignal.timeout(30_000) }); }
      catch { throw new Error('Sheets authentication failed'); }
      expires = Date.now() + 50 * 60_000;
    }
    const response = await fetchImpl(`${API}/${encodeURIComponent(id)}${suffix}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Sheets ${method} HTTP ${response.status}`);
    return response.json();
  }
  const metadata = (id) => request(id, '?fields=spreadsheetId,spreadsheetUrl,sheets(properties)');
  const get = async (id, range) => (await request(id, `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`)).values ?? [];
  const append = (id, range, rows) => request(id, `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', { range, majorDimension: 'ROWS', values: rows });
  async function ensure(id, title, header) {
    const meta = await metadata(id);
    let tab = meta.sheets?.find((s) => s.properties.title === title)?.properties;
    if (!tab) {
      const sheetId = Math.max(0, ...meta.sheets.map((s) => s.properties.sheetId)) + 1;
      const result = await request(id, ':batchUpdate', 'POST', { requests: [
        { addSheet: { properties: { sheetId, title, gridProperties: { frozenRowCount: 1, columnCount: header.length } } } },
        { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: header.map((value) => ({ userEnteredValue: { stringValue: value } })) }], fields: 'userEnteredValue' } },
      ] });
      tab = result.replies[0].addSheet.properties;
    }
    const range = `${quoteTab(title)}!A1:M1`;
    const existing = await get(id, range);
    if (!existing.length) await request(id, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, 'PUT', { range, majorDimension: 'ROWS', values: [header] });
    else if (JSON.stringify(existing[0]) !== JSON.stringify(header)) throw new Error('Output tab header mismatch; no rows changed');
    return tab;
  }
  return { metadata, get, append, ensure };
}
const client = createSheetsClient();
export const sheetsMetadata = client.metadata;
export const sheetsGet = client.get;
export const sheetsAppend = client.append;
export const ensureSheetTab = client.ensure;
