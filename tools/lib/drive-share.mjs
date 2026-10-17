import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { getDriveToken, driveApi } from './drive-auth.mjs';

export function extractFileId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^[\w-]+$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (!['docs.google.com', 'drive.google.com'].includes(url.hostname)) return null;
    const pathname = url.pathname.replace(/^\/a\/[^/]+/, '');
    const id = pathname.match(/^\/(?:document|spreadsheets|presentation|forms|file)\/d\/([\w-]+)(?:\/|$)/)?.[1]
      ?? pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)(?:\/|$)/)?.[1]
      ?? url.searchParams.get('id');
    return id && /^[\w-]+$/.test(id) ? id : null;
  } catch { return null; }
}

export const defaultRole = email => /@orgiast\.jp$/i.test(email.trim()) ? 'writer' : 'commenter';
export function shareRecipients(emails, role) {
  if (role !== undefined && !['reader', 'commenter', 'writer'].includes(role)) throw new Error('共有ロールは reader|commenter|writer を指定してください');
  const list = [...new Set((Array.isArray(emails) ? emails : String(emails ?? '').split(',')).map(e => e.trim().toLowerCase()).filter(Boolean))];
  if (!list.length || list.some(e => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e))) throw new Error('共有先メールアドレスが不正です');
  return list.map(email => ({ email, role: role ?? defaultRole(email) }));
}

/** auth is an existing access-token string or getDriveToken options. */
export async function shareFile({ fileId, emails, role, auth }) {
  const recipients = shareRecipients(emails, role);
  try {
    if (!extractFileId(fileId) || extractFileId(fileId) !== fileId) throw new Error('不正な fileId');
    const token = typeof auth === 'string' ? auth : await getDriveToken(auth);
    const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`;
    const permissions = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ supportsAllDrives: 'true', fields: 'nextPageToken,permissions(id,type,emailAddress,role,deleted,expirationTime)', pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const page = await (await driveApi(token, `${endpoint}?${query}`)).json();
      permissions.push(...(page.permissions ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    const rank = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5, owner: 6 };
    const results = [];
    for (const recipient of recipients) {
      const exists = permissions.some(p => p.type === 'user' && !p.deleted && p.emailAddress?.toLowerCase() === recipient.email
        && (!p.expirationTime || Date.parse(p.expirationTime) > Date.now()) && rank[p.role] >= rank[recipient.role]);
      if (exists) { results.push({ ...recipient, status: 'exists' }); continue; }
      try {
        await driveApi(token, `${endpoint}?sendNotificationEmail=false&supportsAllDrives=true`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'user', emailAddress: recipient.email, role: recipient.role }),
        });
        results.push({ ...recipient, status: 'added' });
      } catch (error) { results.push({ ...recipient, status: 'error', error: error.message }); }
    }
    return results;
  } catch (error) { return recipients.map(r => ({ ...r, status: 'error', error: error.message })); }
}

export const shareLedgerPath = (home = process.env.ORGIAST_HOME || homedir()) => join(home, '.claude', 'share-ledger.jsonl');
export function recordShares(fileId, results, ledgerPath = shareLedgerPath()) {
  const rows = results.filter(r => ['added', 'exists'].includes(r.status));
  if (!rows.length) return;
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, rows.map(r => JSON.stringify({ ts: new Date().toISOString(), fileId, emails: [r.email], role: r.role }) + '\n').join(''));
}

export async function shareAndRecord({ name, ...options }, { stdout = console.log, stderr = console.error, ledgerPath } = {}) {
  const results = await shareFile(options);
  recordShares(options.fileId, results, ledgerPath);
  for (const r of results) {
    if (r.status === 'error') stderr(`共有失敗: ${r.email} (${r.role}) ${r.error}`);
    else stdout(`共有済み: ${r.email} (${r.role}) ${name}`);
  }
  if (results.some(r => r.status === 'error')) throw new Error('一部の宛先への共有に失敗しました');
  return results;
}
