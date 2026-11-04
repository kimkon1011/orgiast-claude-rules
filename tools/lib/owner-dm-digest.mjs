import { kimAction, isHumanActionRequired, cleanText } from '../auto-progress-digest.mjs';
import { notificationKind } from './owner-dm-policy.mjs';
const day = 86400000;
const plain = value => cleanText(value).replace(/(?:作業ID|セッションの目的|プロジェクト)[:：][^\n]*/g, '').replace(/(?:[A-Za-z]:\\|~?\/)[^\s、。]+/g, '').replace(/\b(?:autopilot|headless|quota-sweep|nightly-repo|unattended)\b[^\s、。]*/gi, '').replace(/\s+/g, ' ').trim();
export function compactDigest(rows, deferred, now, { home } = {}) {
  const actions = deferred.filter(r => r.kind === 'action');
  for (const row of rows) if (isHumanActionRequired(row)) actions.push({ text: [plain(row.label || row.promise).slice(0, 60), plain(kimAction(row))].filter(Boolean).join(' — '), at: row.changedAt || row.ts });
  const byText = new Map();
  for (const action of actions) {
    const previous = byText.get(action.text);
    if (!previous || Date.parse(action.at) < Date.parse(previous.at)) byText.set(action.text, { ...action });
    if (action.reason === 'daily-limit') byText.get(action.text).reason = 'daily-limit';
  }
  const unique = [...byText.values()];
  const old = unique.filter(a => a.reason !== 'daily-limit' && now - Date.parse(a.changedAt || a.at) >= 7 * day);
  const recent = unique.filter(a => !old.includes(a)).sort((a, b) => Number(b.reason === 'daily-limit') - Number(a.reason === 'daily-limit'));
  const lines = ['あなたの返事待ち'];
  // Never truncate a question: oversized questions remain in the queue for a later digest.
  const included = [];
  let chars = 0;
  for (const a of recent) {
    const text = plain(a.text);
    if (included.length >= 2 || chars + text.length > 1350) continue;
    included.push(a); chars += text.length;
    lines.push(`・${text}（このDMに返信してください）`);
  }
  const extra = [];
  if (old.length) extra.push(`古い待ち ${old.length}件（7日以上動きなし）`);
  if (!unique.length) lines.push('なし');
  else if (recent.length > included.length) extra.push(`ほか返事待ち ${recent.length - included.length}件（次のまとめでお知らせします）`);
  if (extra.length) lines.push(extra.join(' ／ '));
  const humanRows = rows.filter(r => notificationKind('', { kind: 'done-requested', session: r, home }) === 'done-requested');
  const human = [...humanRows, ...deferred.filter(r => r.kind === 'done-requested' && !humanRows.some(h => h.sessionId && h.sessionId === r.session?.sessionId)).map(r => ({ ...r.session, status: 'done', label: r.session?.label || r.session?.requestText || r.text }))];
  const names = list => list.map(r => plain(r.label || r.requestText || r.promise)).filter(Boolean).slice(0, 2).join('・').slice(0, 120);
  const done = human.filter(r => r.status === 'done');
  const ongoing = human.filter(r => r.status !== 'done');
  lines.push('あなたが頼んだこと', `完了 ${done.length}件: ${names(done) || 'なし'}`, `進行中 ${ongoing.length}件: ${names(ongoing) || 'なし'}${ongoing.some(r => ['stalled', 'waiting_user'].includes(r.status)) ? `（止まっている ${ongoing.filter(r => ['stalled', 'waiting_user'].includes(r.status)).length}件）` : ''}`);
  const automatic = rows.filter(r => !humanRows.includes(r));
  lines.push('自動作業', `完了 ${automatic.filter(r => r.status === 'done').length + deferred.filter(r => r.kind === 'automatic' && r.status === 'done').length}件・止まっている ${automatic.filter(r => ['stalled', 'waiting_user'].includes(r.status)).length + deferred.filter(r => r.kind === 'automatic' && r.status === 'stalled').length}件`);
  const shown = new Set([...included, ...old].map(a => a.text));
  return { text: lines.join('\n'), includedIds: actions.filter(a => shown.has(a.text)).map(a => a.id).filter(Boolean) };
}
