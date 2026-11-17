#!/usr/bin/env node
/**
 * Create Google Sheet and Doc for booth exhibition sales project.
 * Usage: node tools/create-booth-deliverables.mjs
 */
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { ensureKimEditor } from './lib/kim-editor.mjs';
import { shareAndRecord } from './lib/drive-share.mjs';
import fs from 'node:fs';

const SPREADSHEET_TITLE = '【下書き】2027上期 展示会ブース営業リスト（2026-11-17）';
const DOC_TITLE = '【下書き】展示会ブース新規提案メール（2026-11-17）';
const FOLDER_ID = '1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si';
const KIM_EMAIL = 'kim@orgiast.jp';

async function main() {
  const token = await getDriveToken({ impersonate: 'seisaku-team@orgiast.jp' });

  // --- Create Spreadsheet ---
  console.log('Creating spreadsheet...');
  const sheetRes = await driveApi(token, 'https://sheets.googleapis.com/v4/spreadsheets', {
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
  });
  const sheetData = await sheetRes.json();
  const sheetId = sheetData.spreadsheetId;
  console.log(`Created spreadsheet: ${sheetId}`);

  // Move to folder
  await driveApi(token, `https://www.googleapis.com/drive/v3/files/${sheetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addParents: FOLDER_ID }),
  });

  // Share with kim
  await ensureKimEditor(sheetId, { actingUser: 'seisaku-team@orgiast.jp', token });
  await shareAndRecord({
    fileId: sheetId,
    emails: KIM_EMAIL,
    role: 'writer',
    auth: token,
    name: SPREADSHEET_TITLE,
  });

  // Verify permission
  const permRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?fields=permissions(id,emailAddress,role,type)`);
  const perms = await permRes.json();
  console.log('Spreadsheet permissions:', JSON.stringify(perms, null, 2));

  // --- Write header rows ---
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

  // Tab 1: 展示会15件 header
  await driveApi(token, `${SHEETS_API}/${sheetId}/values/%E5%B1%95%E7%A4%BA%E4%BC%9A15%E4%BB%B6!A1:H1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: [['展示会名', '会場', '会期', '主催', '公式URL', '出展社一覧ページURL', '確認状態', '確認元URL']],
    }),
  });

  // Tab 2: 出展企業50社 header
  await driveApi(token, `${SHEETS_API}/${sheetId}/values/%E5%87%BA%E5%B1%95%E4%BC%81%E6%A5%AD50%E7%A4%BE!A1:F1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: [['展示会名', '企業名', '業種（カテゴリ）', '出展ページURL', '取得元URL', '年度']],
    }),
  });

  // Tab 3: 過去実績と選定理由 header
  await driveApi(token, `${SHEETS_API}/${sheetId}/values/%E9%81%8E%E5%8E%BB%E5%AE%9F%E7%B8%BE%E3%81%A8%E9%81%B8%E5%AE%9A%E7%90%86%E7%94%B1!A1:G1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: [['展示会名', '選定理由', '類似実績（顧客名）', '実績展示会名', '業種', '案件ID', '実績PDF有無']],
    }),
  });

  console.log(`Sheet headers written.\nSpreadsheet: https://docs.google.com/spreadsheets/d/${sheetId}/edit?authuser=${KIM_EMAIL}`);

  // --- Create Doc ---
  console.log('Creating document...');
  const docRes = await driveApi(token, 'https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: DOC_TITLE,
    }),
  });
  const docData = await docRes.json();
  const docId = docData.documentId;
  console.log(`Created document: ${docId}`);

  // Move to folder
  await driveApi(token, `https://www.googleapis.com/drive/v3/files/${docId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addParents: FOLDER_ID }),
  });

  // Write content from template file
  let tmplText = '【下書き】展示会ブース新規提案メール（2026-11-17）\n\n※この文書はメール本文の下書きです。送信する際は、実際の展示会情報・実績に差し替えてご使用ください。\n\n';
  try {
    const tmplPath = 'C:\\Users\\USER\\terminals\\booth-email-template.md';
    if (fs.existsSync(tmplPath)) {
      tmplText = fs.readFileSync(tmplPath, 'utf8');
    }
  } catch {}

  await driveApi(token, `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: 1 },
          text: tmplText,
        },
      }],
    }),
  });

  // Share Doc with kim
  await ensureKimEditor(docId, { actingUser: 'seisaku-team@orgiast.jp', token });
  await shareAndRecord({
    fileId: docId,
    emails: KIM_EMAIL,
    role: 'writer',
    auth: token,
    name: DOC_TITLE,
  });

  // Verify permission
  const docPermRes = await driveApi(token, `https://www.googleapis.com/drive/v3/files/${docId}/permissions?fields=permissions(id,emailAddress,role,type)`);
  const docPerms = await docPermRes.json();
  console.log('Document permissions:', JSON.stringify(docPerms, null, 2));
  console.log(`\nDocument: https://docs.google.com/document/d/${docId}/edit?authuser=${KIM_EMAIL}`);

  // Write to status file
  fs.writeFileSync('C:\\Users\\USER\\terminals\\deliverables-urls.json', JSON.stringify({
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit?authuser=${KIM_EMAIL}`,
    documentUrl: `https://docs.google.com/document/d/${docId}/edit?authuser=${KIM_EMAIL}`,
    spreadsheetId: sheetId,
    documentId: docId,
  }, null, 2));
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });