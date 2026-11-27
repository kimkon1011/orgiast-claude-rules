// 判断待ちの「エスカレーション ask」（auto-progress-escalate が kim-inbox に積む）と、
// 自動進行台帳の行を結びつける。kim の回答を台帳へ書き戻し、同じ行から毎日新しい ask を作らない。
// 2026-11-19 実測: 190 行から 1273 件の ask が作られ、回答済みの行も翌日以降また聞かれていた。
import { ledgerFile, readLedger, writeLedger, OPEN_STATUSES } from '../auto-progress-ledger.mjs';

export const ESCALATION_PREFIX = '【要対応・kim の判断待ち';
export const escalationDedupeKey = rowKey => `auto-progress-escalate:${rowKey}`;

// 本文内の台帳情報「（元の約束: … / PC … / セッション <8桁> / 台帳 ts <ISO>）」から行を特定する。
export function parseEscalation(item) {
  const text = String(item?.text || '');
  if (!text.startsWith(ESCALATION_PREFIX)) return null;
  const ts = text.match(/台帳 ts ([0-9T:.\-+Z]+)/)?.[1] || '';
  const session = text.match(/セッション ([\w-]*) \/ 台帳 ts/)?.[1] || '';
  return ts ? { ts, session } : null;
}

// 言い換えられた本文からも、末尾などに残った台帳参照だけを緩く抽出する。
export function parseLedgerRef(text) {
  const value = String(text || '');
  const match = value.match(/セッション[\s　]+([\w-]+)[\s\S]*?台帳[\s　]*ts[\s　]+([0-9T:.\-+Z]+)/);
  return match ? { session: match[1], ts: match[2] } : null;
}

export function matchesRow(item, row) {
  if (item?.dedupeKey && item.dedupeKey === escalationDedupeKey(`${row.sessionId || ''}${row.ts || ''}`)) return true;
  const parsed = parseEscalation(item);
  return !!parsed && parsed.ts === row.ts && String(row.sessionId || '').slice(0, 8) === parsed.session;
}

// 既存のエスカレーションを状態別にまとめる。answered/dropped は「もう聞かない」、open は「重ねて積まない」。
export function priorEscalations(items, row) {
  const matched = (items || []).filter(item => item?.kind === 'ask' && !item.autoExpired && matchesRow(item, row));
  const closed = matched.filter(item => ['answered', 'dropped', 'superseded'].includes(item.status));
  const open = matched.filter(item => !['answered', 'dropped', 'superseded', 'seen'].includes(item.status));
  return { matched, closed, open, answered: closed.filter(item => item.status === 'answered' && item.answer).sort((a, b) => String(b.answeredAt).localeCompare(String(a.answeredAt)))[0] || null };
}

// kim-inbox で回答された ask を自動進行台帳の行へ書き戻す（kim-awaiting --answer と同じ形）。
export function syncEscalationAnswer(home, item, { now = Date.now(), io = {} } = {}) {
  if (item?.autoExpired) return false;
  const parsed = parseEscalation(item);
  if (!parsed || !['answered', 'dropped'].includes(item.status)) return false;
  const file = ledgerFile(home);
  const rows = (io.readLedger ?? readLedger)(file);
  let changed = false;
  for (const row of rows) {
    if (!OPEN_STATUSES.has(row.status) || row.ts !== parsed.ts || String(row.sessionId || '').slice(0, 8) !== parsed.session) continue;
    if (item.status === 'dropped') Object.assign(row, { status: 'done', reason: `kim 不要（受信箱 ${item.id}）`, doneAt: new Date(now).toISOString(), nextKim: 'なし' });
    else {
      if (row.kimAnswer === item.answer && row.nextKim === 'なし') continue;
      Object.assign(row, { kimAnswer: item.answer, kimAnsweredAt: item.answeredAt || new Date(now).toISOString(), kimAnswerSource: `kim-inbox:${item.id}`, status: 'stalled', nextKim: 'なし' });
      delete row.resumedAt;
    }
    changed = true;
  }
  if (changed) (io.writeLedger ?? writeLedger)(file, rows);
  return changed;
}
