#!/usr/bin/env node
/**
 * Create Google Sheet and Doc using direct service account auth (bypass gws proxy).
 */
import { getServiceAccountToken } from './lib/drive-auth.mjs';
import fs from 'node:fs';

const SPREADSHEET_TITLE = '【下書き】2027上期 展示会ブース営業リスト（2026-11-17）';
const DOC_TITLE = '【下書き】展示会ブース新規提案メール（2026-11-17）';
const KIM_EMAIL = 'kim@orgiast.jp';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents';

async function api(url, opts = {}, token) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const token = await getServiceAccountToken({ scope: DRIVE_SCOPE });
  console.log('Got SA token (service account self, not impersonated)');

  // --- Create Spreadsheet ---
  console.log('Creating spreadsheet...');
  const sheetData = await api('https://sheets.googleapis.com/v4/spreadsheets', {
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
  }, token);
  const sheetId = sheetData.spreadsheetId;
  console.log(`Sheet ID: ${sheetId}`);

  // Share with kim
  await api(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?sendNotificationEmail=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: KIM_EMAIL }),
  }, token);
  console.log('Shared sheet with kim');

  // Write headers
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
  await api(`${SHEETS_API}/${sheetId}/values/%E5%B1%95%E7%A4%BA%E4%BC%9A15%E4%BB%B6!A1:H1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['展示会名', '会場', '会期', '主催', '公式URL', '出展社一覧ページURL', '確認状態', '確認元URL']] }),
  }, token);
  await api(`${SHEETS_API}/${sheetId}/values/%E5%87%BA%E5%B1%95%E4%BC%81%E6%A5%AD50%E7%A4%BE!A1:F1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['展示会名', '企業名', '業種', '出展ページURL', '取得元URL', '年度']] }),
  }, token);
  await api(`${SHEETS_API}/${sheetId}/values/%E9%81%8E%E5%8E%BB%E5%AE%9F%E7%B8%BE%E3%81%A8%E9%81%B8%E5%AE%9A%E7%90%86%E7%94%B1!A1:G1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['展示会名', '選定理由', '類似実績(顧客名)', '実績展示会名', '業種', '案件ID', '実績PDF有無']] }),
  }, token);
  console.log('Headers written');

  // Verify permission
  const perms = await api(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?fields=permissions(id,emailAddress,role,type)`, {}, token);
  const kimPerm = (perms.permissions || []).find(p => p.emailAddress === KIM_EMAIL);
  console.log(`Sheet kim: ${kimPerm?.role || 'NOT FOUND'}`);

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?authuser=${KIM_EMAIL}`;

  // --- Create Doc ---
  console.log('Creating document...');
  const docData = await api('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: DOC_TITLE }),
  }, token);
  const docId = docData.documentId;
  console.log(`Doc ID: ${docId}`);

  // Share with kim
  await api(`https://www.googleapis.com/drive/v3/files/${docId}/permissions?sendNotificationEmail=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: KIM_EMAIL }),
  }, token);

  // Write template content
  let content = `【下書き】展示会ブース新規提案メール（2026-11-17）\n\n`;
  try {
    const tmplPath = 'C:\\Users\\USER\\terminals\\booth-email-template.md';
    if (fs.existsSync(tmplPath)) content = fs.readFileSync(tmplPath, 'utf8');
  } catch {}
  await api(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
  }, token);

  // Verify permissions
  const docPerms = await api(`https://www.googleapis.com/drive/v3/files/${docId}/permissions?fields=permissions(id,emailAddress,role,type)`, {}, token);
  const docKimPerm = (docPerms.permissions || []).find(p => p.emailAddress === KIM_EMAIL);
  console.log(`Doc kim: ${docKimPerm?.role || 'NOT FOUND'}`);

  const docUrl = `https://docs.google.com/document/d/${docId}/edit?authuser=${KIM_EMAIL}`;

  // Save URLs
  const result = { spreadsheetUrl: sheetUrl, documentUrl: docUrl, spreadsheetId: sheetId, documentId: docId };
  fs.writeFileSync('C:\\Users\\USER\\terminals\\deliverables-urls.json', JSON.stringify(result, null, 2));
  console.log(`\nSheet: ${sheetUrl}`);
  console.log(`Doc: ${docUrl}`);
  console.log('Done!');
}

main().catch(e => { console.error(e.message); process.exit(1); });