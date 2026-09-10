export const name = 'failover-succeeded';
export async function match(anomaly) {
  const lines = String(anomaly.logTail || '').split(/\r?\n/);
  return lines.some((line, i) => /(?:429|5\d\d)/.test(line) && lines.slice(i + 1, i + 4).some((next) => /\[failover\]/i.test(next)) && lines.slice(i + 1, i + 6).some((next) => /\bOK\b/i.test(next)));
}
export async function apply() { return { outcome: 'suppressed', note: 'フェイルオーバー成功済み' }; }
export async function verify() { return true; }
