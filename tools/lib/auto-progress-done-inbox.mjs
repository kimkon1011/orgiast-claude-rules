import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addItem, listItems, isKimSeat } from '../kim-inbox.mjs';
import { completionActions } from './auto-progress-artifact.mjs';
import { rowKey } from '../auto-progress-ledger.mjs';
import { discordAllowed } from './kim-discord-allowlist.mjs';
import { notifyOwner } from '../notify-owner.mjs';

export const usesKimDoneInbox = (row, home) => isKimSeat(home) || String(row.owner || '').toLowerCase() === 'kim@orgiast.jp';
export const hasDoneInboxReceipt = row => Boolean(row.doneInboxId && row.doneInboxVerifiedAt);

// A queued DM, toast or addItem's return value alone is not a delivery receipt.
// Use a stable job identity so a failed ledger write cannot create duplicate notices.
export async function deliverDoneInbox(home, rows, text, { now = Date.now(), io = {} } = {}) {
  let delivery = { delivered: 'none', channel: 'kim-inbox', ok: false };
  try {
    const dedupeKey = 'auto-progress-done:' + createHash('sha256')
      .update(rows.map(rowKey).sort().join('\n')).digest('hex').match(/.{8}/g).join('-');
    const details = rows.map(row => completionActions(row, { home }));
    const kind = details.some(detail => detail.kind === 'ask') ? 'ask' : 'info';
    const actionText = details.map(detail => detail.text).join('\n');
    text = text.replace(/kim がすること: なし[^\n]*/g, '').trim();
    if (!text.includes(actionText)) text = text.slice(0, Math.max(0, 3999 - actionText.length)) + '\n' + actionText;
    const item = await (io.addKimInboxItem ?? addItem)(home, { kind, refresh: true, priority: 'high', source: 'auto-progress-done', text, dedupeKey });
    const stored = (io.listKimInboxItems ?? listItems)(home).find(saved => saved.id === item?.id);
    if (!stored || stored.kind !== kind || stored.dedupeKey !== dedupeKey || !stored.text || stored.text !== item.text || stored.forwardError) {
      throw new Error('kim-inbox delivery read-back failed');
    }
    delivery = { delivered: 'session-inbox', channel: 'kim-inbox', ok: true, id: stored.id,
      receipt: { doneInboxId: stored.id, doneInboxVerifiedAt: new Date(now).toISOString(), doneNotifiedAt: new Date(now).toISOString(), doneNotifyPending: false } };

    const checkAllowed = io.discordAllowed ?? discordAllowed;
    if (checkAllowed(text, { home }).allowed) {
      try {
        const owner = rows[0]?.owner || 'kim@orgiast.jp';
        const dmResult = await (io.notifyOwner ?? notifyOwner)(owner, text, { home, now, kind: 'automatic', session: rows[0], userId: '715210673642012733' });
        if (dmResult?.delivered === 'dm') {
          delivery = {
            ...delivery,
            delivered: 'dm',
            channel: 'discord',
            messageId: dmResult.messageId,
            recipientId: dmResult.recipientId,
            httpStatus: dmResult.httpStatus,
          };
        }
      } catch { /* session-inbox fallback remains */ }
    }
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

// Recover old 'no action' notices without creating a second notification or reopening answered asks.
export async function refreshDoneApprovals(home, rows, { now, io = {}, patch } = {}) {
  const items = (io.listKimInboxItems ?? listItems)(home);
  for (const row of rows) {
    if (row.status !== 'done' || !hasDoneInboxReceipt(row)) continue;
    const item = items.find(item => item.id === row.doneInboxId);
    if (!item || item.kind !== 'info' || !['open', 'seen'].includes(item.status)) continue;
    if (completionActions(row, { home }).kind !== 'ask') continue;
    const result = await deliverDoneInbox(home, [row], item.text, { now, io });
    if (patch(rowKey(row), result.receipt) !== false) Object.assign(row, result.receipt);
  }
}
