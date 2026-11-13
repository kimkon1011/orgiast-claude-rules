import { createHash } from 'node:crypto';
import { addItem, listItems, markSeen } from '../kim-inbox.mjs';
import { rowKey } from '../auto-progress-ledger.mjs';
import { checkProgressSummary } from './check-progress-summary.mjs';
export { isKimHumanProgress } from './human-progress-row.mjs';
const hash = value => createHash('sha256').update(value).digest('hex').match(/.{8}/g).join('-');
const first = value => String(value || '').trim().split(/\r?\n/)[0];
function outputState(text) {
  for (const candidate of [String(text || ''), ...String(text || '').split(/\r?\n/).reverse()]) {
    try { const value = JSON.parse(candidate); if (typeof value?.state === 'string') return value.state; } catch { /* plain output */ }
  }
  return '';
}
/** check 出力 JSON から nextKim を抽出。無ければ空文字。 */
function checkNextKim(text) {
  for (const candidate of [String(text || ''), ...String(text || '').split(/\r?\n/).reverse()]) {
    try { const value = JSON.parse(candidate); if (typeof value?.nextKim === 'string') return value.nextKim.trim(); } catch { /* plain output */ }
  }
  return '';
}
/** 台帳の nextKim より check 出力 JSON の nextKim を優先 */
function effectiveNextKim(row) {
  const fromCheck = checkNextKim(row.checkText);
  if (fromCheck) return fromCheck;
  return String(row.nextKim || '').trim();
}
export function humanProgressText(row) {
  const nextKim = effectiveNextKim(row);
  const nextKimLine = nextKim && !/^(?:特に)?(?:なし|無し|ナシ)/.test(nextKim) ? `\nkim の次の1手: ${nextKim}` : '';
  return `依頼名: ${first(row.label || row.promise)}
いまの状態: ${first(checkProgressSummary(row.checkText))}${nextKimLine}
Claude の次の手: ${String(row.nextClaude || '').trim() || 'check の実行ログと対象の受け口を確認し、次の進行を判断する'}`;
}
// Compare with the last delivered state, not the last check: failures must retry.
// Include the previous receipt in the key so A -> B -> A is a new notification.
// 要約文（checkProgressSummary 1行目）は件数変化で毎回変わるため fingerprint から除外（2026-11-12 重複14件の実害）。
export async function deliverHumanProgress(home, row, { io = {} } = {}) {
  const source = 'auto-progress-human:' + hash(rowKey(row));
  const effNextKim = effectiveNextKim(row);
  const kind = effNextKim ? 'ask' : 'info';
  const fingerprint = hash(JSON.stringify([row.checkResult || '', row.state || '', outputState(row.checkText), row.status || '',
    effNextKim || 'なし']));
  const items = (io.listKimInboxItems ?? listItems)(home).filter(item => item.source === source);
  const parents = new Set(items.map(item => item.dedupeKey?.split(':').at(-2)));
  const previous = items.filter(item => !parents.has(item.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  if (previous?.dedupeKey?.endsWith(':' + fingerprint) && previous.kind === kind && previous.text && !previous.forwardError) return { delivered: 'session-inbox', id: previous.id, unchanged: true };
  // 同じ source の古い未読 info/ask は既読にする（削除しない）
  // previous も含め、新通知で上書きされる全ての open 項目を対象にする
  const stale = items.filter(item => !parents.has(item.id) && item.status === 'open');
  for (const old of stale) {
    try { (io.markKimInboxSeen ?? markSeen)(home, old.id); } catch { /* best-effort */ }
  }
  const dedupeKey = previous?.dedupeKey?.endsWith(':' + fingerprint) ? previous.dedupeKey : `${source}:${previous?.id || 'initial'}:${fingerprint}`;
  const item = await (io.addKimInboxItem ?? addItem)(home, { kind, source, text: humanProgressText(row), dedupeKey });
  const saved = (io.listKimInboxItems ?? listItems)(home).find(saved => saved.id === item?.id);
  if (!saved || saved.kind !== kind || saved.dedupeKey !== dedupeKey || !saved.text || saved.text !== item.text || saved.forwardError) throw new Error('kim-inbox progress read-back failed');
  return { delivered: 'session-inbox', channel: 'kim-inbox', ok: true, id: saved.id };
}
