export function shouldAlert(state, now, intervalMs = 24 * 60 * 60 * 1000) {
  if (!state?.lastAlert) return true;
  const lastAlert = new Date(state.lastAlert);
  return !Number.isFinite(lastAlert.getTime()) || now - lastAlert >= intervalMs;
}

export function buildKeyserveAlert({ label, hostname, status, command }) {
  const pcName = label || hostname;
  return [
    `🚨 ${pcName}: keyserve から鍵が受け取れていません`,
    `HTTP status: ${status ?? '不明'}`,
    `復旧コマンド: ${command}`,
    '~/.claude/keyserve.env が未受領の可能性があります。',
  ].join('\n');
}
