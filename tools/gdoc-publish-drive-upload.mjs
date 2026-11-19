#!/usr/bin/env node
/**
 * gdoc-publish の Drive アップロード直接版。
 * この PC (cheap-code-worker) には SA 鍵が無く、GWS proxy が docs.googleapis.com を
 * サポートしていないため、Drive multipart upload に直接フォールバックする。
 *
 * 使い方: node tools/gdoc-publish-drive-upload.mjs --title "タイトル" --file 本文.md --authuser <mail> [--share <mail> [--share-role writer]]
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { shareAndRecord } from './lib/drive-share.mjs';
import { ensureKimEditor } from './lib/kim-editor.mjs';
import { workspaceUrl } from './lib/workspace-url.mjs';
import { isEntry } from './is-entry.mjs';
import { renderDocument, containsSecret } from './gdoc-publish.mjs';

export const DEFAULT_FOLDER = '1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (!['--title', '--file', '--folder', '--authuser', '--share', '--share-role'].includes(flag) ||
        !val?.trim() || val.startsWith('--') || flag.slice(2) in args) {
      throw new Error(`不正な引数: ${flag}`);
    }
    args[flag.slice(2)] = val;
    i++;
  }
  if (!args.title || !args.file) throw new Error('--title と --file は必須です');
  if (!args.authuser) throw new Error('--authuser は必須です');
  return args;
}

function renderHtml(rendered) {
  const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  let html = '', cursor = 0;
  for (const link of rendered.links) {
    html += escape(rendered.text.slice(cursor, link.startIndex - 1));
    html += `<a href="${escape(link.url)}">${escape(rendered.text.slice(link.startIndex - 1, link.endIndex - 1))}</a>`;
    cursor = link.endIndex - 1;
  }
  html += escape(rendered.text.slice(cursor));
  return `<!doctype html><html><head><meta charset="UTF-8"></head><body><pre>${html}</pre></body></html>`;
}

export async function main(argv = process.argv.slice(2)) {
  const { stdout = console.log, stderr = console.error } = console;
  try {
    const args = parseArgs(argv);
    const source = readFileSync(args.file, 'utf8');
    if (containsSecret(source)) throw new Error('秘密らしい行を含みます');
    workspaceUrl('https://docs.google.com/', args.authuser);
    const rendered = renderDocument(source);
    const html = renderHtml(rendered);

    // GWS_USER (seisaku-team@orgiast.jp) で認証
    const token = await getDriveToken({ impersonate: 'seisaku-team@orgiast.jp' });

    // Drive multipart upload で Google Doc を作成
    const boundary = `gdoc-${randomUUID()}`;
    const metadata = { name: args.title, mimeType: 'application/vnd.google-apps.document', appProperties: { orgiastAutomation: 'true' }, parents: [args.folder ?? DEFAULT_FOLDER] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--\r\n`;

    const created = await (await driveApi(token, `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })).json();

    const id = created.id;
    if (!id) throw new Error('作成レスポンスに id がありません');

    // kim@orgiast.jp に編集権限を付与（ensureKimEditor）
    await ensureKimEditor(id, { actingUser: 'kim@orgiast.jp', token, api: driveApi, created: true });

    // --share があれば共有
    const share = args.share;
    const shareRole = args['share-role'] ?? 'writer';
    if (share) {
      await shareAndRecord({ fileId: id, emails: share, role: shareRole, auth: token, name: args.title });
    }

    // 読み戻し検証（Drive export）
    const after = await (await driveApi(token, `${DRIVE}/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`)).text();
    const normalize = text => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (normalize(after) !== normalize(rendered.text)) {
      stderr('read-back: 本文が一致しません');
      return 1;
    }

    const url = workspaceUrl(`https://docs.google.com/document/d/${id}/edit`, args.authuser);
    stderr(`read-back: 本文一致（Drive export）/ HTML リンク ${rendered.links.length} 件`);
    stdout(`${args.authuser} で開いてください: ${url}`);
    return 0;
  } catch (error) {
    stderr(`gdoc-publish-drive-upload: ${error.message}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();