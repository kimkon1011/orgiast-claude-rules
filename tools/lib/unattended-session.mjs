// Shared classification for ledger records and inbox consumers.
export function isHeadless(env = process.env) {
  return env.CLAUDE_HEADLESS === '1' || !!String(env.ORGIAST_HEADLESS_JOB || '').trim();
}
const cleanValue = value => String(value ?? '').replace(/^[\s*`_]+|[\s*`_]+$/g, '').trim();
export function isUnattendedRow(row, home) {
  const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\/mnt\/([a-z])\//i, '$1:/').replace(/\/+$/, '').toLowerCase();
  const cwd = normalize(row.cwd), root = normalize(home);
  const request = cleanValue(row.requestText || String(row.promise || '').replace(/^API エラー（.*?）で返答できなかった依頼:\s*/, ''));
  const probe = /^(?:[「『"']?)(?:OK|了解)(?:[」』"']?)\s*とだけ\s*(?:返して(?:ください)?|返信して(?:ください)?|答えて(?:ください)?)[。.!！\s]*$/i.test(request);
  return probe || /^c:\/windows\/system32(?:\/|$)/.test(cwd) || /(?:^|\/)\.stall-sweeper(?:\/|$)/.test(cwd) || ['auto-session', 'scratch', 'quota-sweep-repo'].some(name => {
    const base = `${root}/.claude/${name}`;
    return cwd === base || cwd.startsWith(`${base}/`);
  });
}

export function isUnattendedSession(input = {}, { home, env = process.env } = {}) {
  return isHeadless(env) || ['sdk-cli', 'sdk-ide'].includes(input.entrypoint || input.entryPoint)
    || isUnattendedRow({ ...input, cwd: input.cwd || process.cwd() }, home);
}
