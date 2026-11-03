const WINDOW_MS = 10 * 60_000;
function titleMatches(label, title) {
  const previous = String(label ?? '').trim(), full = String(title ?? '').trim();
  if (!previous || !full || previous === 'Claude Code') return false;
  if (previous.endsWith('…')) {
    const prefix = previous.slice(0, -1).trimEnd();
    return Boolean(prefix) && full.startsWith(prefix);
  }
  return previous === full;
}
function matchArchive({ previousLabel, changedAt, currentLabel, now, rows }) {
  if (currentLabel !== 'Claude Code') return { reason: 'label-changed' };
  if (!Number.isFinite(changedAt) || now - changedAt > WINDOW_MS) return { reason: 'expired' };
  const matches = new Map();
  for (const row of rows) {
    if (!row.sessionId || !titleMatches(previousLabel, row.title)) continue;
    const at = Date.parse(row.archivedAt);
    if (!Number.isFinite(at) || Math.abs(at - changedAt) > WINDOW_MS) continue;
    matches.set(`${row.sessionId}/${at}`, row);
  }
  if (matches.size !== 1) return { reason: matches.size ? 'ambiguous' : 'no-match' };
  return { reason: 'matched', row: [...matches.values()][0] };
}
module.exports = { WINDOW_MS, titleMatches, matchArchive };
