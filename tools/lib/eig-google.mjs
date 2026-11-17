import { getDriveToken } from './drive-auth.mjs';
import { gwsFetch } from './gws-proxy.mjs';
export const FOLDER = '11aNyUT75_70j-S6xN26mTv5ML1eEcze7';
export const TITLE = '【飲食×AI】集客KPI 日次';
export const quote = title => `'${title.replaceAll("'", "''")}'`;
export const col = n => { let s = ''; for (; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
export function googleClient() {
  const tokens = new Map();
  return async function api(service, path, method = 'GET', body) {
    if (service === 'gmail' && method !== 'GET') throw new Error('Gmail is read-only');
    const scope = `https://www.googleapis.com/auth/${service === 'gmail' ? 'gmail.readonly' : 'drive'}`;
    if (!tokens.has(scope)) tokens.set(scope, await getDriveToken({ scope, impersonate: 'seisaku-team@orgiast.jp', signal: AbortSignal.timeout(30_000) }));
    const base = { gmail: 'https://gmail.googleapis.com/gmail/v1/users/me', drive: 'https://www.googleapis.com/drive/v3', sheets: 'https://sheets.googleapis.com/v4/spreadsheets' }[service];
    if (!base) throw new Error('Unsupported service');
    const r = await gwsFetch(base + path, { method, headers: { Authorization: `Bearer ${tokens.get(scope)}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000) });
    // Never print API response bodies (credentials, mail bodies, PII).
    if (!r.ok) throw new Error(`${service} ${method} HTTP ${r.status}`);
    return r.status === 204 ? {} : r.json();
  };
}
export async function folderFiles(api) {
  const files = []; let pageToken;
  do {
    const q = `'${FOLDER}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`;
    const r = await api('drive', `/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name)&pageSize=100${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
    files.push(...(r.files || [])); pageToken = r.nextPageToken;
  } while (pageToken);
  return files;
}
export function uniqueFile(files, name, exact = false) {
  const matches = files.filter(f => exact ? f.name === name : f.name.includes(name));
  if (matches.length !== 1) throw new Error(`Expected one spreadsheet: ${name} (${matches.length})`);
  return matches[0];
}
export const metadata = (api, id) => api('sheets', `/${id}?fields=spreadsheetId,sheets(properties)`);
export async function values(api, id, range) { return (await api('sheets', `/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`)).values || []; }
export async function readMaster(api, file) {
  const meta = await metadata(api, file.id);
  const tab = meta.sheets.find(s => s.properties.title === '配信先マスター')?.properties;
  if (!tab) throw new Error('Master tab missing');
  const result = [];
  // Chunk the full used grid, never truncate at an arbitrary 100/1000 rows.
  for (let start = 1; start <= tab.gridProperties.rowCount; start += 1000) {
    const rows = await values(api, file.id, `${quote(tab.title)}!A${start}:${col(tab.gridProperties.columnCount)}${Math.min(start + 999, tab.gridProperties.rowCount)}`);
    result.push(...rows);
  }
  return result;
}
