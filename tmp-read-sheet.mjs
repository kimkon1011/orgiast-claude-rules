import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import process from 'process';

const SPREADSHEET_ID = '1Uy6FkVkWBstqzvImHZVur-ZltRJJHzalS7pQgfp7lk8';
const RANGE = "'管理画面（正式）※シート名変更禁止'!O2";

async function main() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE,
  });
  const value = res.data.values?.[0]?.[0] ?? '(empty)';
  console.log('O2 value:', JSON.stringify(value));
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
