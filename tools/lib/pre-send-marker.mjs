import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const normalize = text => String(text ?? '').replace(/\r\n/g, '\n').trim();
const hash = text => createHash('sha256').update(text).digest('hex');
const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
function markerPath(home, chatID, text) {
  return path.join(home, '.claude', 'pre-send-checks', `${hash(`${chatID}\n${normalize(text)}`)}.json`);
}
export function writePreSendPass({ chatID, text, home = defaultHome(), now = Date.now() }) {
  const file = markerPath(home, chatID, text);
  const marker = { checkedAt: new Date(now).toISOString(), chatID, bodyHash: hash(normalize(text)) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marker), 'utf8');
  return { file, ...marker };
}
export function assertPreSendPass({ chatID, text, home = defaultHome(), now = Date.now(), maxAgeMs = 5 * 60 * 1000 }) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(home, chatID, text), 'utf8'));
    const age = new Date(now).getTime() - Date.parse(marker.checkedAt);
    if (marker.chatID === chatID && marker.bodyHash === hash(normalize(text)) && Number.isFinite(age) && age >= 0 && age <= maxAgeMs) return marker;
  } catch { /* Missing or malformed evidence never permits sending. */ }
  throw Object.assign(new Error(`送信前照合が必要です。node tools/pre-send-reply-check.mjs --channel beeper --chat ${chatID} --text-file <本文> を通してください（合格時に --write-pass）`), { code: 'PRE_SEND_REQUIRED' });
}
