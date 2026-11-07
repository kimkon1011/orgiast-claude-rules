import { Resolver } from 'node:dns/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function extractEmails(text) {
  return [...new Set((String(text).match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi) ?? []).map(s => s.toLowerCase()))];
}
export function isInternalDomain(domain) {
  return /^(?:.*\.)?orgiast\.jp$/i.test(domain);
}
const absent = code => ['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NODATA', 'DNS_ENOTFOUND', 'DNS_ENODATA'].includes(code);
const nonexistent = code => ['ENOTFOUND', 'NXDOMAIN', 'DNS_ENOTFOUND'].includes(code);
const DAY = 86400000;

export async function checkDomains(domains, { resolver, cachePath = path.join(os.homedir(), '.claude', 'mail-domain-cache.json'), now = Date.now(), signal, timeoutMs = 5000 } = {}) {
  const timestamp = typeof now === 'function' ? now() : now;
  let cache = {};
  if (cachePath) try { cache = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch {}
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  const names = [...new Set(domains.map(d => String(d).trim().toLowerCase().replace(/\.$/, '')).filter(d => d && !isInternalDomain(d)))];
  const results = new Array(names.length);
  let cursor = 0;
  async function inspect(domain) {
    if (Object.hasOwn(cache, domain) && Number.isFinite(cache[domain]) && timestamp >= cache[domain] && timestamp - cache[domain] < 7 * DAY) return { status: 'ok', domain, cached: true };
    const dns = resolver ?? new Resolver();
    let timer, abort;
    const query = async method => {
      try { return { records: await dns[method](domain) }; }
      catch (error) { return { records: [], code: error.code || error.message }; }
    };
    const work = async () => {
      const mx = await query('resolveMx');
      if (mx.records.length) return { status: 'ok', domain };
      if (mx.code && !absent(mx.code)) return { status: 'unknown', domain, reason: mx.code };
      const addresses = await Promise.all([query('resolve4'), query('resolve6')]);
      if (addresses.some(r => r.records.length)) return { status: 'ok', domain };
      const failure = addresses.find(r => r.code && !absent(r.code));
      if (failure) return { status: 'unknown', domain, reason: failure.code };
      return { status: 'bad', domain, reason: nonexistent(mx.code) && addresses.every(r => nonexistent(r.code)) ? 'ドメインが存在しない' : 'MX も A も無い（AAAA も無し）' };
    };
    try {
      return await Promise.race([work(), new Promise(resolve => {
        abort = () => { resolve({ status: 'unknown', domain, reason: 'DNS タイムアウト' }); if (!resolver) dns.cancel(); };
        timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
    while (cursor < names.length) {
      const i = cursor++;
      results[i] = signal?.aborted ? { status: 'unknown', domain: names[i], reason: 'hook タイムアウト' } : await inspect(names[i]);
    }
  }));
  const result = { ok: [], bad: [], unknown: [] };
  for (const { status, domain, reason, cached } of results) {
    result[status].push(status === 'ok' ? domain : { domain, reason });
    if (status === 'ok' && !cached) cache[domain] = timestamp;
  }
  // Cache failures never change a DNS verdict; expired and negative entries are not retained.
  if (cachePath && result.ok.length && !signal?.aborted) try {
    const valid = Object.fromEntries(Object.entries(cache).filter(([, t]) => Number.isFinite(t) && timestamp >= t && timestamp - t < 7 * DAY));
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(valid));
  } catch {}
  return result;
}
