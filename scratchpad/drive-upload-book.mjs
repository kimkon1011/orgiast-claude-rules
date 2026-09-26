#!/usr/bin/env node
// lifeline-book.html を Google Docs として変換アップロードし、URL を返す（DWD 経由）
import fs from 'node:fs';
import { getDriveToken, driveApi } from '../tools/lib/drive-auth.mjs';

const LIFELINE_FOLDER = '1F8WHYZIA73PyyP833XT7V1gtbJ--BY_u';
const token = await getDriveToken();
const html = fs.readFileSync(new URL('./lifeline-book.html', import.meta.url), 'utf8');
const boundary = `book-${Date.now()}`;
const metadata = {
  name: 'ライフライン功勇（採用冊子）',
  parents: [LIFELINE_FOLDER],
  mimeType: 'application/vnd.google-apps.document',
};
const body = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`, 'utf8'),
  Buffer.from(html, 'utf8'),
  Buffer.from(`\r\n--${boundary}--`, 'utf8'),
]);
const res = await driveApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,mimeType,name', {
  method: 'POST',
  headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  body,
});
const data = await res.json();
if (!res.ok || !data.id) { console.error('失敗:', res.status, JSON.stringify(data)); process.exit(1); }
console.log(`name=${data.name}`);
console.log(`id=${data.id} mimeType=${data.mimeType}`);
console.log(`link=https://docs.google.com/a/orgiast.jp/document/d/${data.id}/edit`);
