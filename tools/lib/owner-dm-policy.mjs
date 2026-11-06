import { isKimHumanProgress } from './human-progress-row.mjs';
import fs from 'node:fs';
import { isUnattendedRow } from './unattended-session.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../redact-secrets.mjs';

export const deferredFile = home => path.join(home, '.claude/logs/owner-dm-deferred.jsonl');
export function readDeferred(home) {
  try { return fs.readFileSync(deferredFile(home), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return []; }
}
export function notificationKind(text, options = {}) {
  const fields = String(text).matchAll(/(?:kim|user|あなた|持ち主)(?:\s*がすること|\s*の操作|\s*への質問)\s*[:：]\s*([^\n]+)|(?:判断待ち|返事待ち)\s*[:：]\s*([^\n]+)/gi);
  if ([...fields].some(m => !/^(?:なし|無し|不要|ありません|none|n\/a)/i.test((m[1] || m[2]).trim()))) return 'action';
  if (options.kind === 'action') return 'action';
  if (options.kind === 'done-requested' && !isUnattendedRow(options.session || {}, options.home) && !options.session?.headless && !options.session?.unattended && !/(?:headless|autopilot|quota-sweep|nightly|unattended)/i.test([options.source, options.session?.source, options.session?.mode, options.session?.entrypoint, options.session?.sessionType, /^\s*#\s*(?:autopilot|nightly|quota-sweep|unattended)/i.test(options.session?.requestText || '') ? options.session.requestText : ''].join(' '))) return 'done-requested';
  return options.kind === 'digest' ? 'digest' : 'automatic';
}
// Lock covers reservation and append, so simultaneous processes cannot claim a ninth slot.
export async function routeOwnerDm(owner, text, options) {
  if (String(owner).trim().toLowerCase() === 'kim@orgiast.jp' || String(options.userId) === '715210673642012733') {
    const { deliverKim } = await import('../notify-kim.mjs');
    const kind = options.kind === 'ask' || options.kimActionRequired === true || notificationKind(text, options) === 'action' ? 'ask' : 'info';
    const result = await deliverKim(text, { ...options, userId: '715210673642012733', kind, plainJa: false });
    return { ...result, channel: 'kim-inbox', ok: ['session-inbox', 'spooled'].includes(result.delivered) };
  }
  // Human progress is delivered by notifyOwner directly to kim-inbox.
  if (isKimHumanProgress({ ...options.session, owner }) && options.kind !== 'digest') return null;
  const { home } = options;
  const now = new Date(options.now ?? Date.now());
  const kind = notificationKind(text, options);
  const dir = path.join(home, '.claude/logs');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'owner-dm-policy.lock');
  let fd;
  for (let n = 0; n < 200; n++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (n === 199) throw new Error('owner DM policy locked'); await new Promise(r => setTimeout(r, 10)); }
  }
  try {
    const file = path.join(dir, 'owner-dm-reservations.jsonl');
    let reservations = [];
    try { reservations = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const key = String(owner).trim().toLowerCase();
    const used = reservations.filter(r => r.owner === key && r.day === day && r.kind !== 'digest').length;
    const immediate = ['action', 'done-requested', 'digest'].includes(kind) && (kind === 'digest' || used < 8);
    const row = { id: randomUUID(), owner: key, at: now.toISOString(), day, kind, source: options.source || '', reason: used >= 8 ? 'daily-limit' : 'digest-only', status: options.session?.status || (/完了/.test(text) ? 'done' : /未達|停止|止まって|エラー/.test(text) ? 'stalled' : 'in_progress'), text: redactSecrets(String(text)), session: options.session };
    fs.appendFileSync(immediate ? file : deferredFile(home), JSON.stringify(row) + '\n', { mode: 0o600 });
    return immediate ? null : { delivered: 'deferred', channel: 'deferred', ok: true, kind, id: row.id, reason: used >= 8 ? 'daily-limit' : 'digest-only' };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
