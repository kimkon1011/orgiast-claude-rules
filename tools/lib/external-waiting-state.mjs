// 社外返信待ちの状態ファイル。hook（kim-awaiting）と scan（external-waiting）の両方が読むので軽量に保つ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
export const stateDir = home => path.join(home, '.claude', 'state');
export const externalFile = home => path.join(stateDir(home), 'external-waiting.json');
export const skipsFile = home => path.join(stateDir(home), 'external-waiting-skips.json');
export const answersDir = home => path.join(stateDir(home), 'external-waiting-answers');

export function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch { return fallback; }
}
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}

export const readSkips = home => { const value = readJsonSafe(skipsFile(home), []); return Array.isArray(value) ? value : []; };
// 同じスレッドに新しい受信が来て lastMessageId が変わったら、skip は効かなくなる（自動で再表示）。
export const isSkipped = (skips, item) => skips.some(skip => skip.id === item.id && skip.lastMessageId === item.lastMessageId);
export function addSkip(home, id, reason, now = Date.now()) {
  const item = (readJsonSafe(externalFile(home), {}).items || []).find(entry => entry.id === id);
  if (!item) throw new Error('external item not found');
  const skips = readSkips(home).filter(skip => skip.id !== id);
  skips.push({ id, lastMessageId: item.lastMessageId, reason, at: new Date(now).toISOString() });
  writeJsonAtomic(skipsFile(home), skips);
}
export function saveAnswer(home, id, body, now = Date.now()) {
  if (!/^ex:[0-9a-f]{12}$/.test(id)) throw new Error('invalid external id');
  const item = (readJsonSafe(externalFile(home), {}).items || []).find(entry => entry.id === id);
  if (!item) throw new Error('external item not found');
  writeJsonAtomic(path.join(answersDir(home), `${id.slice(3)}.json`), { id, answer: body, at: new Date(now).toISOString(), mailbox: item.mailbox, threadId: item.threadId, subject: item.subject, who: item.who });
}
