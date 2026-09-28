// D6フォルダの中身 + 機材/持出関連ファイル検索（読み取り専用）
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const token = await getDriveToken();
// D6 フォルダの中身（親も）
const d6 = '15KjHvqpPcHs8BRXqUQSaq_QLDN8xlFFE'; // 工具セット（親がD6）
const metaRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${d6}?fields=parents`);
const meta = await metaRes.json();
const d6id = meta.parents[0];
const pRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${d6id}?fields=name,parents`);
const p = await pRes.json();
console.log(`### D6 folder id=${d6id} name=${p.name} parents=${JSON.stringify(p.parents)}`);
const q = encodeURIComponent(`'${d6id}' in parents and trashed=false`);
const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100`);
const json = await res.json();
for (const f of json.files ?? []) console.log(`  ${f.name}\t${f.mimeType}\t${f.id}\t${f.modifiedTime}`);

for (const kw of ['保有機材', '持込', '持出', '機材リスト', '物品管理']) {
  const qq = encodeURIComponent(`name contains '${kw}' and trashed=false`);
  const r2 = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${qq}&fields=files(id,name,mimeType,modifiedTime)&pageSize=30`);
  const j2 = await r2.json();
  console.log(`\n### keyword: ${kw} (${j2.files?.length ?? 0} hits)`);
  for (const f of j2.files ?? []) console.log(`  ${f.name}\t${f.mimeType}\t${f.id}\t${f.modifiedTime}`);
}
