import os from 'node:os';
import { isKimSeat, listItems, updateInboxItem } from './kim-inbox.mjs';
import { inboxSummary, revisionOf, relayDue, jstDay, readRelayState, writeRelayState, interactiveInboxSession } from './lib/kim-inbox-relay-state.mjs';

const normalize = text => String(text).replace(/\s+/g, ' ').trim();
export function evaluateKimInboxRelay(input = {}, { home = process.env.ORGIAST_HOME || os.homedir(), raw = '', text = '', now = Date.now(), env = process.env } = {}) {
  const sessionId = input.session_id || input.sessionId;
  const pass = { decision: 'pass', receipts: [] };
  if (!sessionId || !isKimSeat(home) || !interactiveInboxSession(input, { home, env, raw })) return pass;
  const state = readRelayState(home, sessionId);
  const items = listItems(home);
  const pending = (state.pending || []).flatMap(p => {
    const item = items.find(i => i.id === p.id && (i.status === 'open' || (i.kind === 'info' && i.status === 'seen')) && revisionOf(i) === p.revision && relayDue(i, sessionId, now));
    return item ? [item] : [];
  });
  if (!pending.length) return pass;
  // Only the final response's inbox section counts, never thinking, tools or an older turn.
  const visible = String(text).replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n');
  const heading = /^(?:#{1,6}\s*)?(?:\*\*)?【受信箱】(?:\*\*)?[ \t]*$/m.exec(visible);
  const section = heading ? visible.slice(heading.index + heading[0].length).split(/\n(?:#{1,6}\s|【|次に kim がすること:|この後の自動進行:|このセッション:)/)[0] : '';
  const lines = section.split(/\r?\n/);
  const receipts = [], missing = [];
  for (const item of pending) {
    const index = lines.findIndex(line => line.includes(item.id));
    const summary = inboxSummary(item);
    if (index < 0 || !normalize(lines.slice(index, index + 2).join(' ')).includes(normalize(summary))) { missing.push(item); continue; }
    const number = lines[index].trim().match(/^(?:[-*]\s*)?(\d+)[.．)）]\s*/)?.[1];
    receipts.push({ id: item.id, revision: revisionOf(item), summary, number: number ? Number(number) : null });
  }
  if (!missing.length) return { decision: 'pass', receipts };
  return { decision: 'block', code: 'KIM-INBOX-RELAY', receipts: [],
    reason: 'kim-inbox-relay: 追加コンテキストは kim には見えません。最終メッセージの【受信箱】節に、次の ID と要点を1件1〜2行で載せてください（番号も付けると「1 可」で回答できます）。この報告・返答記録はセッションの目的外ではありません。作業への着手は別です。本文全体の再掲は不要です。\n【受信箱】\n' + pending.map((item, n) => `${n + 1}. ${item.id} ${inboxSummary(item)}`).join('\n') };
}
// Called only after every Stop check passes; blocked drafts are not receipts.
export function commitKimInboxDelivery(home, sessionId, receipts, now = Date.now()) {
  if (!receipts.length) return;
  for (const receipt of receipts) updateInboxItem(home, receipt.id, item => {
    if (!(item.status === 'open' || (item.kind === 'info' && item.status === 'seen')) || revisionOf(item) !== receipt.revision) return;
    const previous = item.deliveredToKim?.revision === receipt.revision ? item.deliveredToKim : {};
    const at = new Date(now).toISOString();
    item.deliveredToKim = { ...previous, revision: receipt.revision, count: (previous.count || 0) + 1, lastAt: at,
      sessions: { ...previous.sessions, [sessionId]: { day: jstDay(now), at } } };
  });
  const state = readRelayState(home, sessionId);
  writeRelayState(home, sessionId, { ...state, lastDelivered: receipts, deliveredAt: new Date(now).toISOString() });
}
