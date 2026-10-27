import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

// Shared by every usage reader, including separate hook/CLI processes. Store
// only normalized usage and a token fingerprint; never persist credentials.
export async function sharedClaudeUsage({ home, token, now, ttlMs, load }) {
  const file = path.join(home, '.claude', 'claude-plan-usage-cache.json');
  const lock = `${file}.lock`;
  const key = createHash('sha256').update(token).digest('hex');
  const readCached = () => {
    const at = now();
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.key === key && Number.isFinite(cached.observedAt) && cached.observedAt <= at) {
        if (Number.isFinite(cached.blockedUntil) && at < cached.blockedUntil)
          return { available: false, reason: 'HTTP 429', retryAfterMs: cached.blockedUntil - at };
        const result = cached.result;
        const valid = result?.available === true && [result.fiveHour, result.sevenDay].every(w =>
          w && Number.isFinite(w.utilization) && (w.resetsAt === null || Date.parse(w.resetsAt) > at));
        if (valid && at - cached.observedAt < ttlMs) return result;
      }
    } catch { /* Missing/corrupt cache is not an observation. */ }
    return null;
  };
  const cached = readCached();
  if (cached) return cached;
  let handle;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A crashed reader must not leave a permanent lock. Requests time out well
    // before this lease; use wall time independently of an injected usage clock.
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.unlinkSync(lock); } catch {}
    handle = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return { available: false, reason: 'network: usage read in progress' };
    // Read-only cache storage must not prevent a usage observation.
  }
  try {
    // Another process may have finished between our first read and lock claim.
    const latest = readCached();
    if (latest) return latest;
    const result = await load();
    if (result.available || (result.reason === 'HTTP 429' && result.retryAfterMs > 0)) {
      const observedAt = now();
      const record = result.available ? { key, observedAt, result }
        : { key, observedAt, blockedUntil: observedAt + result.retryAfterMs };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch { /* Cache failure does not change the API result. */ }
      finally { try { fs.unlinkSync(temporary); } catch {} }
    }
    return result;
  } finally {
    if (handle !== undefined) { fs.closeSync(handle); try { fs.unlinkSync(lock); } catch {} }
  }
}
