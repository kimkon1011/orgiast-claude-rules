#!/usr/bin/env node
/**
 * 候補リストCSVをGoogleスプレッドシートに取り込む v2
 * SA自身のidentityでシート作成（DWD不要）
 * 使い方: node tools/create-sheet-v2.mjs [--apply]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const KEY_PATH = path.resolve(process.env.HOME || process.env.USERPROFILE, '.claude/keys/aujust-sheets-reader.json');
const SA_EMAIL = 'aujust-sheets-reader@aujust-sales-automation.iam.gserviceaccount.com';

const apply = process.argv.includes('--apply');

function getJwtToken(scope) {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: SA_EMAIL,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  });
  const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256')
    .update(b64(header) + '.' + b64(payload))
    .sign(key.private_key, 'base64url');
  return b64(header) + '.' + b64(payload) + '.' + sig;
}

async function getToken(scope) {
  const jwt = getJwtToken(scope);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token error: ${resp.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function main() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('candidates-') && f.endsWith('.csv'))
    .sort().reverse();
  if (files.length === 0) { console.log('候補CSVなし'); process.exit(1); }
  const csvFile = files[0];
  const csvPath = path.join(DATA_DIR, csvFile);
  const csvData = fs.readFileSync(csvPath, 'utf8');
  const lines = csvData.split('\n').filter(l => l.trim());
  const header = lines[0];
  const rows = lines.slice(1).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"')));

  console.log(`CSV: ${csvFile} (${rows.length}行)`);

  if (!apply) {
    console.log('\ndry-run: node tools/create-sheet-v2.mjs --apply');
    process.exit(0);
  }

  console.log('=== SA自身のトークンでシート作成 ===');
  const token = await getToken('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file');

  const title = `官公庁入札候補リスト ${csvFile.replace('candidates-','').replace('.csv','')}`;
  const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: [
        { properties: { title: '候補リスト' } },
        { properties: { title: '収集レポート' } }
      ]
    })
  });
  const sheet = await createResp.json();
  if (!createResp.ok) throw new Error(`Sheet error: ${JSON.stringify(sheet)}`);
  const sheetId = sheet.spreadsheetId;
  console.log(`作成: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);

  // データ書き込み
  const values = [header.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'))];
  for (const row of rows) values.push(row);

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/候補リスト!A1:O${values.length}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: `候補リスト!A1:O${values.length}`, majorDimension: 'ROWS', values })
  });
  console.log(`候補リスト: ${values.length}行書き込み`);

  // レポート
  const report = [
    ['データ収集日', '件数', 'データ源', '次の操作'],
    [csvFile.replace('candidates-','').replace('.csv',''), String(rows.length), 'kkj.go.jp API', '全省庁統一資格の再申請が必要']
  ];
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/収集レポート!A1:D${report.length}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: `収集レポート!A1:D${report.length}`, majorDimension: 'ROWS', values: report })
  });

  // kim@ に共有
  await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: 'kim@orgiast.jp' })
  });
  console.log('kim@ に編集権限追加');

  // anyone/reader
  await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false })
  });
  console.log('anyone/reader 公開設定');

  console.log(`\n✅ https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });