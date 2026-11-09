import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_MARKER_AGE_MS = 30 * 60 * 1000;
export const textHash = text => createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n').trim()).digest('hex');
export const markerPath = (text, home = process.env.ORGIAST_HOME || os.homedir()) => path.join(home, '.claude', 'send-context-checks', `${textHash(text)}.json`);

export function writeContextMarker({ channel, target, text, latest, reason, home, now = new Date() }) {
  const marker = { version: 1, checkedAt: now.toISOString(), channel, target, bodyHash: textHash(text), latest: latest ?? null, reason };
  const file = markerPath(text, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return { file, marker };
}

export function readContextMarker(text, home) {
  try { return JSON.parse(fs.readFileSync(markerPath(text, home), 'utf8')); } catch { return null; }
}

const sameLatest = (a, b) => String(a?.id ?? '') === String(b?.id ?? '') && String(a?.at ?? '') === String(b?.at ?? '');
export async function assertContextApproved({ channel, target, text, home, getLatest, now = Date.now() }) {
  const command = `node tools/send-context-check.mjs --channel ${channel} --target ${JSON.stringify(target)} --text-file <送る本文>`;
  const fail = why => { const error = new Error(`送信前の履歴整合性チェックが必要です: ${why}\n実行: ${command}`); error.code = 'SEND_CONTEXT_REQUIRED'; throw error; };
  const marker = readContextMarker(text, home);
  if (!marker) fail('承認マーカーがありません');
  if (marker.bodyHash !== textHash(text) || marker.channel !== channel || String(marker.target) !== String(target)) fail('本文または宛先がチェック時と異なります');
  if (!Number.isFinite(Date.parse(marker.checkedAt)) || now - Date.parse(marker.checkedAt) > MAX_MARKER_AGE_MS || now < Date.parse(marker.checkedAt)) fail('チェックから30分を超えています');
  const latest = await getLatest();
  if (!sameLatest(marker.latest, latest)) fail('チェック後に宛先の新着があります');
  return marker;
}

export function latestOf(messages) {
  const sorted = [...messages].filter(m => m.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const m = sorted.at(-1);
  return m ? { id: String(m.id ?? ''), at: m.at } : null;
}

export function outboundLogPath(home = process.env.ORGIAST_HOME || os.homedir()) { return path.join(home, '.claude', 'logs', 'outbound-sent.jsonl'); }
export function recordOutbound(entry, home) {
  const file = outboundLogPath(home); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}
export function readOutbound(target, home) {
  try { return fs.readFileSync(outboundLogPath(home), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(x => String(x.target) === String(target)); } catch { return []; }
}
