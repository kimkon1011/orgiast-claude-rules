// Try to read the result file via the service account JWT
import fs from 'node:fs';
import os from 'node:os';
import { createSign } from 'node:crypto';

const HOME = os.homedir();
const saPath = HOME + '/.claude/keys/aujust-sheets-reader.json';
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));

// Create JWT for service account
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly',
  aud: 'https://oauth2.googleapis.com/token',
  exp: now + 3600,
  iat: now
};
const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
const signingInput = header + '.' + payloadB64;

// Sign with private key
const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
const jwt = signingInput + '.' + signature;

// Exchange JWT for access token
async function main() {
  const tokR = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  })).json();

  if (tokR.error) {
    console.log('SA token error:', tokR.error, tokR.error_description);
    return;
  }

  const TOK = tokR.access_token;
  console.log('Got SA token (expires in ' + tokR.expires_in + 's)');
  console.log('Scope:', tokR.scope);
  const H = { Authorization: 'Bearer ' + TOK };

  // Try to read the C4 booth-cmd result files
  const fileIds = [
    '1Lf1UxwmHiowo5jUiydr7ljvZ-CzvYxZF',
    '1zoYxNU4med2Av87s8AX2wz0GZLGxXVPz'
  ];

  // First try to list files in the parent folder
  console.log('\n--- Listing parent folder ---');
  const listR = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'1W9uuMTPO_rduhD3l2a7eLxuU0bngRjPz' in parents and name contains 'result_' and trashed = false") + '&fields=files(id,name,owners)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=5', { headers: H });
  console.log('List status:', listR.status);
  const listData = await listR.json();
  if (listData.files) {
    for (const f of listData.files) {
      console.log('  ' + f.name + ' [' + f.id + '] owner=' + (f.owners?.[0]?.emailAddress || '?'));
    }
  } else {
    console.log('  Error:', JSON.stringify(listData).slice(0, 300));
  }

  for (const fileId of fileIds) {
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', { headers: H });
    if (r.ok) {
      const text = await r.text();
      console.log('\n=== Read ' + fileId + ' ===');
      console.log(text.slice(0, 3000));
    } else {
      const errText = await r.text();
      console.log('\n=== ' + fileId + ': ' + r.status + ' ===');
      console.log(errText.slice(0, 500));
    }
  }
}
main().catch(e => console.error('ERROR:', e.message, e.stack?.slice(0, 500)));