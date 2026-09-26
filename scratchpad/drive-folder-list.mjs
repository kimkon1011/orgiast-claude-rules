#!/usr/bin/env node
// Drive フォルダ内の一覧を返す（DWD 経由・読み取り専用）
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const folderId = process.argv[2];
if (!folderId) { console.error('使い方: node drive-folder-list.mjs <folderId>'); process.exit(1); }
const token = await getDriveToken();
const params = new URLSearchParams({
  q: `'${folderId}' in parents and trashed=false`,
  fields: 'files(id,name,mimeType,modifiedTime)', pageSize: '100', orderBy: 'modifiedTime desc',
});
const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files?${params}`);
const data = await res.json();
for (const f of data.files ?? []) console.log(`${f.modifiedTime?.slice(0, 10)} ${f.name} [${f.mimeType}] id=${f.id}`);
