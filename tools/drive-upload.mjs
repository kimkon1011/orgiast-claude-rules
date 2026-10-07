#!/usr/bin/env node
// 任意のローカルファイルを Drive フォルダへ DWD でアップロードする。
// 使い方: node tools/drive-upload.mjs --file <path> --folder <folderId> [--name <name>] [--as <email>]
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.zip': 'application/zip', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!['file', 'folder', 'name', 'as'].includes(key)) throw new Error(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    out[key] = value;
    i += 1;
  }
  if (!out.file) throw new Error('--file is required');
  if (!out.folder) throw new Error('--folder is required');
  return out;
}

export function driveViewUrl(id, as) {
  return `https://drive.google.com/file/d/${id}/view${as ? `?authuser=${encodeURIComponent(as)}` : ''}`;
}

export function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function buildMultipartBody({ metadata, content, mimeType, boundary }) {
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  return Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--`)]);
}

export function resolveAs(args, env = process.env, gitEmail = () => execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', windowsHide: true }).trim()) {
  const email = args.as || env.GOOGLE_IMPERSONATE || (() => { try { return gitEmail(); } catch { return ''; } })();
  if (!email) throw new Error('impersonate 先が不明: --as <email> か GOOGLE_IMPERSONATE か git config user.email を設定する');
  return email;
}

export async function upload({ file, folder, name, as }) {
  const content = readFileSync(file);
  const token = await getDriveToken({ impersonate: as });
  const boundary = `drive-upload-${Date.now().toString(36)}`;
  const body = buildMultipartBody({
    metadata: { name: name || basename(file), parents: [folder] },
    content,
    mimeType: mimeFor(file),
    boundary,
  });
  const res = await driveApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const json = await res.json();
  return { id: json.id, name: json.name, url: driveViewUrl(json.id, as) };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const as = resolveAs(args);
    console.log(JSON.stringify(await upload({ ...args, as })));
  } catch (error) {
    console.error(`drive-upload: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) await main();
