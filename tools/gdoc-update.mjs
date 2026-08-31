#!/usr/bin/env node
/**
 * gdoc-update.mjs — 既存の Google Doc の「中身だけ」を差し替える（URL は変わらない）。
 *
 * なぜ要るか: Claude の Drive MCP は create_file（新規作成）と update_file（タイトル/移動のみ）しか
 * 持たないため、既存 Doc の本文を更新できない。その結果「新しい Doc を作って URL を貼り直してもらう」
 * という user 手作業が毎回発生していた。これを消すためのツール。
 *
 * 方式: サービスアカウント + ドメイン全体の委任(DWD)で kim@orgiast.jp を代理し、
 *       Drive v3 files.update に Markdown を media アップロード → Google Doc に変換して上書き。
 *       依存パッケージなし（Node 18+ の fetch と標準 crypto で JWT を自己署名）。
 *
 * 使い方:
 *   node <このファイル> --id <docId> --file <本文.md>
 *   node <このファイル> --id <docId> --file <本文.md> --dry     # 認証と権限だけ確認して書き込まない
 *   node <このファイル> --id <docId> --check                    # 現在の本文の先頭を表示（読み取りのみ）
 *
 * オプション:
 *   --key <path>      サービスアカウント JSON（既定: 下記 DEFAULT_KEY）
 *   --subject <mail>  代理するユーザー（既定: kim@orgiast.jp）
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_KEY =
  'C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json';
const DEFAULT_SUBJECT = 'kim@orgiast.jp';
const SCOPE = 'https://www.googleapis.com/auth/drive';

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry' || a === '--check') out.flags.add(a.slice(2));
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** サービスアカウント鍵で JWT を自己署名し、アクセストークンに交換する（DWD: sub でユーザーを代理）。 */
async function getAccessToken(key, subject) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email,
    sub: subject,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  const assertion = `${unsigned}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint =
      body.error === 'unauthorized_client'
        ? '\n→ このサービスアカウントの client_id が Google Admin の「ドメイン全体の委任」に未登録か、' +
          ' スコープ https://www.googleapis.com/auth/drive が許可されていません。' +
          `\n   登録する client_id: ${key.client_id}`
        : '';
    throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(body)}${hint}`);
  }
  return body.access_token;
}

async function api(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${url.split('?')[0]} → ${res.status} ${await res.text()}`);
  }
  return res;
}

const args = parseArgs(process.argv.slice(2));
const docId = args.id;
if (!docId) {
  console.error('--id <docId> は必須です。使い方はファイル先頭のコメントを参照。');
  process.exit(2);
}

const keyPath = args.key || DEFAULT_KEY;
if (!fs.existsSync(keyPath)) {
  console.error(`サービスアカウント鍵が見つかりません: ${keyPath}`);
  process.exit(2);
}
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const subject = args.subject || DEFAULT_SUBJECT;

const token = await getAccessToken(key, subject);
console.log(`auth OK (sa=${key.client_email} → ${subject})`);

// 事前確認: 対象が Google Doc で、編集権限があるか
const metaRes = await api(
  token,
  `https://www.googleapis.com/drive/v3/files/${docId}?fields=id,name,mimeType,capabilities/canEdit`,
);
const meta = await metaRes.json();
console.log(`target: ${meta.name} (${meta.mimeType}) canEdit=${meta.capabilities?.canEdit}`);

if (meta.mimeType !== 'application/vnd.google-apps.document') {
  console.error('対象が Google ドキュメントではありません。中断します。');
  process.exit(1);
}
if (!meta.capabilities?.canEdit) {
  console.error('この Doc への編集権限がありません。中断します。');
  process.exit(1);
}

if (args.flags.has('check')) {
  const txt = await (
    await api(token, `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`)
  ).text();
  console.log('--- 現在の本文（先頭600字） ---');
  console.log(txt.slice(0, 600));
  process.exit(0);
}

if (args.flags.has('dry')) {
  console.log('dry: 認証・対象・権限すべてOK。書き込みはしていません。');
  process.exit(0);
}

if (!args.file) {
  console.error('--file <本文.md> は必須です（--check / --dry を除く）。');
  process.exit(2);
}
const md = fs.readFileSync(path.resolve(args.file), 'utf8');

await api(
  token,
  `https://www.googleapis.com/upload/drive/v3/files/${docId}?uploadType=media`,
  { method: 'PATCH', headers: { 'Content-Type': 'text/markdown' }, body: md },
);

// read-back verify: 実際に反映されたか本文を取り直して確認する
const after = await (
  await api(token, `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`)
).text();
const firstLine = md.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() || '';
const ok = firstLine ? after.includes(firstLine.slice(0, 30)) : after.length > 0;

console.log(`updated: ${meta.name}`);
console.log(`read-back: ${after.length} 字 / 先頭行の一致 = ${ok ? 'OK' : 'NG'}`);
console.log(`https://docs.google.com/a/orgiast.jp/document/d/${docId}/edit`);
if (!ok) process.exit(1);
