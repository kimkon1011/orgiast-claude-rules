// Classification changes presentation only. Existing records and statuses are retained.
export function inboxCategory({ kind = 'info', source = '', text = '' }) {
  const gateReport = source === 'gate-report' || /^gate-report\b/.test(text)
    || /^gate\s+pc=\S+\s+name=\S+\s+verdict=(?:deny|block)\b/.test(text)
    || /^(?:\[[^\]]*gate[^\]]*\]|[\w-]+-gate)\s*[:：]?\s*(?:拒否|deny|block)/i.test(text);
  if (gateReport || /別のパソコン[^\n]*送った連絡が(?:届いて|読まれて)/.test(text)) return 'notification';
  return kind === 'ask' ? 'decision' : kind === 'deadline' ? 'deadline' : 'information';
}
export function inboxCounts(items) {
  const counts = { decision: 0, information: 0, notification: 0, deadline: 0 };
  for (const item of items) if (item.status === 'open') counts[inboxCategory(item)]++;
  return counts;
}
