import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sanitizeReason } from './fleet-beacon.mjs';

export const TARGET_CACHE_MS = 24 * 60 * 60 * 1000;
export const TARGET_FETCH_RETRIES = 2;
export const TARGET_FETCH_DELAY_MS = 200;
// GAS waits up to 20s for its script lock; allow time for the response as well.
export const TARGET_FETCH_TIMEOUT_MS = 25_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Cache only routing identities, never credentials or a claim of current liveness.
function identities(result) {
  return {
    beacons: (Array.isArray(result?.beacons) ? result.beacons : [])
      .filter(b => typeof b?.label === 'string' && b.label.trim())
      .map(b => ({ label: b.label, ...(typeof b.hostname === 'string' ? { hostname: b.hostname } : {}) })),
    serverPolls: Object.fromEntries(Object.entries(result?.serverPolls && typeof result.serverPolls === 'object' && !Array.isArray(result.serverPolls) ? result.serverPolls : {})
      .filter(([label, at]) => label.trim() && typeof at === 'string' && Number.isFinite(Date.parse(at))))
  };
}
const nonempty = data => data.beacons.length || Object.keys(data.serverPolls).length;

export async function fetchMailTargets({ home, now = Date.now, fetchBeacons, sleepImpl = sleep, offline = false } = {}) {
  const file = path.join(home, '.claude', 'fleet-mail-targets.json');
  // A changed endpoint/account must not reuse another fleet's cached labels.
  let scope = '';
  try { scope = createHash('sha256').update(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'))).digest('hex'); } catch {}
  let cache;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = now() - saved.savedAt;
    if (scope && saved.scope === scope && Number.isFinite(age) && age >= 0 && age < TARGET_CACHE_MS) cache = identities(saved);
  } catch { /* Missing/corrupt cache cannot prevent a live lookup. */ }
  let result = { ok: false, beacons: [], serverPolls: {}, reason: 'dry-run（取得省略）' };
  if (!offline) {
    const fetchImpl = fetchBeacons ?? (await import('./fleet-beacon.mjs')).fetchBeacons;
    for (let attempt = 0; attempt <= TARGET_FETCH_RETRIES; attempt++) {
      try {
        result = await fetchImpl({ home, timeoutMs: TARGET_FETCH_TIMEOUT_MS });
        if (!result || (result.ok && !Array.isArray(result.beacons))) throw new Error('invalid beacon response');
      } catch (error) { result = { ok: false, reason: sanitizeReason(error?.message || error) }; }
      const data = identities(result);
      if (result.ok && nonempty(data)) {
        let temporary;
        try {
          if (scope) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            temporary = `${file}.${randomUUID()}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ scope, savedAt: now(), ...data }), { mode: 0o600 });
            fs.renameSync(temporary, file);
          }
        } catch { /* Cache persistence is best effort, live resolution still works. */ }
        finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
        return { ...result, serverPolls: data.serverPolls };
      }
      if (result.reason === 'unconfigured' || attempt === TARGET_FETCH_RETRIES) break;
      await sleepImpl(TARGET_FETCH_DELAY_MS);
    }
  }
  // Empty snapshots also retry; they must not erase the last useful snapshot.
  if (cache && nonempty(cache)) return { ok: false, ...cache, cached: true, reason: sanitizeReason(result.reason || 'beacons / poll 記録が空') };
  return { ...result, ...identities(result), reason: sanitizeReason(result.reason || '') };
}
