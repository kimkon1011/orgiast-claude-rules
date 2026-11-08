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
 * --authuser <開く人のメール> を指定。他人宛は --share <相手のメール> を付ける（--share-role で権限指定）。
 * 使い方:
 *   node tools/gdoc-create.mjs --file <本文.md> [--title <タイトル>] [--parent <フォルダID>]
 *   node tools/gdoc-create.mjs --file <本文.md> --dry       # 認証と権限だけ確認して作成しない
 *   node tools/gdoc-create.mjs --file <本文.md> --force-new # 同名 Doc があっても新規作成
 *
 * オプション:
 *   --key <path>      サービスアカウント JSON（既定: 下記 DEFAULT_KEY）
 *   --subject <mail>  代理するユーザー（既定: kim@orgiast.jp）
 */

import { getDriveToken } from './lib/drive-auth.mjs';
import { shareAndRecord, shareRecipients } from './lib/drive-share.mjs';
import { workspaceUrl } from './lib/workspace-url.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { defaultDriveKeyPath } from './lib/drive-auth.mjs';

// 既定パスはハードコードしない（旧既定値はディレクトリ名の打ち間違いで鍵を見失っていた。2026-10-23 実測）。
const DEFAULT_KEY = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
const DEFAULT_SUBJECT = 'kim@orgiast.jp';

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

export function docUrl(id, authuser) {
  return workspaceUrl(`https://docs.google.com/document/d/${id}/edit`, authuser);
}

export function checkReadBack(markdown, exportedText) {
  const firstLine = markdown.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() || '';
  return firstLine ? exportedText.includes(firstLine.slice(0, 30)) : exportedText.length > 0;
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
  if (args.share) shareRecipients(args.share, args['share-role']);
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
  const authuser = args.authuser || args.subject || process.env.GOOGLE_IMPERSONATE;
  const token = await getDriveToken({ keyPath, impersonate: subject });
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

  docUrl('validate', authuser);
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

  if (args.share) await shareAndRecord({ fileId: doc.id, emails: args.share, role: args['share-role'], auth: token, name: doc.name });

  // 作成レスポンスだけで成功とせず、再利用時も実際の本文を取り直して確認する。
  const after = await (await api(token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export?mimeType=text/plain`,
  )).text();
  const ok = checkReadBack(md, after);
  if (reused) console.log('reused existing');
  console.log(`${reused ? 'reused' : 'created'}: ${doc.name}`);
  console.log(`read-back: ${after.length} 字 / 先頭行の一致 = ${ok ? 'OK' : 'NG'}`);
  console.log(`${authuser} で開いてください: ${docUrl(doc.id, authuser)}`);
  return ok ? 0 : 1;
}

if (isEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
