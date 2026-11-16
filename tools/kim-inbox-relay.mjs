import os from 'node:os';
import { isKimSeat, listItems, updateInboxItem } from './kim-inbox.mjs';
import { formatInboxBrief, revisionOf, relayDue, jstDay, readRelayState, writeRelayState, interactiveInboxSession, groupInboxItems } from './lib/kim-inbox-relay-state.mjs';

const normalize = text => String(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '').replace(/\s+/g, ' ').trim();

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
  // Group duplicate items by work ID + decide; only the representative must appear in the response.
  const groups = groupInboxItems(pending);
  // Only the final response's inbox section counts, never thinking, tools or an older turn.
  const visible = String(text).replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n');
  const heading = /^.*【受信箱】.*$/m.exec(visible);
  const section = heading ? visible.slice(heading.index).split(/\n\s*(?:#{1,6}\s|(?:\*\*)?【|次に kim がすること:|この後の自動進行:|このセッション:)/)[0] : '';
  const lines = section.split(/\r?\n/);
  const receipts = [], missing = [];
  for (const group of groups) {
    const rep = group.representative;
    const allIds = [rep.id, ...group.duplicates];
    const index = lines.findIndex(line => line.split(/[^A-Za-z0-9_-]+/).includes(rep.id));
    if (index < 0) { missing.push(rep); continue; }
    // Require structured lines (containing "判断" or "返事") between this item's line and the next numbered line.
    let nextNum = -1;
    for (let i = index + 1; i < lines.length; i++) {
      if (/^\s*(?:[-*]\s*)?\d+[.．)）]\s/.test(lines[i])) { nextNum = i; break; }
    }
    const block = lines.slice(index + 1, nextNum > 0 ? nextNum : undefined).join(' ');
    if (!/判断|返事/.test(block)) { missing.push(rep); continue; }
    const number = lines[index].trim().match(/^(?:[-*]\s*)?(\d+)[.．)）]\s*/)?.[1];
    // All group members (representative + duplicates) are receipted when the representative is found
    for (const id of allIds) {
      const item = pending.find(i => i.id === id);
      if (item) receipts.push({ id, revision: revisionOf(item), summary: formatInboxBrief(item, number || 1, { home }).split('\n')[0], number: number ? Number(number) : null });
    }
  }
  if (!missing.length) return { decision: 'pass', receipts };
  // Block template shows grouped items with duplicate annotation
  const briefLines = [];
  let n = 0;
  for (const group of groups) {
    n++;
    let brief = formatInboxBrief(group.representative, n, { home });
    if (group.duplicates.length > 0) {
      const bl = brief.split('\n');
      const dupeDisplay = group.duplicates.slice(0, 5).join(', ');
      bl[0] += `（同じ件: ${dupeDisplay}${group.duplicates.length > 5 ? '…' : ''}）`;
      brief = bl.join('\n');
    }
    briefLines.push(brief);
  }
  return { decision: 'block', code: 'KIM-INBOX-RELAY', receipts: [],
    reason: 'kim-inbox-relay: 追加コンテキストは kim には見えません。最終メッセージの【受信箱】節に、ID を含む行から次の番号行までの間に「判断」または「返事」を含む行がある形で載せてください。原文の切り詰め貼り付けは禁止。この形で1件ずつ書く。番号も付けると「1 可」で回答できます。この報告・返答記録はセッションの目的外ではありません。作業への着手は別です。本文全体の再掲は不要です。\n【受信箱】\n' + briefLines.join('\n') };
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
