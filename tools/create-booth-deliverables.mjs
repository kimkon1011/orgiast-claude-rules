#!/usr/bin/env node
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import fs from 'node:fs';

const SPREADSHEET_TITLE = '【下書き】2027上期 展示会ブース営業リスト（2026-11-17）';
const DOC_TITLE = '【下書き】展示会ブース新規提案メール（2026-11-17）';
const KIM_EMAIL = 'kim@orgiast.jp';
const ACTING_USER = 'seisaku-team@orgiast.jp';

async function main() {
  const token = await getDriveToken({ impersonate: ACTING_USER });
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const DOCS = 'https://docs.googleapis.com/v1/documents';

  // Create Sheet
  console.log('Creating spreadsheet...');
  const sheetData = await driveApi(token, SHEETS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: SPREADSHEET_TITLE },
      sheets: [
        { properties: { title: '展示会15件' } },
        { properties: { title: '出展企業50社' } },
        { properties: { title: '過去実績と選定理由' } },
      ],
    }),
  }).then(r => r.json());
  const sheetId = sheetData.spreadsheetId;
  console.log(`Sheet ID: ${sheetId}`);

  // Get actual sheet IDs from properties
  const props = await driveApi(token, `${SHEETS}/${sheetId}?fields=sheets.properties`, { method: 'GET' }).then(r => r.json());
  const sheetIds = props.sheets.map(s => s.properties.sheetId);
  console.log('Sheet tab IDs:', sheetIds);

  const [tab0, tab1, tab2] = sheetIds;

  // Write headers via batchUpdate
  const updateRow = async (tabIdx, headers) => {
    await driveApi(token, `${SHEETS}/${sheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          updateCells: {
            range: { sheetId: tabIdx, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length },
            rows: [{ values: headers.map(v => ({ userEnteredValue: { stringValue: v } })) }],
            fields: 'userEnteredValue',
          },
        }],
      }),
    });
  };

  await updateRow(tab0, ['展示会名','会場','会期','主催','公式URL','出展社一覧ページURL','確認状態','確認元URL']);
  console.log('Tab1 headers written');
  await updateRow(tab1, ['展示会名','企業名','業種','出展ページURL','取得元URL','年度']);
  console.log('Tab2 headers written');
  await updateRow(tab2, ['展示会名','選定理由','類似実績(顧客名)','実績展示会名','業種','案件ID','実績PDF有無']);
  console.log('Tab3 headers written');

  // Share with kim
  try {
    await driveApi(token, `${DRIVE}/${sheetId}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: KIM_EMAIL }),
    });
    console.log('Sheet shared with kim');
  } catch (e) { console.log(`Sheet share note: ${e.message}`); }

  // Verify permissions
  try {
    const pr = await driveApi(token, `${DRIVE}/${sheetId}/permissions?fields=permissions(id,emailAddress,role,type)&supportsAllDrives=true`, { method: 'GET' }).then(r => r.json());
    console.log('Sheet perms:', JSON.stringify((pr.permissions||[]).map(p => ({email:p.emailAddress,role:p.role}))));
  } catch (e) { console.log(`Perm read note: ${e.message}`); }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?authuser=${KIM_EMAIL}`;

  // Create Doc
  console.log('Creating document...');
  const docData = await driveApi(token, DOCS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: DOC_TITLE }),
  }).then(r => r.json());
  const docId = docData.documentId;
  console.log(`Doc ID: ${docId}`);

  let content = `【下書き】展示会ブース新規提案メール（2026-11-17）\n\n`;
  try { const p = 'C:\\Users\\USER\\terminals\\booth-email-template.md'; if (fs.existsSync(p)) content = fs.readFileSync(p, 'utf8'); } catch {}
  await driveApi(token, `${DOCS}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
  });
  console.log('Doc content written');

  // Share Doc
  try {
    await driveApi(token, `${DRIVE}/${docId}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: KIM_EMAIL }),
    });
    console.log('Doc shared with kim');
  } catch (e) { console.log(`Doc share note: ${e.message}`); }

  try {
    const dpr = await driveApi(token, `${DRIVE}/${docId}/permissions?fields=permissions(id,emailAddress,role,type)&supportsAllDrives=true`, { method: 'GET' }).then(r => r.json());
    console.log('Doc perms:', JSON.stringify((dpr.permissions||[]).map(p => ({email:p.emailAddress,role:p.role}))));
  } catch (e) { console.log(`Doc perm read note: ${e.message}`); }

  const docUrl = `https://docs.google.com/document/d/${docId}/edit?authuser=${KIM_EMAIL}`;

  fs.writeFileSync('C:\\Users\\USER\\terminals\\deliverables-urls.json', JSON.stringify({ spreadsheetUrl: sheetUrl, documentUrl: docUrl, spreadsheetId: sheetId, documentId: docId }, null, 2));
  console.log(`\nSheet: ${sheetUrl}`);
  console.log(`Doc: ${docUrl}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });