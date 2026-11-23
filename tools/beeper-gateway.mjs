#!/usr/bin/env node
// 000 の Beeper Desktop API（localhost:23373）を、社内LAN・Tailscale の他PCへ配る中継。
// - 公開インターネットには出さない: 接続元 IP を社内LAN/Tailscale/自PCに限る（Funnel では公開しない）。
// - Beeper 本体のトークンは 000 から外に出さない。他PCには中継専用トークンだけを配る（失効・再発行できる）。
// - 通すのは読み取りと「チャットへのテキスト送信」だけ。送信は各PCの beeper-send.mjs（receipt・送信前チェック）を通した前提で、
//   中継側でも 1チャット1時間3通・全体1時間20通の上限と送信ログ（本文は残さない）を持つ。
// - トークンの値は標準出力・ログ・例外に一切出さない。
//
// 使い方（000 で）:
//   node tools/beeper-gateway.mjs init-token   # 中継トークンを作る（既にあれば何もしない。値は表示しない）
//   node tools/beeper-gateway.mjs serve [--host 127.0.0.1 --port 23381]  # 中継を起動（既定 0.0.0.0:23380。LAN 側を python 転送にするときは 127.0.0.1:23381）
//   node tools/beeper-gateway.mjs check        # このPCから中継/ローカル経由で読み取り疎通を確認（送信しない）
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { getBeeperToken, getAccounts, beeperFetch, resolveBeeperTarget } from './beeper-api.mjs';

export const DEFAULT_PORT = 23380;
export const DEFAULT_ALLOWED_CIDRS = ['127.0.0.0/8', '192.168.0.0/24', '100.64.0.0/10'];
const MAX_BODY_BYTES = 64 * 1024;

export const ROUTES = [
  { method: 'POST', re: /^\/gateway\/attachment$/, kind: 'attachment' },
  { method: 'GET', re: /^\/v1\/accounts$/ },
  { method: 'GET', re: /^\/v1\/chats$/ },
  { method: 'GET', re: /^\/v1\/chats\/search$/ },
  { method: 'GET', re: /^\/v1\/chats\/[^/]+$/ },
  { method: 'GET', re: /^\/v1\/chats\/[^/]+\/messages$/ },
  { method: 'GET', re: /^\/v1\/chats\/[^/]+\/messages\/[^/]+$/ },
  { method: 'GET', re: /^\/v1\/messages\/search$/ },
  { method: 'POST', re: /^\/v1\/chats\/([^/]+)\/messages$/, kind: 'send' },
];

export function gatewayTokenPath(home = os.homedir()) {
  return path.join(home, '.claude', 'secrets', 'beeper-gateway-token.txt');
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function normalizeRemote(addr = '') {
  if (addr === '::1') return '127.0.0.1';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function ipAllowed(addr, cidrs = DEFAULT_ALLOWED_CIDRS) {
  const ip = ipv4ToInt(normalizeRemote(addr));
  if (ip === null) return false; // IPv6 は社内LANで使っていないので拒否
  return cidrs.some(c => {
    const [base, bitsStr] = c.split('/');
    const bits = Number(bitsStr);
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

export function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (m) return { kind: r.kind || 'read', chatID: m[1] ? decodeURIComponent(m[1]) : null };
  }
  return null;
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

export function tokenMatches(header, expected) {
  if (!expected || typeof header !== 'string') return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return crypto.timingSafeEqual(sha(m[1].trim()), sha(expected));
}

export function initToken(home = os.homedir()) {
  const p = gatewayTokenPath(home);
  if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim()) return { created: false, path: p };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, crypto.randomBytes(32).toString('base64url'), { encoding: 'utf8', mode: 0o600 });
  return { created: true, path: p };
}

function readJsonl(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

export function checkSendLimit({ chatID, logPath, now = Date.now(), perChat = 3, total = 20 }) {
  const recent = readJsonl(logPath).filter(e => e.kind === 'send' && e.status >= 200 && e.status < 300 && now - Date.parse(e.ts) < 3_600_000);
  if (recent.filter(e => e.chatID === chatID).length >= perChat) return 'このチャットへの中継送信上限（1時間3通）に達しました';
  if (recent.length >= total) return '中継の送信上限（1時間20通）に達しました';
  return null;
}

function appendLog(logPath, entry) {
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* ログ失敗で中継は止めない */ }
}

/**
 * @param {{ gatewayToken: string, upstreamBase?: string, getUpstreamToken?: () => string|null,
 *   allowedCidrs?: string[], logPath: string, readOnly?: boolean, fetchImpl?: typeof fetch }} opts
 */
export function createGatewayServer(opts) {
  const {
    gatewayToken, upstreamBase = 'http://127.0.0.1:23373', getUpstreamToken = () => getBeeperToken(),
    allowedCidrs = DEFAULT_ALLOWED_CIDRS, logPath, readOnly = false, fetchImpl = globalThis.fetch,
  } = opts;
  if (!gatewayToken) throw new Error('gateway token missing');

  return http.createServer(async (req, res) => {
    const ip = normalizeRemote(req.socket.remoteAddress);
    const url = new URL(req.url, 'http://gateway.local');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const log = (status, extra = {}) => appendLog(logPath, { ts: new Date().toISOString(), ip, method: req.method, path: url.pathname, status, ...extra });

    if (!ipAllowed(ip, allowedCidrs)) { log(403, { reason: 'ip' }); req.resume(); return send(403, { message: 'forbidden: network' }); }
    if (!tokenMatches(req.headers.authorization, gatewayToken)) { log(401, { reason: 'token' }); req.resume(); return send(401, { message: 'unauthorized' }); }
    if (url.pathname === '/gateway/health' && req.method === 'GET') { log(200); return send(200, { ok: true, readOnly }); }

    const route = matchRoute(req.method, url.pathname);
    if (!route) { log(404, { reason: 'route' }); req.resume(); return send(404, { message: 'route not allowed by gateway' }); }

    let body;
    if (req.method === 'POST') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY_BYTES) { log(413); return send(413, { message: 'body too large' }); } chunks.push(c); }
      body = Buffer.concat(chunks).toString('utf8');
    }

    if (route.kind === 'send') {
      if (readOnly) { log(403, { kind: 'send', reason: 'read-only' }); return send(403, { message: 'gateway is read-only' }); }
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { log(400); return send(400, { message: 'invalid json' }); }
      if (typeof parsed.text !== 'string' || !parsed.text.trim() || parsed.attachment) { log(400, { kind: 'send', reason: 'text-only' }); return send(400, { message: 'gateway sends text only' }); }
      const limit = checkSendLimit({ chatID: route.chatID, logPath });
      if (limit) { log(429, { kind: 'send', chatID: route.chatID }); return send(429, { message: limit }); }
    }

    const upstreamToken = getUpstreamToken();
    if (!upstreamToken) { log(502, { reason: 'beeper-token' }); return send(502, { message: 'Beeper on gateway host is not signed in' }); }
    if (route.kind === 'attachment') {
      let media;
      try { media = JSON.parse(body || '{}').url; } catch { /* rejected below */ }
      if (typeof media !== 'string' || !/^(?:local)?mxc:\/\/[^\s?#]+\/[^\s?#]+$/.test(media) || media.length > 2000) {
        log(400, { kind: 'attachment' }); return send(400, { message: 'Matrix media URL required' });
      }
      try {
        const base = upstreamBase.replace(/\/+$/, '');
        const headers = { Authorization: `Bearer ${upstreamToken}` };
        const downloaded = await fetchImpl(`${base}/v1/assets/download`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: media }), signal: AbortSignal.timeout(20000) });
        if (!downloaded.ok) throw new Error('download failed');
        const asset = await downloaded.json();
        if (asset.error || typeof asset.srcURL !== 'string') throw new Error('missing asset');
        const served = await fetchImpl(`${base}/v1/assets/serve?${new URLSearchParams({ url: asset.srcURL })}`, { headers, signal: AbortSignal.timeout(20000) });
        if (!served.ok) throw new Error('serve failed');
        // Only a URL returned by Beeper itself can reach assets/serve.
        const chunks = []; let size = 0;
        for await (const chunk of served.body) {
          size += chunk.length;
          if (size > 30 * 1024 * 1024) throw new Error('attachment too large');
          chunks.push(chunk);
        }
        log(200, { kind: 'attachment', bytes: size });
        res.writeHead(200, { 'Content-Type': served.headers.get('content-type') || 'application/octet-stream' });
        return res.end(Buffer.concat(chunks));
      } catch { log(502, { kind: 'attachment' }); return send(502, { message: 'Beeper attachment download failed' }); }
    }
    let up;
    try {
      up = await fetchImpl(`${upstreamBase.replace(/\/+$/, '')}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { Authorization: `Bearer ${upstreamToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body, signal: AbortSignal.timeout(20000),
      });
    } catch {
      log(502, { reason: 'beeper-down' }); return send(502, { message: 'Beeper Desktop on gateway host is down' });
    }
    const buf = Buffer.from(await up.arrayBuffer());
    log(up.status, route.kind === 'send' ? { kind: 'send', chatID: route.chatID, textLength: JSON.parse(body).text.length } : {});
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
    res.end(buf);
  });
}

async function check() {
  const target = resolveBeeperTarget();
  if (!target.token) { console.error('NG: Beeper のトークンも中継設定も見つかりません'); return 2; }
  console.log(`経路: ${target.via}（${target.baseUrl}）`);
  const acc = await getAccounts();
  const items = acc.items || acc;
  console.log('接続中ネットワーク:', items.map(a => a.network).join(', '));
  const q = process.argv[3] || '倉庫リーダー';
  const r = await beeperFetch('/v1/chats/search', { query: { query: q, limit: 5 } });
  for (const c of r.items || []) console.log(`- ${c.title}（${c.network}）${c.id}`);
  console.log('OK: 読み取りのみ。送信はしていません');
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const cmd = argv[0];
  if (cmd === 'init-token') {
    const r = initToken(home);
    console.log(r.created ? `作成しました（値は表示しません）: ${r.path}` : `既にあります（値は表示しません）: ${r.path}`);
    return 0;
  }
  if (cmd === 'serve') {
    const tokenFile = gatewayTokenPath(home);
    if (!fs.existsSync(tokenFile)) { console.error('中継トークンがありません。先に init-token を実行してください'); return 2; }
    const gatewayToken = fs.readFileSync(tokenFile, 'utf8').trim();
    const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
    const port = Number(arg('--port') || process.env.BEEPER_GATEWAY_PORT || DEFAULT_PORT);
    const host = arg('--host') || process.env.BEEPER_GATEWAY_HOST || '0.0.0.0';
    const cidrs = process.env.BEEPER_GATEWAY_CIDRS ? process.env.BEEPER_GATEWAY_CIDRS.split(',') : DEFAULT_ALLOWED_CIDRS;
    const logPath = path.join(home, '.claude', 'logs', 'beeper-gateway.jsonl');
    const server = createGatewayServer({ gatewayToken, allowedCidrs: cidrs, logPath, readOnly: process.env.BEEPER_GATEWAY_READONLY === '1' });
    await new Promise((resolve) => {
      server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.log('既に起動中です'); process.exit(0); } console.error(e.message); process.exit(1); });
      server.listen(port, host, resolve);
    });
    console.log(`Beeper 中継を起動しました: ${host}:${port}（許可: ${cidrs.join(', ')}）`);
    return new Promise(() => {});
  }
  if (cmd === 'check') return check();
  console.error('使い方: node tools/beeper-gateway.mjs init-token | serve [--host H --port P] | check [検索語]');
  return 1;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
