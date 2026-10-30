import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

// Same HMAC wire contract as tools/keyserve-auth.mjs; standalone installer bundle.
export async function secrets(fetcher = fetch, env = process.env) {
  let saved = {};
  try { saved = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.claude/keyserve.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const secret = env.ORGIAST_KEYSERVE_SECRET || saved.ORGIAST_KEYSERVE_SECRET;
  const pc = env.ORGIAST_KEYSERVE_PC || saved.ORGIAST_KEYSERVE_PC || os.hostname();
  if (!secret || !/^[A-Za-z0-9._-]{1,64}$/.test(pc)) throw new Error('keyserve enrollment required');
  const url = env.ORGIAST_KEYSERVE_URL || 'https://orgiast-keyserve.vercel.app/api/keys';
  if (new URL(url).protocol !== 'https:') throw new Error('keyserve requires HTTPS');
  const ts = Math.floor(Date.now() / 1000).toString();
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
    'x-orgiast-ts': ts, 'x-orgiast-auth': createHmac('sha256', secret).update(ts).digest('hex'), 'x-orgiast-pc': pc,
  } });
  if (!response.ok) throw new Error(`keyserve HTTP ${response.status}`);
  const payload = await response.json();
  const data = JSON.parse(payload.files?.['r640.json'] ?? '{}');
  if (!Object.keys(data).length) throw new Error('keyserve r640.json missing');
  return data;
}
