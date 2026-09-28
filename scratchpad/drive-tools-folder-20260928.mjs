// 工具関連フォルダの中身と親を調査（読み取り専用）
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const token = await getDriveToken();
const folders = [
  ['工具', '1Pv49a3tqoeRD2ZGvH-a08_Fl3UETQavQ'],
  ['工具セット', '15KjHvqpPcHs8BRXqUQSaq_QLDN8xlFFE'],
  ['工具箱①②', '1D58QKkRd-Lba4bK_lgUvYqAI9XMz220p'],
  ['工具箱③④', '1AdJkXPf65_IAjcPGOn2ZMZ8nyo1meIJo'],
];
for (const [name, id] of folders) {
  const metaRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,parents`);
  const meta = await metaRes.json();
  let parentInfo = '(root)';
  if (meta.parents?.[0]) {
    const pRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${meta.parents[0]}?fields=name`);
    parentInfo = (await pRes.json()).name;
  }
  const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
  const res = await driveApi(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100`);
  const json = await res.json();
  console.log(`\n### フォルダ「${name}」 親=${parentInfo} (${json.files?.length ?? 0} files)`);
  for (const f of json.files ?? []) console.log(`  ${f.name}\t${f.mimeType}\t${f.id}`);
}
