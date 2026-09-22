#!/usr/bin/env node
/**
 * gdoc-create.mjs — Markdown から新規 Google Doc を作成する。
 *
 * なぜ要るか: gdoc-update.mjs は既存 Doc の本文差し替え専用で、新規作成できない。
 * 作成と URL の取得も自動化し、同名 Doc の再利用で再実行時の重複を防ぐ。
 *
 * 方式: サービスアカウント + ドメイン全体の委任(DWD)で kim@orgiast.jp を代理し、
 *       Drive v3 files.create に Markdown を multipart アップロードして Google Doc に変換。
 *       依存パッケージなし（Node 18+ の fetch と標準 crypto で JWT を自己署名）。
 *
 * 使い方:
 *   node tools/gdoc-create.mjs --file <本文.md> [--title <タイトル>] [--parent <フォルダID>]
 *   node tools/gdoc-create.mjs --file <本文.md> --dry       # 認証と権限だけ確認して作成しない
 *   node tools/gdoc-create.mjs --file <本文.md> --force-new # 同名 Doc があっても新規作成
 *
 * オプション:
 *   --key <path>      サービスアカウント JSON（既定: 下記 DEFAULT_KEY）
 *   --subject <mail>  代理するユーザー（既定: kim@orgiast.jp）
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const DEFAULT_KEY =
  'C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json';
const DEFAULT_SUBJECT = 'kim@orgiast.jp';
const SCOPE = 'https://www.googleapis.com/auth/drive';

export function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry' || a === '--check' || a === '--force-new') out.flags.add(a.slice(2));
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

export function deriveTitle(markdown, filePath) {
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#[ \t]+(.+)$/);
    if (heading?.[1].trim()) return heading[1].trim();
  }
  const filename = path.basename(filePath.replace(/\\/g, '/'));
  return filename.slice(0, filename.length - path.extname(filename).length);
}

export function buildSearchQuery(title, parentId) {
  const escape = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  let query = `name = '${escape(title)}' and mimeType = 'application/vnd.google-apps.document' and trashed = false`;
  if (parentId) query += ` and '${escape(parentId)}' in parents`;
  return query;
}

export function buildMultipartBody({ metadata, media, boundary }) {
  return Buffer.from(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${media}\r\n--${boundary}--\r\n`,
    'utf8',
  );
}

export function docUrl(id) {
  return `https://docs.google.com/a/orgiast.jp/document/d/${id}/edit`;
}

export function checkReadBack(markdown, exportedText) {
  const firstLine = markdown.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() || '';
  return firstLine ? exportedText.includes(firstLine.slice(0, 30)) : exportedText.length > 0;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('--file <本文.md> は必須です。使い方はファイル先頭のコメントを参照。');
    return 2;
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`本文ファイルが見つかりません: ${filePath}`);
    return 2;
  }
  const md = fs.readFileSync(filePath, 'utf8');
  const title = args.title || deriveTitle(md, filePath);
  const keyPath = args.key || DEFAULT_KEY;
  if (!fs.existsSync(keyPath)) {
    console.error(`サービスアカウント鍵が見つかりません: ${keyPath}`);
    return 2;
  }
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const subject = args.subject || DEFAULT_SUBJECT;
  const token = await getAccessToken(key, subject);
  console.log(`auth OK (sa=${key.client_email} → ${subject})`);

  // 認証成功だけでは作成可能とは限らないため、dry でも作成先の追加権限まで確認する。
  const parent = await (await api(token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.parent || 'root')}?fields=id,name,mimeType,capabilities/canAddChildren`,
  )).json();
  if (parent.mimeType !== 'application/vnd.google-apps.folder' || !parent.capabilities?.canAddChildren) {
    console.error('作成先がフォルダではないか、ファイルを追加する権限がありません。中断します。');
    return 1;
  }
  if (args.flags.has('dry')) {
    console.log('dry: 認証・権限すべてOK。作成はしていません。');
    return 0;
  }

  let doc;
  if (!args.flags.has('force-new')) {
    const query = new URLSearchParams({
      q: buildSearchQuery(title, args.parent),
      fields: 'files(id,name,webViewLink)',
    });
    const found = await (await api(token, `https://www.googleapis.com/drive/v3/files?${query}`)).json();
    doc = found.files?.[0];
  }
  const reused = Boolean(doc);
  if (!doc) {
    const metadata = { name: title, mimeType: 'application/vnd.google-apps.document' };
    if (args.parent) metadata.parents = [args.parent];
    const boundary = `gdoc_${crypto.randomBytes(24).toString('hex')}`;
    doc = await (await api(token,
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: buildMultipartBody({ metadata, media: md, boundary }),
      },
    )).json();
  }

  // 作成レスポンスだけで成功とせず、再利用時も実際の本文を取り直して確認する。
  const after = await (await api(token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export?mimeType=text/plain`,
  )).text();
  const ok = checkReadBack(md, after);
  if (reused) console.log('reused existing');
  console.log(`${reused ? 'reused' : 'created'}: ${doc.name}`);
  console.log(`read-back: ${after.length} 字 / 先頭行の一致 = ${ok ? 'OK' : 'NG'}`);
  console.log(docUrl(doc.id));
  return ok ? 0 : 1;
}

if (isEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
