const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const key = require('C:/Users/kimko/.claude/aujust-sheets-reader.json');

async function main() {
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    subject: 'kim@orgiast.jp',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: '1reLACNGD1K7U58heIBVH-YWC9CWErGHSfOy4unfgOYs',
    range: 'task!A:H',
  });

  const rows = res.data.values || [];
  console.log('TOTAL_ROWS_RETRIEVED:', rows.length);

  const phoneRows = [];
  rows.forEach((row, idx) => {
    const rowNum = idx + 1;
    const colD = row[3] || '';
    if (colD.includes('スマホ')) {
      phoneRows.push({
        rowNum,
        colD,
        colE: row[4] || '',
        colHSnippet: (row[7] || '').substring(0, 80)
      });
    }
  });

  console.log('PHONE_RELATED_COUNT:', phoneRows.length);
  console.log('--- PHONE RELATED ROWS ---');
  phoneRows.forEach(r => {
    console.log(`Row ${r.rowNum}: D=${JSON.stringify(r.colD)} | E=${JSON.stringify(r.colE)} | H=${JSON.stringify(r.colHSnippet)}`);
  });

  console.log('--- SPECIFIC ROWS 297 & 306 ---');
  [297, 306].forEach(num => {
    const r = rows[num - 1] || [];
    console.log(`Row ${num} (Full A-H):`, JSON.stringify(r));
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
