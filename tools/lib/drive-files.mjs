import { ensureKimEditor } from './kim-editor.mjs';
// drive-files.mjs — Shared Google Drive REST API utilities
import { driveApi as api } from './drive-auth.mjs';

/**
 * Finds files by their title within a parent directory.
 * Ordered by modifiedTime desc so the latest is first.
 */
export async function findByTitle(token, title, parentId, { apiFn = api } = {}) {
  const q = encodeURIComponent(`name='${title.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`);
  const res = await apiFn(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`);
  const json = await res.json();
  return json.files ?? [];
}

/**
 * Lists all active files within a parent directory.
 * Ordered by name.
 */
export async function listFiles(token, parentId, { apiFn = api } = {}) {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
  const res = await apiFn(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=name`);
  const json = await res.json();
  return json.files ?? [];
}

/**
 * Finds or creates a subfolder by name within a parent directory.
 */
export async function findOrCreateFolder(token, folderName, parentId, { apiFn = api } = {}) {
  const q = encodeURIComponent(`name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await apiFn(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  const json = await res.json();
  if (json.files && json.files.length > 0) {
    return json.files[0];
  }
  const createRes = await apiFn(token, 'https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      name: folderName,
      parents: [parentId],
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  return await createRes.json();
}

/**
 * Downloads a file's raw content as a Buffer.
 */
export async function downloadFileContent(token, fileId, { apiFn = api } = {}) {
  const res = await apiFn(token, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Uploads a file's content.
 * If fileId is provided, performs a PATCH (update/in-place).
 * If fileId is null/undefined, performs a multipart POST (create) in parentId.
 */
export async function uploadFileContent(token, { fileId, name, parentId, content, apiFn = api, mimeType = 'text/plain', contentType = 'text/plain; charset=utf-8' } = {}) {
  if (fileId) {
    const res = await apiFn(token, `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': contentType },
      body: content,
    });
    return { id: fileId };
  } else {
    const meta = JSON.stringify({ name, parents: [parentId], mimeType });
    const boundary = 'x-claude-hub-sync';
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content.toString('utf8')}\r\n--${boundary}--`;
    const res = await apiFn(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const created = await res.json();
    await ensureKimEditor(created.id, { token, api: apiFn, created: true });
    return created;
  }
}
