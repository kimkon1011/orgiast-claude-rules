#!/usr/bin/env node
import { ensureKimEditor } from './lib/kim-editor.mjs';
// 任意のローカルファイルを Drive フォルダへ DWD でアップロードする。
// 使い方: node tools/drive-upload.mjs --file <path> --folder <folderId> [--name <name>] [--as <email>] [--authuser <開く人のメール>]
// Office/CSV は既定で Google Workspace 形式へ変換する。社外から元形式を指定された場合だけ --keep-format を使う。
// 他人宛は --share <相手のメール> を付ける（--share-role で権限指定）。
import { shareAndRecord, shareRecipients } from './lib/drive-share.mjs';
import { workspaceUrl } from './lib/workspace-url.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { getDriveToken, driveApi, defaultDriveKeyPath } from './lib/drive-auth.mjs';

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.zip': 'application/zip', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
};

const GOOGLE_MIME = {
  '.xlsx': 'application/vnd.google-apps.spreadsheet', '.xls': 'application/vnd.google-apps.spreadsheet', '.csv': 'application/vnd.google-apps.spreadsheet',
  '.docx': 'application/vnd.google-apps.document', '.doc': 'application/vnd.google-apps.document',
  '.pptx': 'application/vnd.google-apps.presentation', '.ppt': 'application/vnd.google-apps.presentation',
};

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'keep-format') { out[key] = true; continue; }
    if (!['file', 'folder', 'name', 'as', 'authuser', 'share', 'share-role'].includes(key)) throw new Error(`unknown option: ${arg}`);
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
  return workspaceUrl(`https://drive.google.com/file/d/${id}/view`, as);
}

export function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function uploadPlan(file, requestedName = basename(file), keepFormat = false) {
  const extension = extname(file).toLowerCase();
  const googleMimeType = keepFormat ? undefined : GOOGLE_MIME[extension];
  const name = googleMimeType ? requestedName.slice(0, requestedName.length - extname(requestedName).length) : requestedName;
  return {
    converted: Boolean(googleMimeType),
    sourceMimeType: mimeFor(file),
    metadata: { name, ...(googleMimeType && { mimeType: googleMimeType }) },
  };
}

export function uploadedFileUrl(id, mimeType, as) {
  const base = mimeType === 'application/vnd.google-apps.spreadsheet' ? `https://docs.google.com/spreadsheets/d/${id}/edit`
    : mimeType === 'application/vnd.google-apps.document' ? `https://docs.google.com/document/d/${id}/edit`
      : mimeType === 'application/vnd.google-apps.presentation' ? `https://docs.google.com/presentation/d/${id}/edit`
        : `https://drive.google.com/file/d/${id}/view`;
  return workspaceUrl(base, as);
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

export async function upload({ file, folder, name, as, authuser = as, keyPath, share, 'share-role': shareRole, 'keep-format': keepFormat = false }) {
  workspaceUrl('https://drive.google.com/', authuser);
  if (share) shareRecipients(share, shareRole);
  const content = readFileSync(file);
  const token = await getDriveToken({ impersonate: as, keyPath });
  const boundary = `drive-upload-${Date.now().toString(36)}`;
  const plan = uploadPlan(file, name || basename(file), keepFormat);
  const body = buildMultipartBody({
    metadata: { ...plan.metadata, parents: [folder] },
    content,
    mimeType: plan.sourceMimeType,
    boundary,
  });
  const res = await driveApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const json = await res.json();
  await ensureKimEditor(json.id, { actingUser: as, token, created: true });
  if (share) await shareAndRecord({ fileId: json.id, emails: share, role: shareRole, auth: token, name: json.name });
  return { id: json.id, name: json.name, converted: plan.converted, url: uploadedFileUrl(json.id, plan.metadata.mimeType, authuser), accountInstruction: `${authuser} で開いてください` };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const as = !args.as && !process.env.GOOGLE_IMPERSONATE && !existsSync(process.env.GOOGLE_SA_KEY || defaultDriveKeyPath()) ? 'seisaku-team@orgiast.jp' : resolveAs(args);
    console.log(JSON.stringify(await upload({ ...args, as })));
  } catch (error) {
    console.error(`drive-upload: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) await main();
