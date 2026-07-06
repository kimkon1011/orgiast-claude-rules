#!/usr/bin/env node
// drive-hub-sync.mjs — claude-common-rules Drive ハブとの同期 CLI（依存ゼロ）
//
// 認証: SA aujust-sheets-reader (DWD 設定済み, scope=drive) で kim@orgiast.jp を impersonate
//   key は env GOOGLE_SA_KEY か既定パス（aujust-sales-automation/.gcp/sheets-sa.json）
//
// 使い方:
//   node drive-hub-sync.mjs list [parentId]
//   node drive-hub-sync.mjs push <localPath> <title> [parentId]   # 同名があれば in-place 更新（ID 保持）
//   node drive-hub-sync.mjs pull <title> <localPath> [parentId]   # 同名複数なら modifiedTime 最新
//
// parentId 省略時はハブ直下 (claude-common-rules)

import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HUB = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw'; // claude-common-rules
const IMPERSONATE = 'kim@orgiast.jp';
const KEY_PATH = process.env.GOOGLE_SA_KEY
  ?? join(homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function getToken() {
  const key = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    sub: IMPERSONATE,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`token error: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function api(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

async function findByTitle(token, title, parent) {
  const q = encodeURIComponent(`name='${title.replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false`);
  const res = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`);
  return (await res.json()).files ?? [];
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
const parent = a3 ?? (cmd === 'list' ? (a1 ?? HUB) : HUB);
const token = await getToken();

if (cmd === 'list') {
  const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
  const res = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=name`);
  for (const f of (await res.json()).files ?? []) console.log(`${f.id}\t${f.mimeType.includes('folder') ? '[dir]' : '     '}\t${f.modifiedTime}\t${f.name}`);
} else if (cmd === 'push') {
  const content = readFileSync(a1);
  const existing = await findByTitle(token, a2, parent);
  if (existing.length > 0) {
    await api(token, `https://www.googleapis.com/upload/drive/v3/files/${existing[0].id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content,
    });
    console.log(`updated (id kept): ${a2} ${existing[0].id}${existing.length > 1 ? ` (WARN: ${existing.length} 個の同名あり、最新を更新)` : ''}`);
  } else {
    const meta = JSON.stringify({ name: a2, parents: [parent], mimeType: 'text/plain' });
    const boundary = 'x-claude-hub-sync';
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${content.toString('utf8')}\r\n--${boundary}--`;
    const res = await api(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    console.log(`created: ${a2} ${(await res.json()).id}`);
  }
} else if (cmd === 'pull') {
  const files = await findByTitle(token, a1, parent);
  if (files.length === 0) { console.error(`not found: ${a1}`); process.exit(1); }
  const res = await api(token, `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`);
  writeFileSync(a2, Buffer.from(await res.arrayBuffer()));
  console.log(`pulled: ${a1} (${files[0].modifiedTime}) -> ${a2}`);
} else if (cmd === 'share-domain') {
  // share-domain <fileOrFolderId> <reader|writer>
  const res = await api(token, `https://www.googleapis.com/drive/v3/files/${a1}/permissions?fields=id,role,type,domain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'domain', domain: 'orgiast.jp', role: a2 ?? 'reader', allowFileDiscovery: true }),
  });
  console.log(`shared: ${JSON.stringify(await res.json())}`);
} else {
  console.error('usage: drive-hub-sync.mjs list [parentId] | push <local> <title> [parentId] | pull <title> <local> [parentId] | share-domain <id> <reader|writer>');
  process.exit(1);
}
