import dns from 'node:dns';
import { getDriveToken } from './drive-auth.mjs';

// Prefer IPv4 because a slow IPv6 route caused connection timeouts and deadline-watch exit 1 on this seat (2026-11-19).
dns.setDefaultResultOrder('ipv4first');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const quoteTab = (title) => `'${title.replaceAll("'", "''")}'`;

// POST is not retried: an ambiguous append response must be read back by id.
// GET and PUT are idempotent, so wait and retry them on 429/5xx responses and transient network failures.
export function createSheetsClient({ fetchImpl = fetch, getToken = getDriveToken, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetries = 5 } = {}) {
  let token;
  let expires = 0;
  async function request(id, suffix = '', method = 'GET', body) {
    if (!token || Date.now() >= expires) {
      try { token = await getToken({ scope: SCOPE, impersonate: 'kim@orgiast.jp', signal: AbortSignal.timeout(30_000) }); }
      catch {
        // Fallback: use 'drive' scope (supported by DWD proxy) instead of 'spreadsheets'
        token = await getToken({ scope: 'https://www.googleapis.com/auth/drive', impersonate: 'seisaku-team@orgiast.jp', signal: AbortSignal.timeout(30_000) });
      }
      expires = Date.now() + 50 * 60_000;
    }
    const retryableMethod = method === 'GET' || method === 'PUT';
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);
    const retryableNetworkCodes = new Set([
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT',
      'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH',
    ]);
    for (let retries = 0; ; retries++) {
      let response;
      try {
        response = await fetchImpl(`${API}/${encodeURIComponent(id)}${suffix}`, {
          method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const retryableError = (error?.name === 'TypeError' && error?.message === 'fetch failed')
          || error?.name === 'TimeoutError'
          || retryableNetworkCodes.has(error?.cause?.code);
        if (!retryableMethod || !retryableError || retries >= maxRetries) throw error;
        await sleep(Math.min(2_000 * (2 ** retries), 60_000));
        continue;
      }
      if (response.ok) return response.json();
      if (!retryableMethod || !retryableStatuses.has(response.status) || retries >= maxRetries) {
        throw new Error(`Sheets ${method} HTTP ${response.status}`);
      }
      const retryAfter = response.headers?.get?.('Retry-After');
      const retryAfterSeconds = retryAfter === null || retryAfter === undefined || retryAfter === '' ? NaN : Number(retryAfter);
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1_000
        : 2_000 * (2 ** retries);
      await sleep(Math.min(delay, 60_000));
    }
  }
  const metadata = (id) => request(id, '?fields=spreadsheetId,spreadsheetUrl,sheets(properties)');
  const get = async (id, range) => (await request(id, `/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`)).values ?? [];
  const append = (id, range, rows) => request(id, `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, 'POST', { range, majorDimension: 'ROWS', values: rows });
  const update = (id, range, rows) => request(id, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, 'PUT', { range, majorDimension: 'ROWS', values: rows });
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
    } else if (tab.gridProperties?.frozenRowCount !== 1) {
      // Self-heal: a dragged freeze line (seen at 67 rows, 2026-10-15) makes the tab unscrollable.
      await request(id, ':batchUpdate', 'POST', { requests: [
        { updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      ] });
    }
    const range = `${quoteTab(title)}!A1:M1`;
    const existing = await get(id, range);
    if (!existing.length) await request(id, `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, 'PUT', { range, majorDimension: 'ROWS', values: [header] });
    else if (JSON.stringify(existing[0]) !== JSON.stringify(header)) throw new Error('Output tab header mismatch; no rows changed');
    return tab;
  }
  return { metadata, get, append, update, ensure };
}
const client = createSheetsClient();
export const sheetsMetadata = client.metadata;
export const sheetsGet = client.get;
export const sheetsAppend = client.append;
export const ensureSheetTab = client.ensure;
