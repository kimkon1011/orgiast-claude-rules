#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listMessages, downloadAttachment } from './beeper-api.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

export const SINCE = new Date('2026-11-24T00:00:00Z');
export const DRIVE_FOLDER_ID = '1VLg37o0IEw2mhhQi_7f1JblNFsUGLqBi';
export const CHATS = new Map([
  ['307', 'furukawa'], ['1125', 'momose'], ['1050', 'momose'], ['548', 'sawada'],
]);
const ALLOWED_EMAILS = new Set(['kim@orgiast.jp', 'nishi@orgiast.jp']);

const homePath = (...parts) => path.join(os.homedir(), ...parts);
export const DEFAULT_STATE = homePath('.claude', 'state', 'roudou-evidence-collect.json');
export const DEFAULT_OUTPUT = homePath('gb-reports', 'roudou-replies-1124', 'signed');
export const DEFAULT_LOG_DIR = homePath('gb-reports', 'roudou-evidence-collect');

function attachmentsOf(message) {
  const values = [...(message.attachments || [])];
  if (message.attachment) values.push(message.attachment);
  return values;
}

function mimeOf(attachment) {
  return String(attachment.mimeType || attachment.content_type || attachment.type || '').toLowerCase();
}

function extensionOf(attachment) {
  const mime = mimeOf(attachment);
  const named = String(attachment.fileName || attachment.name || attachment.filename || '').match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (named) return named.toLowerCase() === 'jpeg' ? 'jpg' : named.toLowerCase();
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' })[mime] || (mime.startsWith('image/') ? mime.slice(6) : 'bin');
}

function isEvidence(message, attachment) {
  const mime = mimeOf(attachment);
  const type = String(message.type || attachment.type || '').toUpperCase();
  return type === 'IMAGE' || mime.startsWith('image/') || mime === 'application/pdf' || extensionOf(attachment) === 'pdf';
}

function jstStamp(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => parts.find(item => item.type === type)?.value;
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}`;
}

function safeId(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, '_'); }

function readState(statePath) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
    return { processedMessageIDs: [...new Set(value.processedMessageIDs || [])] };
  } catch { return { processedMessageIDs: [] }; }
}

function multipartBody(metadata, content, mime) {
  const boundary = `roudou-${Date.now().toString(16)}`;
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]),
  };
}

export async function uploadAndLockDown({ token, name, content, mime, drive = driveApi }) {
  const multipart = multipartBody({ name, parents: [DRIVE_FOLDER_ID] }, content, mime);
  const uploaded = await drive(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${multipart.boundary}` }, body: multipart.body,
  });
  const file = await uploaded.json();
  const permissionsUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions?fields=permissions(id,type,domain,emailAddress,role)&supportsAllDrives=true`;
  const initial = await (await drive(token, permissionsUrl)).json();
  for (const permission of initial.permissions || []) {
    if (permission.type === 'domain' || permission.type === 'anyone') {
      await drive(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions/${encodeURIComponent(permission.id)}?supportsAllDrives=true`, { method: 'DELETE' });
    }
  }
  const verified = (await (await drive(token, permissionsUrl)).json()).permissions || [];
  const unexpected = verified.filter(permission => permission.type !== 'user' || !ALLOWED_EMAILS.has(String(permission.emailAddress).toLowerCase()));
  if (unexpected.length || !verified.some(permission => String(permission.emailAddress).toLowerCase() === 'kim@orgiast.jp') || !verified.some(permission => String(permission.emailAddress).toLowerCase() === 'nishi@orgiast.jp')) {
    throw new Error(`Drive共有範囲の検証失敗: ${JSON.stringify(verified.map(({ type, emailAddress, role }) => ({ type, emailAddress, role })))}`);
  }
  return { id: file.id, permissions: verified };
}

export async function collectEvidence({
  dryRun = false, statePath = DEFAULT_STATE, outputDir = DEFAULT_OUTPUT, logDir = DEFAULT_LOG_DIR,
  list = listMessages, download = downloadAttachment, tokenProvider = getDriveToken, drive = driveApi,
  notify = true, now = new Date(), stdout = console.log,
} = {}) {
  const state = readState(statePath);
  const processed = new Set(state.processedMessageIDs.map(String));
  const candidates = [];
  let scanned = 0, excluded = 0;
  for (const [chatID, person] of CHATS) {
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await list(chatID, { limit: 200, direction: 'before', ...(cursor ? { cursor } : {}) });
      const messages = result.items || [];
      scanned += messages.length;
      for (const message of messages) {
        const timestamp = new Date(message.timestamp);
        if (message.isSender || Number.isNaN(timestamp.valueOf()) || timestamp < SINCE || processed.has(String(message.id))) { excluded++; continue; }
        const attachments = attachmentsOf(message).filter(attachment => isEvidence(message, attachment));
        if (!attachments.length) { excluded++; continue; }
        attachments.forEach((attachment, index) => {
          const suffix = attachments.length > 1 ? `-${index + 1}` : '';
          const name = `${person}-${chatID}-${safeId(message.id)}${suffix}-${jstStamp(timestamp)}.${extensionOf(attachment)}`;
          candidates.push({ chatID, messageID: String(message.id), attachment, name, mime: mimeOf(attachment) || 'application/octet-stream' });
        });
      }
      if (!result.hasMore || !result.oldestCursor || messages.some(message => new Date(message.timestamp) < SINCE)) break;
      cursor = result.oldestCursor;
    }
  }
  stdout(`dryRun=${dryRun} scanned=${scanned} candidates=${candidates.length} excluded=${excluded}`);
  candidates.forEach(item => stdout(`candidate ${item.name}`));
  if (dryRun) return { dryRun, scanned, excluded, candidates, uploaded: [] };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const token = candidates.length ? await tokenProvider() : null;
  const uploaded = [];
  const completedMessages = new Set();
  for (const item of candidates) {
    const content = await download(item.attachment);
    if (!content?.length) throw new Error(`空の添付: ${item.name}`);
    fs.writeFileSync(path.join(outputDir, item.name), content);
    const result = await uploadAndLockDown({ token, name: item.name, content, mime: item.mime, drive });
    uploaded.push({ name: item.name, driveId: result.id });
    completedMessages.add(item.messageID);
    stdout(`uploaded ${item.name} DriveID=${result.id}`);
  }
  if (completedMessages.size) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ processedMessageIDs: [...new Set([...processed, ...completedMessages])].sort(), updatedAt: now.toISOString() }, null, 2)}\n`);
  }
  const logPath = path.join(logDir, `run-${jstStamp(now)}.log`);
  const log = [`new=${uploaded.length}`, ...uploaded.map(item => `${item.name}\t${item.driveId}`), ''].join('\n');
  fs.writeFileSync(logPath, log);
  if (uploaded.length && notify) {
    const bodyPath = path.join(logDir, `inbox-${jstStamp(now)}.md`);
    fs.writeFileSync(bodyPath, `労働審判の証拠画像を${uploaded.length}件回収し、指定Driveへ保存しました。\n${uploaded.map(item => `- ${item.name} / Drive ID: ${item.driveId}`).join('\n')}\n`);
    const kimInbox = fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [kimInbox, '--add', '--kind', 'info', '--summary', `労働審判の証拠画像 ${uploaded.length}件回収`, '--body-file', bodyPath], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`kim-inbox登録失敗: ${(result.stderr || result.stdout).trim()}`);
  }
  return { dryRun, scanned, excluded, candidates, uploaded, logPath };
}

if (isEntry(import.meta.url)) {
  collectEvidence({ dryRun: process.argv.includes('--dry-run') }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
