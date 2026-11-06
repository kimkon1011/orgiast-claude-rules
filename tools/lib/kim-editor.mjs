import { getDriveToken, driveApi } from './drive-auth.mjs';

export const KIM_EMAIL = 'kim@orgiast.jp';
const editable = new Set(['owner', 'writer', 'organizer', 'fileOrganizer']);

/** Explicit user permission, verified after writing; shared-drive membership is also accepted. */
export async function ensureKimEditor(fileId, {
  actingUser, token, getToken = getDriveToken, api = driveApi, created = false,
} = {}) {
  if (!fileId || !/^[\w-]+$/.test(fileId)) throw new Error('kim-editor: invalid fileId');
  token ??= await getToken({ impersonate: actingUser });
  if (created) await api(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { orgiastAutomation: 'true' } }), signal: AbortSignal.timeout(30_000),
  });
  const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`;
  async function list() {
    const rows = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ supportsAllDrives: 'true', pageSize: '100', fields: 'nextPageToken,permissions(id,type,emailAddress,role,deleted,expirationTime)' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await (await api(token, `${endpoint}?${params}`, { method: 'GET', signal: AbortSignal.timeout(30_000) })).json();
      rows.push(...(page.permissions ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return rows.some(p => !p.deleted && (!p.expirationTime || Date.parse(p.expirationTime) > Date.now()) && p.type === 'user' && p.emailAddress?.toLowerCase() === KIM_EMAIL && editable.has(p.role));
  }
  if (await list()) return { fileId, changed: false };
  await api(token, `${endpoint}?supportsAllDrives=true&sendNotificationEmail=false`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: KIM_EMAIL }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!await list()) throw new Error(`kim-editor: writer read-back failed (${fileId})`);
  return { fileId, changed: true };
}
