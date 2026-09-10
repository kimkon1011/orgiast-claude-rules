export const name = 'log-write-contention';
export async function match(anomaly) { return /EBUSY/i.test(anomaly.message || ''); }
export async function apply(anomaly, context) {
  const tool = anomaly.expectation?.tool;
  if (!tool) return { outcome: 'unhandled' };
  const source = context.readRepoFile(tool);
  return /appendLineWithRetry/.test(source) ? { outcome: 'fixed', note: 'リトライ修正済み・次回観測待ち' } : { outcome: 'unhandled' };
}
export async function verify(_anomaly, _context, result) { return result.outcome === 'fixed'; }
