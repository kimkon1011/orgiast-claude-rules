import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { outboundLogPath } from './send-context.mjs';

export const MONITOR_DAYS = 14 * 86400000;
export function externalSpec(row) {
  if (!/auto-progress-external-check\.mjs(?:["']?\s)/.test(row.check || '')) return null;
  const option = name => new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s;&|]+))`).exec(row.check)?.slice(1).find(Boolean);
  const channel = option('channel'), threadId = option('thread-id'), since = option('since');
  if (!['line', 'gmail'].includes(channel) || !threadId || !Number.isFinite(Date.parse(since))) return null;
  return { channel, threadId, since, ...(channel === 'gmail' ? { mailbox: option('mailbox') || 'seisaku-team@orgiast.jp' } : {}) };
}
export const eventKey = (spec, id) => createHash('sha256').update(`${spec.channel}|${spec.mailbox || ''}|${spec.threadId}|${id}`).digest('hex');
export const eventDir = home => path.join(home, '.claude', 'external-monitor-events');
export function readEvents(home) {
  let names;
  try { names = fs.readdirSync(eventDir(home)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(eventDir(home), n), 'utf8')));
}
export function saveEvent(home, event) {
  fs.mkdirSync(eventDir(home), { recursive: true });
  const file = path.join(eventDir(home), `${event.key}.json`), temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(event), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function notifiedGmailIds(home) {
  return new Set(readEvents(home).filter(e => e.channel === 'gmail' && e.inboxId).map(e => `${e.mailbox}|${e.message.id}`));
}
export function gmailNotificationOwned(home, now) {
  const notified = notifiedGmailIds(home);
  let rows = [];
  try { rows = fs.readFileSync(path.join(home, '.claude', 'auto-progress-ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const active = rows.filter(r => ['open', 'stalled', 'resumed', 'waiting_user'].includes(r.status) &&
    now < (Date.parse(r.deadlineAt) || Date.parse(r.ts) + MONITOR_DAYS)).map(externalSpec).filter(s => s?.channel === 'gmail');
  return item => notified.has(`${item.mailbox}|${item.lastMessageId}`) || item.kind === 'reply' && active.some(s =>
    s.mailbox === item.mailbox && s.threadId === item.threadId && Date.parse(item.since) >= Date.parse(s.since));
}

// Match successful tool results in THIS transcript to durable send receipts; never
// infer a destination from another session's most recent global send.
export function recentSessionSends(transcriptPath, home, now) {
  let entries, receipts;
  try {
    entries = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    receipts = fs.readFileSync(outboundLogPath(home), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch { return []; }
  const calls = new Map(), found = new Map();
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    if (entry.type === 'user' && typeof entry.message?.content === 'string') { calls.clear(); found.clear(); }
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === 'text' && entry.type === 'user') { calls.clear(); found.clear(); }
      const cmd = block.input?.command || block.input?.cmd || '';
      if (block.type === 'tool_use' && !/--dry-run\b/.test(cmd) && (/line-group-send\.mjs\b/.test(cmd) || /gmail-draft\.mjs\b/.test(cmd) && /--send\s/.test(cmd))) calls.set(block.id, cmd);
      if (block.type !== 'tool_result' || block.is_error || !calls.has(block.tool_use_id)) continue;
      const output = typeof block.content === 'string' ? block.content : (block.content || []).map(b => b.text || '').join('\n');
      const cmdUsed = calls.get(block.tool_use_id);
      for (const receipt of receipts) {
        if (!receipt.messageId || !['line', 'gmail'].includes(receipt.channel) || !cmdUsed.includes(receipt.channel === 'line' ? 'line-group-send.mjs' : 'gmail-draft.mjs')) continue;
        if (now - Date.parse(receipt.at) > 24 * 3600000 || Date.parse(receipt.at) > now) continue;
        if (!output.includes(String(receipt.messageId))) continue;
        const mailbox = receipt.mailbox || /--user\s+["']?([^\s"']+)/.exec(cmdUsed)?.[1] || 'seisaku-team@orgiast.jp';
        found.set(`${receipt.channel}|${mailbox}|${receipt.target}`, { channel: receipt.channel, threadId: receipt.target, since: receipt.at, ...(receipt.channel === 'gmail' ? { mailbox } : {}) });
      }
    }
  }
  return [...found.values()];
}
export function monitorCommand(spec) {
  // IDs/mailboxes from receipts are data, not shell code.
  if (![spec.threadId, spec.mailbox || 'ok'].every(v => /^[\w@.+-]+$/.test(v))) throw new Error('Invalid external destination');
  return `node tools/auto-progress-external-check.mjs --channel ${spec.channel} --thread-id ${spec.threadId} --since ${new Date(spec.since).toISOString()}${spec.mailbox ? ` --mailbox ${spec.mailbox}` : ''}`;
}
