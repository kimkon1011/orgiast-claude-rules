const fs = require('fs');
const crypto = require('crypto');

const key = JSON.parse(fs.readFileSync('C:/Users/kimko/.claude/aujust-sheets-reader.json', 'utf8'));

async function getAccessToken() {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: key.client_email,
    sub: 'kim@orgiast.jp',
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: exp,
    iat: iat
  };

  const base64UrlEncode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  
  const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(claimSet)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  const signature = signer.sign(key.private_key, 'base64url');

  const jwt = `${unsignedToken}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token error: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function main() {
  const token = await getAccessToken();
  const spreadsheetId = '1reLACNGD1K7U58heIBVH-YWC9CWErGHSfOy4unfgOYs';
  const range = encodeURIComponent('task!A:H');
  
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Sheets API error: ${JSON.stringify(data)}`);
  }

  const rows = data.values || [];
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
