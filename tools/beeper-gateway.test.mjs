import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ipAllowed, matchRoute, tokenMatches, checkSendLimit, createGatewayServer, initToken, gatewayTokenPath } from './beeper-gateway.mjs';
import { resolveBeeperTarget, getGatewayConfig } from './beeper-api.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-gw-test-'));

test('ipAllowed: 社内LAN・Tailscale・自PCだけ通す', () => {
  assert.equal(ipAllowed('192.168.0.2'), true);
  assert.equal(ipAllowed('::ffff:192.168.0.24'), true);
  assert.equal(ipAllowed('100.73.174.121'), true);
  assert.equal(ipAllowed('127.0.0.1'), true);
  assert.equal(ipAllowed('::1'), true);
  assert.equal(ipAllowed('192.168.1.5'), false);
  assert.equal(ipAllowed('8.8.8.8'), false);
  assert.equal(ipAllowed('fe80::1'), false);
});

test('matchRoute: 読み取りとテキスト送信だけ', () => {
  assert.deepEqual(matchRoute('GET', '/v1/chats'), { kind: 'read', chatID: null });
  assert.equal(matchRoute('GET', '/v1/chats/search').kind, 'read');
  assert.deepEqual(matchRoute('POST', '/v1/chats/!abc%3Abeeper.local/messages'), { kind: 'send', chatID: '!abc:beeper.local' });
  assert.equal(matchRoute('POST', '/v1/assets/download'), null);
  assert.equal(matchRoute('DELETE', '/v1/chats/x'), null);
  assert.equal(matchRoute('POST', '/v1/chats'), null);
});

test('tokenMatches', () => {
  assert.equal(tokenMatches('Bearer abc', 'abc'), true);
  assert.equal(tokenMatches('Bearer abd', 'abc'), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
  assert.equal(tokenMatches('Bearer abc', ''), false);
});

test('initToken は値を返さず、既存を上書きしない', () => {
  const home = tmp();
  const r1 = initToken(home);
  assert.equal(r1.created, true);
  assert.equal('token' in r1, false);
  const v = fs.readFileSync(gatewayTokenPath(home), 'utf8');
  assert.ok(v.length >= 40);
  assert.equal(initToken(home).created, false);
  assert.equal(fs.readFileSync(gatewayTokenPath(home), 'utf8'), v);
});

test('checkSendLimit: 1チャット1時間3通', () => {
  const dir = tmp();
  const logPath = path.join(dir, 'log.jsonl');
  const now = Date.now();
  const line = (chatID) => JSON.stringify({ ts: new Date(now - 1000).toISOString(), kind: 'send', chatID, status: 200 });
  fs.writeFileSync(logPath, [line('a'), line('a'), line('a')].join('\n') + '\n');
  assert.match(checkSendLimit({ chatID: 'a', logPath, now }), /3通/);
  assert.equal(checkSendLimit({ chatID: 'b', logPath, now }), null);
});

async function withGateway(fn, { readOnly = false, cidrs } = {}) {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? { pendingMessageID: 'p1', chatID: 'c' } : { items: [{ id: 'c1', title: '倉庫' }] }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = tmp();
  const gw = createGatewayServer({
    gatewayToken: 'gw-secret', upstreamBase: `http://127.0.0.1:${upstream.address().port}`,
    getUpstreamToken: () => 'beeper-secret', logPath: path.join(dir, 'gw.jsonl'), readOnly, allowedCidrs: cidrs,
  });
  await new Promise(r => gw.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gw.address().port}`;
  try { await fn({ base, calls, logPath: path.join(dir, 'gw.jsonl') }); } finally { gw.close(); upstream.close(); }
}

test('中継: トークンなしは 401、上流トークンは中継だけが付ける', async () => {
  await withGateway(async ({ base, calls, logPath }) => {
    assert.equal((await fetch(`${base}/v1/chats`)).status, 401);
    const ok = await fetch(`${base}/v1/chats/search?query=x`, { headers: { Authorization: 'Bearer gw-secret' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).items[0].title, '倉庫');
    assert.equal(calls[0].auth, 'Bearer beeper-secret');
    assert.equal(calls[0].url, '/v1/chats/search?query=x');
    const log = fs.readFileSync(logPath, 'utf8');
    assert.equal(log.includes('gw-secret'), false);
    assert.equal(log.includes('beeper-secret'), false);
  });
});

test('中継: 許可外ルート・許可外ネットワーク・読み取り専用', async () => {
  await withGateway(async ({ base, calls }) => {
    const h = { Authorization: 'Bearer gw-secret' };
    assert.equal((await fetch(`${base}/v1/assets/serve?url=x`, { headers: h })).status, 404);
    assert.equal((await fetch(`${base}/v1/chats/c/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'hi' }) })).status, 403);
    assert.equal(calls.length, 0);
  }, { readOnly: true });
  await withGateway(async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/chats`, { headers: { Authorization: 'Bearer gw-secret' } })).status, 403);
  }, { cidrs: ['192.168.0.0/24'] });
});

test('中継: 送信はテキストのみ・本文はログに残さない・上限で429', async () => {
  await withGateway(async ({ base, calls, logPath }) => {
    const h = { Authorization: 'Bearer gw-secret', 'Content-Type': 'application/json' };
    const post = (b) => fetch(`${base}/v1/chats/c/messages`, { method: 'POST', headers: h, body: JSON.stringify(b) });
    assert.equal((await post({ text: '' })).status, 400);
    assert.equal((await post({ text: 'x', attachment: { uploadID: 'u' } })).status, 400);
    for (let i = 0; i < 3; i++) assert.equal((await post({ text: `本文${i}` })).status, 200);
    assert.equal((await post({ text: '4通目' })).status, 429);
    assert.equal(calls.length, 3);
    assert.equal(fs.readFileSync(logPath, 'utf8').includes('本文'), false);
  });
});

test('resolveBeeperTarget: ローカル Beeper がなければ中継設定を使う', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'gw.json');
  fs.writeFileSync(cfg, JSON.stringify({ base: 'http://192.168.0.4:23380', token: 't' }));
  const noLocal = path.join(dir, 'noappdata');
  const t = resolveBeeperTarget({ env: { BEEPER_GATEWAY_CONFIG: cfg }, appData: noLocal });
  assert.equal(t.via, 'gateway');
  assert.equal(t.baseUrl, 'http://192.168.0.4:23380');
  const t2 = resolveBeeperTarget({ env: { BEEPER_GATEWAY_CONFIG: cfg, BEEPER_ACCESS_TOKEN: 'L' }, appData: noLocal });
  assert.equal(t2.via, 'local');
  const t3 = resolveBeeperTarget({ env: { BEEPER_GATEWAY_CONFIG: cfg, BEEPER_ACCESS_TOKEN: 'L', BEEPER_VIA_GATEWAY: '1' }, appData: noLocal });
  assert.equal(t3.via, 'gateway');
  assert.equal(resolveBeeperTarget({ env: {}, appData: noLocal }).via, 'none');
  assert.equal(getGatewayConfig({ env: {} }), null);
});
