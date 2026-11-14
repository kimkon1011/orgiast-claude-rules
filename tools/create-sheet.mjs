#!/usr/bin/env node
/**
 * 候補リストCSVをGoogleスプレッドシートに取り込む
 * 使い方: node tools/create-sheet.mjs [--apply]
 * 既定は dry-run（シート作成は --apply が必要）
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const KEY_PATH = path.resolve(process.env.HOME || process.env.USERPROFILE, '.claude/keys/aujust-sheets-reader.json');
const SA_EMAIL = 'aujust-sheets-reader@aujust-sales-automation.iam.gserviceaccount.com';
const IMPERSONATE = 'seisaku-team@orgiast.jp';

const apply = process.argv.includes('--apply');

// DWD JWT 生成
function getJwtToken(scope) {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: SA_EMAIL,
    sub: IMPERSONATE,
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
  // 最新の候補CSVを探す
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('candidates-') && f.endsWith('.csv'))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.log('候補CSVが見つかりません');
    process.exit(1);
  }
  const csvFile = files[0];
  const csvPath = path.join(DATA_DIR, csvFile);
  const csvData = fs.readFileSync(csvPath, 'utf8');
  const lines = csvData.split('\n').filter(l => l.trim());
  const header = lines[0];
  const rows = lines.slice(1).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"')));

  console.log(`CSV: ${csvFile}`);
  console.log(`データ行: ${rows.length}件`);

  // リポートCSV読み込み
  const reportCsvPath = path.join(DATA_DIR, 'reports-summary.csv');
  const reportCsv = `データ収集日,件数,データ源,次の操作
${csvFile.replace('candidates-','').replace('.csv','')},${rows.length},kkj.go.jp API,全省庁統一資格の再申請（認証後に詳細取得可能）
`;

  if (!apply) {
    console.log('\n⚠️ dry-run モード（--apply なし）');
    console.log(`   Google Sheets へ ${rows.length}行 + ヘッダーを書き込みます`);
    console.log('   レポートCSVと同一ファイルにまとめて出力');
    console.log('\n実行: node tools/create-sheet.mjs --apply');
    process.exit(0);
  }

  console.log('\n=== トークン取得中 ===');
  // spreadsheets + drive scope
  const token = await getToken('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file');

  // シート作成
  const title = `官公庁入札候補リスト ${csvFile.replace('candidates-','').replace('.csv','')}`;
  console.log(`シート作成: "${title}"`);

  const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: { title },
      sheets: [
        { properties: { title: '候補リスト' } },
        { properties: { title: '収集レポート' } }
      ]
    })
  });
  const sheet = await createResp.json();
  if (!createResp.ok) throw new Error(`Sheet creation error: ${JSON.stringify(sheet)}`);

  const sheetId = sheet.spreadsheetId;
  console.log(`作成完了: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);

  // 候補リストシートにデータ書き込み
  const values = [header.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'))];
  for (const row of rows) {
    values.push(row);
  }

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/候補リスト!A1:O${values.length}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      range: `候補リスト!A1:O${values.length}`,
      majorDimension: 'ROWS',
      values: values
    })
  });
  console.log(`データ書き込み: 候補リスト ${values.length}行`);

  // 収集レポートシート
  const reportRows = [
    ['データ収集日', '件数', 'データ源', '次の操作'],
    [csvFile.replace('candidates-','').replace('.csv',''), String(rows.length), 'kkj.go.jp API', '全省庁統一資格の再申請（認証後に詳細取得可能）']
  ];
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/収集レポート!A1:D${reportRows.length}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      range: `収集レポート!A1:D${reportRows.length}`,
      majorDimension: 'ROWS',
      values: reportRows
    })
  });
  console.log('レポートシート書き込み完了');

  // 権限共有（kim@ に編集権限）
  const driveResp = await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'user',
      role: 'writer',
      emailAddress: 'kim@orgiast.jp'
    })
  });
  const perm = await driveResp.json();
  console.log(`共有設定: kim@orgiast.jp (${perm.role || 'error: ' + JSON.stringify(perm)})`);

  // 全員閲覧可
  const anyoneResp = await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'anyone',
      role: 'reader',
      allowFileDiscovery: false
    })
  });
  const anyonePerm = await anyoneResp.json();
  console.log(`公開設定: anyone/reader (${anyonePerm.role || 'error: ' + JSON.stringify(anyonePerm)})`);

  console.log(`\n✅ 完了: https://docs.google.com/spreadsheets/d/${sheetId}/edit?authuser=seisaku-team@orgiast.jp`);
  console.log(`   開くアカウント: seisaku-team@orgiast.jp`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });