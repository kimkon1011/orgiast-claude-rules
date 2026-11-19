#!/usr/bin/env node
import { keyserveSecret, requireKeyservePcId, keyserveAuthHeaders } from './keyserve-auth.mjs';
import { homedir } from 'node:os';

const home = homedir();
const secret = keyserveSecret(home, process.env);
const pcId = requireKeyservePcId(home, process.env);
const now = Date.now();
const headers = keyserveAuthHeaders(secret, now, pcId);

const fileId = '11RMY1AqpIYsmMU1AllgB6fspiYdrc9E-_m5A1UW8m70';
const base = process.env.ORGIAST_CHANNEL_BASE_URL || 'https://orgiast-memoryserve.vercel.app';

async function test(query) {
  const url = new URL('/api/gws', base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await fetch(url.href, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  console.log(`GET ${query.service}/${query.path?.slice(0,60)} → ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, body: text };
}

async function main() {
  // 1) Simple drive files get (file metadata only, lightest request)
  await test({
    service: 'drive',
    path: `/drive/v3/files/${fileId}?supportsAllDrives=true&fields=id,name`,
  });

  // 2) Permissions list
  await test({
    service: 'drive',
    path: `/drive/v3/files/${fileId}/permissions?supportsAllDrives=true&fields=permissions(id,type,emailAddress,role)&pageSize=100`,
  });
}

await main();