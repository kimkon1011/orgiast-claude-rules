import fs from 'node:fs';
import path from 'node:path';

export const inboxFile = (home, sessionId) => path.join(home, '.claude', 'auto-progress-inbox', `${sessionId}.jsonl`);
export function appendInbox(home, sessionId, item) {
  const file = inboxFile(home, sessionId); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ...item, shown: false })}\n`); return file;
}
export function readRows(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; }
}
export function appendOwnerInbox(home, { source, text }) {
  const file = inboxFile(home, '_owner');
  const now = Date.now();
  if (readRows(file).some(row => !row.shown && row.text === text && now >= Date.parse(row.at) && now - Date.parse(row.at) < 24 * 60 * 60 * 1000)) return file;
  return appendInbox(home, '_owner', { at: new Date(now).toISOString(), source, text });
}
