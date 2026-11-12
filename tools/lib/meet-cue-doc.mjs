/**
 * meet-cue-doc.mjs
 * Google Docs / Drive API 操作 (DWD)
 */

import { getDriveToken, driveApi, DRIVE_SCOPE } from './drive-auth.mjs';
import { ensureKimEditor, KIM_EMAIL } from './kim-editor.mjs';
import { buildDocHeaderRequests, buildDocCueRequests, formatJstDateTime, formatJstTime } from './meet-cue-core.mjs';

const SEISAKU_TEAM = 'seisaku-team@orgiast.jp';

export async function getDocsToken({ impersonate = SEISAKU_TEAM, getToken = getDriveToken } = {}) {
  return getToken({ impersonate, scope: DRIVE_SCOPE });
}

export async function findOrCreateFolder({ token, api = driveApi, folderName = 'Meetカンペ' } = {}) {
  // Search folder
  const query = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&supportsAllDrives=true&fields=files(id,name)`;
  const searchRes = await (await api(token, searchUrl)).json();

  if (searchRes.files && searchRes.files.length > 0) {
    return searchRes.files[0].id;
  }

  // Create folder
  const createRes = await (await api(token, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })).json();

  return createRes.id;
}

export async function setupCueDocument({
  title = '',
  staff = '',
  impersonate = SEISAKU_TEAM,
  getToken = getDriveToken,
  api = driveApi,
  ensureEditor = ensureKimEditor,
} = {}) {
  const token = await getToken({ impersonate, scope: DRIVE_SCOPE });

  // 1. Find or create "Meetカンペ" folder
  const folderId = await findOrCreateFolder({ token, api });

  // 2. Format date and document name in JST
  const now = new Date();
  const dateStr = formatJstDateTime(now);
  const docName = `カンペ_${dateStr}_${title || '打合せ'}`;

  // 3. Create Google Doc
  const createRes = await (await api(token, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: docName,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    }),
  })).json();

  const docId = createRes.id;

  // 4. Ensure kim@orgiast.jp writer permissions
  await ensureEditor(docId, { actingUser: impersonate, token, api, created: true });

  // 5. Grant staff writer permissions if different from kim and impersonate
  if (staff && staff.toLowerCase() !== KIM_EMAIL.toLowerCase() && staff.toLowerCase() !== impersonate.toLowerCase()) {
    try {
      await api(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: staff }),
      });
    } catch (e) {
      // Ignore permission error if staff domain/user fails
      console.error(`meet-cue-doc: staff permission warning (${staff}):`, e.message);
    }
  }

  // 6. Insert Header
  const header = buildDocHeaderRequests({ title, staff: staff || '担当者', dateStr });
  await api(token, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: header.requests }),
  });

  const staffUrl = `https://docs.google.com/document/d/${docId}/edit?authuser=${encodeURIComponent(staff || impersonate)}`;
  const kimUrl = `https://docs.google.com/document/d/${docId}/edit?authuser=${encodeURIComponent(KIM_EMAIL)}`;

  return {
    docId,
    docName,
    staffUrl,
    kimUrl,
    headerInsertIndex: 1 + header.headerLength,
  };
}

export async function insertCueToDocument({
  docId,
  cue,
  isKim = false,
  insertIndex = 1, // Default right after header insert index or top
  impersonate = SEISAKU_TEAM,
  getToken = getDriveToken,
  api = driveApi,
} = {}) {
  const token = await getToken({ impersonate, scope: DRIVE_SCOPE });

  const d = new Date();
  const timestampStr = formatJstTime(d);

  const cueReqs = buildDocCueRequests({
    timestampStr,
    say: cue.say,
    data: cue.data,
    url: cue.material_url || cue.url,
    isKim,
    insertIndex,
  });

  await api(token, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: cueReqs.requests }),
  });

  return {
    insertedLength: cueReqs.textLength,
    timestampStr,
  };
}
