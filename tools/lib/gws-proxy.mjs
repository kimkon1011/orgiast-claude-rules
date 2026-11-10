// A routing marker, never a Google credential. Google tokens stay on memoryserve.
import fs from 'node:fs';
import os from 'node:os';
import { keyserveSecret, requireKeyservePcId, keyserveAuthHeaders } from '../keyserve-auth.mjs';

export const GWS_USER = 'seisaku-team@orgiast.jp';
export const GWS_MARKER = 'orgiast-server-side-gws';
export const GWS_KIM_MARKER = 'orgiast-server-side-gws-kim';
export function proxyCredential({ keyPath, impersonate, scope }) {
  if (keyPath && fs.existsSync(keyPath)) return null;
  if (![GWS_USER,'kim@orgiast.jp'].includes(impersonate)) throw Error('GWS proxy: unsupported subject');
  if (!String(scope).split(/\s+/).every(s => /^https:\/\/www\.googleapis\.com\/auth\/(drive|spreadsheets|calendar\.readonly|gmail\.(readonly|compose|send))$/.test(s))) throw Error('GWS proxy: unsupported scope');
  if (impersonate === 'kim@orgiast.jp' && scope !== 'https://www.googleapis.com/auth/calendar.readonly') throw Error('GWS proxy: kim is calendar-only');
  return impersonate === 'kim@orgiast.jp' ? GWS_KIM_MARKER : GWS_MARKER;
}
export async function channelRequest(route, { query, body, home = process.env.ORGIAST_HOME || os.homedir(), env = process.env, fetchImpl = globalThis.fetch, signal } = {}) {
  const secret = keyserveSecret(home, env);
  if (!secret) throw Error('GWS/LINE: keyserve enrollment credential missing');
  const base = env.ORGIAST_CHANNEL_BASE_URL || 'https://orgiast-memoryserve.vercel.app';
  const url = new URL(`/api/${route}`, base);
  if (url.protocol !== 'https:') throw Error('channel API requires HTTPS');
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const response = await fetchImpl(url.href, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: signal || AbortSignal.timeout(30000),
    headers: { ...keyserveAuthHeaders(secret, Date.now(), requireKeyservePcId(home, env)), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw Error(`channel ${route}: HTTP ${response.status}`);
  return response.json();
}
export function googleRoute(raw, marker = GWS_MARKER) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw Error('invalid Google URL');
  if (url.hostname === 'gmail.googleapis.com') return { service: 'gmail', path: url.pathname + url.search };
  if (url.hostname === 'www.googleapis.com' && /^\/(?:upload\/)?drive\//.test(url.pathname)) return { service: 'drive', path: url.pathname + url.search };
  if (url.hostname === 'sheets.googleapis.com') return { service: 'sheets', path: url.pathname + url.search };
  if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/calendar/v3/')) return { service: marker === GWS_KIM_MARKER ? 'calendar-kim' : 'calendar', path: url.pathname + url.search };
  throw Error('GWS proxy: unsupported Google endpoint');
}
export async function gwsFetch(url, options = {}, dependencies = {}) {
  const headers = new Headers(options.headers);
  const marker = headers.get('authorization')?.replace(/^Bearer /,'');
  if (![GWS_MARKER,GWS_KIM_MARKER].includes(marker)) return (dependencies.fetchImpl || globalThis.fetch)(url, options);
  const route = googleRoute(url, marker), method = options.method || 'GET';
  const request = dependencies.request || channelRequest;
  const result = await request('gws', { ...dependencies, signal: options.signal,
    ...(method === 'GET' ? { query: route } : { body: { ...route, method,
      contentType: headers.get('content-type') || '', body: Buffer.from(options.body || '').toString('base64'),
      dryRun: headers.get('x-orgiast-dry-run') === 'true' } }) });
  if (!Number.isInteger(result.status) || typeof result.body !== 'string') throw Error('GWS proxy: invalid response');
  return new Response([204, 304].includes(result.status) ? null : Buffer.from(result.body, 'base64'),
    { status: result.status, headers: { 'Content-Type': result.contentType || 'application/json' } });
}
