#!/usr/bin/env node
// ブース制作アプリ本番 GAS のコマンドキューへ cmd_*.json を投函し、result_*.txt を取得する。
// 使い方: node booth-cmd.mjs <command> '<argsJson>' [--wait <秒>] [--as <email>]
import { getDriveToken } from '../tools/lib/drive-auth.mjs';
import { uploadFileContent, findByTitle, downloadFileContent } from '../tools/lib/drive-files.mjs';

const CMD_FOLDER_ID = '1W9uuMTPO_rduhD3l2a7eLxuU0bngRjPz';
const argv = process.argv.slice(2);
const command = argv[0];
if (!command) { console.error('command required'); process.exit(2); }
let args = [];
let waitSec = 240;
let as = process.env.GOOGLE_IMPERSONATE || 'kim@orgiast.jp';
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--wait') { waitSec = Number(argv[++i]); }
  else if (argv[i] === '--as') { as = argv[++i]; }
  else { args = JSON.parse(argv[i]); }
}
const uniq = 'row27verify' + Date.now().toString(36);
const cmdName = `cmd_${uniq}.json`;
const resultName = `result_${uniq}.txt`;

const token = await getDriveToken({ impersonate: as });
const payload = JSON.stringify({ command, args });
console.log(`[put] ${cmdName} -> folder ${CMD_FOLDER_ID} as ${as}`);
await uploadFileContent(token, { name: cmdName, parentId: CMD_FOLDER_ID, content: Buffer.from(payload, 'utf8') });

const deadline = Date.now() + waitSec * 1000;
let found = null;
while (Date.now() < deadline) {
  const hits = await findByTitle(token, resultName, CMD_FOLDER_ID);
  if (hits.length) { found = hits[0]; break; }
  await new Promise((r) => setTimeout(r, 15000));
}
if (!found) { console.error(`[timeout] result not found within ${waitSec}s: ${resultName}`); process.exit(3); }
const body = await downloadFileContent(token, found.id);
console.log(`[result] ${resultName}`);
console.log(body.toString('utf8'));
