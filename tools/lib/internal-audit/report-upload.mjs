import { getDriveToken, driveApi } from '../drive-auth.mjs';
import { upload } from '../../drive-upload.mjs';
import { auditError } from './common.mjs';

export async function uploadReport(file, { getToken = getDriveToken, api = driveApi, uploadFile = upload, keyPath, name } = {}) {
  const as = 'kim@orgiast.jp';
  const token = await getToken({ impersonate: as, keyPath });
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.search = new URLSearchParams({ q: "trashed = false and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '内部監査レポート'", fields: 'files(id,name)', pageSize: '100' });
  const listed = await (await api(token, url)).json();
  if (!Array.isArray(listed.files)) throw auditError('レポートフォルダ検索の応答形式不正');
  let folder = listed.files[0]?.id;
  if (!folder) {
    const created = await (await api(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '内部監査レポート', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }),
    })).json();
    folder = created.id;
  }
  if (!folder) throw auditError('レポートフォルダID未取得');
  return uploadFile({ file, folder, as, keyPath, name });
}
