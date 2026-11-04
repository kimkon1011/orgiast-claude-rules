import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addItem, listItems, isKimSeat } from '../kim-inbox.mjs';
import { rowKey } from '../auto-progress-ledger.mjs';

export const usesKimDoneInbox = (row, home) => isKimSeat(home) || String(row.owner || '').toLowerCase() === 'kim@orgiast.jp';
export const hasDoneInboxReceipt = row => Boolean(row.doneInboxId && row.doneInboxVerifiedAt);

// A queued DM, toast or addItem's return value alone is not a delivery receipt.
// Use a stable job identity so a failed ledger write cannot create duplicate notices.
export async function deliverDoneInbox(home, rows, text, { now = Date.now(), io = {} } = {}) {
  let delivery = { delivered: 'none', channel: 'kim-inbox', ok: false };
  try {
    const dedupeKey = 'auto-progress-done:' + createHash('sha256')
      .update(rows.map(rowKey).sort().join('\n')).digest('hex').match(/.{8}/g).join('-');
    const item = await (io.addKimInboxItem ?? addItem)(home, { kind: 'info', source: 'auto-progress-done', text, dedupeKey });
    const stored = (io.listKimInboxItems ?? listItems)(home).find(saved => saved.id === item?.id);
    if (!stored || stored.kind !== 'info' || stored.dedupeKey !== dedupeKey || !stored.text || stored.text !== item.text || stored.forwardError) {
      throw new Error('kim-inbox delivery read-back failed');
    }
    delivery = { delivered: 'session-inbox', channel: 'kim-inbox', ok: true, id: stored.id,
      receipt: { doneInboxId: stored.id, doneInboxVerifiedAt: new Date(now).toISOString(), doneNotifiedAt: new Date(now).toISOString(), doneNotifyPending: false } };
    return delivery;
  } catch (error) {
    delivery.reason = String(error?.code || error?.message || error).slice(0, 200);
    throw error;
  } finally {
    try {
      const file = path.join(home, '.claude', 'logs', 'auto-progress-done-inbox.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), sessionIds: rows.map(row => row.sessionId), ...delivery }) + '\n');
    } catch { /* Logging is not the receipt; inbox read-back is authoritative. */ }
  }
}
