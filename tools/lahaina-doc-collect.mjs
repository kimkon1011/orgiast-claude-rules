#!/usr/bin/env node
// ラハイナ案件の「届いた書類」を自動で回収する。
// 使い方: node tools/lahaina-doc-collect.mjs [--dry-run] [--days 30] [--folder <DriveフォルダID>]
//
// やること:
//   1. DWD で seisaku-team@ / kim@ の Gmail を検索し、伊藤氏(ito@k-ikou.co.jp)からの添付と、
//      「許可証・承継・契約書・立替・経営陣」を含む件名の添付を拾う。
//   2. まだ保存していない添付だけをダウンロードし、Drive「ラハイナ_オートパイロット」へ上げる。
//   3. 保存済みの記録を state に残す（同じ添付を二度上げない）。
//   4. 結果を JSON で出す: 受領があったか / 何を保存したか / 失敗理由。
//
// kim がメールを送った後は、この1本を回せば第3章の「受領済み」判定まで機械で揃う。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upload } from './drive-upload.mjs';
import { searchGmail } from './gmail-search.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

export const DEFAULT_FOLDER = '1hHghdGRWIDXadzvrXkYA0WhM2x3UFYSW'; // ラハイナ_オートパイロット
export const USERS = ['seisaku-team@orgiast.jp', 'kim@orgiast.jp'];
// 取り込む相手。件名のキーワードで拾うと「立替」等が他案件に当たって
// 無関係な写真を Drive に入れてしまう（2026-10-22 実測: 金社長立替分の経費申請の JPG 5枚）。
// 送信元で絞るのが唯一安全。
export const SENDERS = ['ito@k-ikou.co.jp', 'k-ikou.co.jp'];
const STATE = join(tmpdir(), 'lahaina-doc-collect-state.json');
const DL_DIR = join(tmpdir(), 'lahaina-doc-collect');
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// 添付の保存キー。メッセージID + 添付ID で一意（Gmail の添付IDは不変）。
export function attachmentKey({ messageId, attachmentId }) {
  return `${messageId}:${attachmentId}`;
}

// Drive に上げるときの名前。日本語ファイル名はそのまま、無い場合だけ採番する。
export function driveName(filename, index = 1) {
  const base = String(filename || '').trim();
  if (base) return base;
  return `attachment-${index}.bin`;
}

// 保存対象の判定: 送信元が伊藤氏（k-ikou.co.jp）の添付だけ。
export function shouldCollect({ from = '' }, senders = SENDERS) {
  const value = String(from).toLowerCase();
  return senders.some((sender) => value.includes(sender.toLowerCase()));
}

// メールの payload から添付パートを取り出す（filename と attachmentId を持つものだけ）。
export function attachmentParts(payload, found = []) {
  if (!payload) return found;
  const id = payload.body?.attachmentId;
  if (id && payload.filename) {
    found.push({ attachmentId: id, filename: payload.filename, mimeType: payload.mimeType || 'application/octet-stream', size: payload.body?.size || 0 });
  }
  for (const child of payload.parts || []) attachmentParts(child, found);
  return found;
}

export function loadState(stateFile = STATE) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { saved: {} };
  } catch {
    return { saved: {} };
  }
}

export function saveState(state, stateFile = STATE) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// fetchImpl を必ず引き回す。ここで globalThis.fetch に落ちると、
// collectForUser に渡した差し替え（テスト・プロキシ・リトライ）が
// 本文と添付の取得だけ素通りする＝無音で別経路を叩く。
async function gmailGet(token, path, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function collectForUser({ user, days, folder, state, dryRun, fetchImpl = globalThis.fetch, getToken = getDriveToken, uploadImpl = upload }) {
  const query = `newer_than:${days}d has:attachment`;
  const { messages } = await searchGmail({ user, query, max: 40, withBody: false, fetchImpl, getToken });
  const saved = [];
  const seen = [];
  for (const message of messages) {
    const subject = message.subject || '';
    const from = message.from || '';
    if (!shouldCollect({ from, subject })) continue;
    seen.push({ id: message.id, from, subject, date: message.date });
    const token = await getToken({ scope: SCOPE, impersonate: user });
    const full = await gmailGet(token, `/messages/${message.id}?format=full`, fetchImpl);
    for (const [index, part] of attachmentParts(full.payload).entries()) {
      const key = attachmentKey({ messageId: message.id, attachmentId: part.attachmentId });
      if (state.saved[key]) continue;
      const record = { key, messageId: message.id, filename: part.filename, mimeType: part.mimeType, subject, user };
      if (dryRun) {
        saved.push({ ...record, dryRun: true });
        continue;
      }
      try {
        const blob = await gmailGet(token, `/messages/${message.id}/attachments/${part.attachmentId}`, fetchImpl);
        mkdirSync(DL_DIR, { recursive: true });
        const local = join(DL_DIR, `${message.id}-${index}-${part.filename.replace(/[\\/:*?"<>|]/g, '_')}`);
        writeFileSync(local, Buffer.from(blob.data || '', 'base64url'));
        const result = await uploadImpl({ file: local, folder, name: driveName(part.filename, index + 1), as: user });
        state.saved[key] = { ...record, driveId: result.id, url: result.url, savedAt: new Date().toISOString() };
        saveState(state);
        saved.push({ ...record, driveId: result.id, url: result.url });
      } catch (error) {
        saved.push({ ...record, error: error.message });
      }
    }
  }
  return { user, matched: seen, saved };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; };
  const days = Math.max(1, Number(value('--days', 30)) || 30);
  const folder = value('--folder', DEFAULT_FOLDER);
  const dryRun = argv.includes('--dry-run');
  const state = loadState();
  const results = [];
  for (const user of USERS) {
    try {
      results.push(await collectForUser({ user, days, folder, state, dryRun }));
    } catch (error) {
      results.push({ user, error: error.message });
    }
  }
  const saved = results.flatMap((r) => r.saved || []);
  console.log(JSON.stringify({
    folder,
    dryRun,
    received: saved.length > 0,
    saved,
    matched: results.flatMap((r) => r.matched || []),
    errors: results.filter((r) => r.error).map((r) => ({ user: r.user, error: r.error })),
  }, null, 2));
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

export { collectForUser };
