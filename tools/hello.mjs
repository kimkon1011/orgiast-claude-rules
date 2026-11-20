import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

async function getDirectToken(impersonate) {
  const keyPath = join(homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json');
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64url = (v) => Buffer.from(v).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    sub: impersonate,
    scope: DRIVE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const jwt = header + '.' + claims + '.' + signer.sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Token failed: ' + JSON.stringify(json));
  return json.access_token;
}

async function uploadFile(token, filePath, name) {
  const content = readFileSync(filePath);
  const boundary = 'upload-' + Date.now().toString(36);
  const metadata = JSON.stringify({ name, mimeType: 'text/plain' });
  const body = '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
    content.toString('utf8') + '\r\n' +
    '--' + boundary + '--';
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'multipart/related; boundary=' + boundary,
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Upload failed: ' + JSON.stringify(json));
  return json;
}

async function shareWithKim(token, fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '/permissions?supportsAllDrives=true&sendNotificationEmail=false', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: 'kim@orgiast.jp' }),
  });
  return res.ok ? 'shared' : 'share_failed: ' + (await res.text());
}

async function checkPermissions(token, fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '/permissions?supportsAllDrives=true&fields=permissions(id,emailAddress,role,type)', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  const json = await res.json();
  return json.permissions || [];
}

const filePath = 'C:/Users/user/work-imp270201/followup-20261121.txt';
const name = '270201IMP_追客メール下書き_20261121.txt';

try {
  console.log('Getting token as seisaku-team@orgiast.jp...');
  const token = await getDirectToken('seisaku-team@orgiast.jp');
  console.log('Token OK. Uploading file...');
  const result = await uploadFile(token, filePath, name);
  const url = 'https://drive.google.com/file/d/' + result.id + '/view';
  console.log('Uploaded: id=' + result.id + ' name=' + result.name);
  console.log('URL: ' + url);
  
  console.log('Adding kim@orgiast.jp as writer...');
  const shareResult = await shareWithKim(token, result.id);
  console.log('Share result: ' + shareResult);
  
  console.log('Checking permissions...');
  const perms = await checkPermissions(token, result.id);
  const kimPerm = perms.find(p => p.emailAddress === 'kim@orgiast.jp');
  console.log('Kim permission: ' + JSON.stringify(kimPerm));
  console.log('All permissions: ' + JSON.stringify(perms));
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}  
