#!/usr/bin/env node
// Drive 内をキーワード検索してファイル一覧を返す（DWD 経由・読み取り専用）
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const keywords = process.argv.slice(2);
if (!keywords.length) { console.error('使い方: node drive-search-lifeline.mjs <kw1> <kw2> ...'); process.exit(1); }
const token = await getDriveToken();
for (const kw of keywords) {
  const params = new URLSearchParams({
    q: `name contains '${kw.replaceAll("'", "\\'")}' and trashed=false`,
    fields: 'files(id,name,mimeType,modifiedTime)', pageSize: '15', orderBy: 'modifiedTime desc',
  });
  const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  const data = await res.json();
  console.log(`\n=== "${kw}" (${data.files?.length ?? 0}件) ===`);
  for (const f of data.files ?? []) console.log(`${f.modifiedTime?.slice(0, 10)} ${f.name} [${f.mimeType}] id=${f.id}`);
}
