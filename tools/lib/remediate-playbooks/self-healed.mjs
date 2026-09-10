export const name = 'self-healed';
export async function match(anomaly) {
  const pattern = anomaly.expectation?.successPattern;
  if (!pattern || !anomaly.logTail) return false;
  const lines = anomaly.logTail.split(/\r?\n/);
  const failure = lines.findLastIndex((line) => /error|失敗|abort|exception/i.test(line));
  return failure >= 0 && lines.slice(failure + 1).some((line) => new RegExp(pattern, 'i').test(line));
}
export async function apply() { return { outcome: 'suppressed', note: '後続実行で自然回復済み' }; }
export async function verify() { return true; }
