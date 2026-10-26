#!/usr/bin/env node
// DWD で Gmail の添付を読み取り専用取得する。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const USAGE = '使い方: node tools/gmail-attachment.mjs --user <address> --message <id> (--attachment <id>|--filename <name>) --out <path>';

function argumentError(message) {
  return new Error(`${message}\n${USAGE}`);
}

export function parseArgs(argv) {
  const values = {};
  const allowed = new Set(['user', 'message', 'attachment', 'filename', 'out']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') || !allowed.has(arg.slice(2))) throw argumentError(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw argumentError(`missing value for ${arg}`);
    values[arg.slice(2)] = value;
    i += 1;
  }
  for (const key of ['user', 'message', 'out']) {
    if (!values[key]) throw argumentError(`--${key} is required`);
  }
  if (Boolean(values.attachment) === Boolean(values.filename)) {
    throw argumentError('specify exactly one of --attachment or --filename');
  }
  return values;
}

export function decodeBase64Url(data) {
  if (typeof data !== 'string') throw new Error('attachment data is missing');
  return Buffer.from(data, 'base64url');
}

export function findAttachmentPart(payload, filename) {
  const needle = String(filename).toLowerCase();
  const matches = [];
  const walk = (part) => {
    if (!part) return;
    if (String(part.filename || '').toLowerCase().includes(needle) && part.body?.attachmentId) matches.push(part);
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  if (matches.length === 0) throw new Error(`attachment filename not found: ${filename}`);
  if (matches.length > 1) throw new Error(`attachment filename is ambiguous: ${filename} (${matches.length} matches)`);
  return matches[0];
}

async function gmailJson(token, path, fetchImpl) {
  const response = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

export async function downloadAttachment(args, { fetchImpl = globalThis.fetch, getToken = getDriveToken } = {}) {
  const token = await getToken({ scope: SCOPE, impersonate: args.user });
  let attachmentId = args.attachment;
  if (!attachmentId) {
    const message = await gmailJson(token, `/messages/${encodeURIComponent(args.message)}?format=full`, fetchImpl);
    attachmentId = findAttachmentPart(message.payload, args.filename).body.attachmentId;
  }
  const attachment = await gmailJson(
    token,
    `/messages/${encodeURIComponent(args.message)}/attachments/${encodeURIComponent(attachmentId)}`,
    fetchImpl,
  );
  const content = decodeBase64Url(attachment.data);
  const output = resolve(args.out);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
  return { path: output, bytes: content.length, header: content.subarray(0, 4).toString('ascii') };
}

async function main() {
  const result = await downloadAttachment(parseArgs(process.argv.slice(2)));
  console.log(`saved: ${result.path} (${result.bytes} bytes, header=${result.header})`);
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(`gmail-attachment: ${error.message}`); process.exitCode = 1; });
}
