import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const inboxText = row => row.text ?? `${row.state || 'progressed'}: ${row.evidence || ''}${row.artifact ? `（成果物: ${row.artifact}）` : ''}`;

export const inboxFile = (home, sessionId) => path.join(home, '.claude', 'auto-progress-inbox', `${sessionId}.jsonl`);
export function appendInbox(home, sessionId, item) {
  const file = inboxFile(home, sessionId); fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ...item, id: randomUUID(), at: item.at || new Date().toISOString(), shown: false };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  if (sessionId !== '_owner' && ['done', 'needs_user', 'blocked'].includes(row.state)) {
    fs.appendFileSync(inboxFile(home, '_owner'), `${JSON.stringify({ ...row, sessionId, text: inboxText(row) })}\n`);
  }
  return file;
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
