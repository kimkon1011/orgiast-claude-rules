// Drive から「工具」関連ファイルを全文検索（読み取り専用）
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const token = await getDriveToken();
for (const kw of ['工具', '腰ベルト', 'タケノコ']) {
  const q = encodeURIComponent(`name contains '${kw}' and trashed=false`);
  const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=50`);
  const json = await res.json();
  console.log(`### keyword: ${kw} (${json.files?.length ?? 0} hits)`);
  for (const f of json.files ?? []) console.log(`${f.name}\t${f.mimeType}\t${f.id}\t${f.modifiedTime}`);
}
