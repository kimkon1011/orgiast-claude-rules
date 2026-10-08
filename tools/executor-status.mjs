// Legacy successful CLI/API rows omitted status; explicit failures take precedence.
export function normalizeExecutorStatus(row = {}) {
  if (row.category === 'unrouted' || row.provider === 'skipped' || row.status === 'no-cheap-executor') return 'unrouted';
  if (row.timedOut === true || String(row.status) === '124') return 'timeout';
  if (row.ok === false || row.launched === false) return 'error';
  if (row.status == null || row.status === 'ok' || row.status === 0 || row.status === '0') return 'ok';
  if (/^-?\d+$/.test(String(row.status))) return 'error';
  return String(row.status);
}

export function executorExitStatus(result = {}) {
  if (result.timedOut === true || String(result.status) === '124') return 'timeout';
  return result.status != null && Number(result.status) === 0 && !result.error && result.launched !== false ? 'ok' : 'error';
}
