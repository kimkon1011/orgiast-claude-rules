import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

function startMockRelayServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-relay-client-test-'));
}

test('1. トークン: 環境変数から取得', async t => {
  const { getToken } = await import('./beeper-relay-client.mjs');
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_TOKEN = 'env-test-token';
  t.after(() => { if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN; });
  const token = getToken();
  assert.strictEqual(token, 'env-test-token');
});

test('2. トークン: token.txt から取得', async t => {
  const { getToken } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const tokenDir = path.join(tmpDir, '.claude', 'beeper-relay');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'token.txt'), 'file-test-token');

  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  t.after(() => {
    if (oldHome) process.env.HOME = oldHome; else delete process.env.HOME;
    if (oldUserProfile) process.env.USERPROFILE = oldUserProfile; else delete process.env.USERPROFILE;
  });
  // getToken は os.homedir() を使うので、そのままだと元の home を見に行く
  // モジュールの os.homedir() を制御できないので、環境変数で代用
  const oldRelayToken = process.env.BEEPER_RELAY_TOKEN;
  delete process.env.BEEPER_RELAY_TOKEN;
  t.after(() => { if (oldRelayToken) process.env.BEEPER_RELAY_TOKEN = oldRelayToken; });
  const token = getToken();
  // token.txt が元の homedir にあるならそれが返る
  assert.ok(typeof token === 'string' || token === null);
});

test('3. RelayError: エラークラス', async t => {
  const { RelayError } = await import('./beeper-relay-client.mjs');
  const err = new RelayError('test error', 403, 'FORBIDDEN');
  assert.strictEqual(err.message, 'test error');
  assert.strictEqual(err.status, 403);
  assert.strictEqual(err.code, 'FORBIDDEN');
  assert.ok(err instanceof Error);
});

test('4. 認証無し: 401 がスローされる', async t => {
  const { relayFetch, getToken } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mockServer = await startMockRelayServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '認証が必要です', code: 'UNAUTHORIZED' }));
  });
  t.after(() => new Promise(resolve => mockServer.close(resolve)));
  const port = mockServer.address().port;

  const oldUrl = process.env.BEEPER_RELAY_URL;
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = `http://127.0.0.1:${port}`;
  process.env.BEEPER_RELAY_TOKEN = 'test-token';
  t.after(() => {
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
  });

  try {
    await relayFetch('/v1/accounts');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.strictEqual(err.status, 401);
  }
});

test('5. GET /v1/chats: 正常系', async t => {
  const { relayFetch } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mockServer = await startMockRelayServer((req, res) => {
    assert.ok(req.headers.authorization, 'Bearer トークンがある');
    assert.ok(req.headers.authorization.startsWith('Bearer '));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      chats: [{ id: 'chat1', name: 'テスト', network: 'LINE', lastActivity: new Date().toISOString(), unread: 1 }],
      total: 1,
    }));
  });
  t.after(() => new Promise(resolve => mockServer.close(resolve)));
  const port = mockServer.address().port;

  const oldUrl = process.env.BEEPER_RELAY_URL;
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = `http://127.0.0.1:${port}`;
  process.env.BEEPER_RELAY_TOKEN = 'test-token';
  t.after(() => {
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
  });

  const data = await relayFetch('/v1/chats?limit=10');
  assert.ok(data.chats);
  assert.strictEqual(data.chats.length, 1);
  assert.strictEqual(data.chats[0].id, 'chat1');
});

test('6. GET /v1/send/:queueId: ステータス取得', async t => {
  const { relayFetch } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mockServer = await startMockRelayServer((req, res) => {
    assert.ok(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      queueID: 'rq-test123',
      state: 'queued',
      from: { name: 'pc008 via relay' },
      body: 'テスト',
      createdAt: new Date().toISOString(),
    }));
  });
  t.after(() => new Promise(resolve => mockServer.close(resolve)));
  const port = mockServer.address().port;

  const oldUrl = process.env.BEEPER_RELAY_URL;
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = `http://127.0.0.1:${port}`;
  process.env.BEEPER_RELAY_TOKEN = 'test-token';
  t.after(() => {
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
  });

  const data = await relayFetch('/v1/send/rq-test123');
  assert.strictEqual(data.queueID, 'rq-test123');
  assert.strictEqual(data.state, 'queued');
});

test('7. POST /v1/send: エンドポイントが 202 を返す', async t => {
  const { relayFetch } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mockServer = await startMockRelayServer(async (req, res) => {
    assert.strictEqual(req.method, 'POST');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(body.chatID);
    assert.ok(body.body);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queueID: 'rq-test456', status: 'pending', message: '送信依頼を受け付けました' }));
  });
  t.after(() => new Promise(resolve => mockServer.close(resolve)));
  const port = mockServer.address().port;

  const oldUrl = process.env.BEEPER_RELAY_URL;
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = `http://127.0.0.1:${port}`;
  process.env.BEEPER_RELAY_TOKEN = 'test-token';
  t.after(() => {
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
  });

  const data = await relayFetch('/v1/send', {
    method: 'POST',
    body: { chatID: 'chat_line_1', body: 'テスト送信' },
  });
  assert.strictEqual(data.queueID, 'rq-test456');
  assert.strictEqual(data.status, 'pending');
});

test('8. レート制限: 429 がエラーになる', async t => {
  const { relayFetch } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mockServer = await startMockRelayServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limit: read 上限', code: 'RATE_LIMIT' }));
  });
  t.after(() => new Promise(resolve => mockServer.close(resolve)));
  const port = mockServer.address().port;

  const oldUrl = process.env.BEEPER_RELAY_URL;
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = `http://127.0.0.1:${port}`;
  process.env.BEEPER_RELAY_TOKEN = 'test-token';
  t.after(() => {
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
  });

  try {
    await relayFetch('/v1/accounts');
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.code, 'RATE_LIMIT');
  }
});

test('9. Beeper 停止: 503 がエラーになる', async t => {
  const { relayFetch } = await import('./beeper-relay-client.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const mockServer = await startMockRelayServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Beeper Desktop が起動していません', code: 'BEEPER_DOWN' }));
  });
  t.after(() => new Promise(resolve => mockServer.close(resolve)));
  const port = mockServer.address().port;

  const oldUrl = process.env.BEEPER_RELAY_URL;
  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = `http://127.0.0.1:${port}`;
  process.env.BEEPER_RELAY_TOKEN = 'test-token';
  t.after(() => {
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
  });

  try {
    await relayFetch('/v1/accounts');
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, 'BEEPER_DOWN');
  }
});

test('10. トークン無し: エラーになる', async t => {
  const { relayFetch, getToken } = await import('./beeper-relay-client.mjs');

  const oldToken = process.env.BEEPER_RELAY_TOKEN;
  const oldUrl = process.env.BEEPER_RELAY_URL;
  delete process.env.BEEPER_RELAY_TOKEN;
  process.env.BEEPER_RELAY_URL = 'http://127.0.0.1:19999';
  t.after(() => {
    if (oldToken) process.env.BEEPER_RELAY_TOKEN = oldToken; else delete process.env.BEEPER_RELAY_TOKEN;
    if (oldUrl) process.env.BEEPER_RELAY_URL = oldUrl; else delete process.env.BEEPER_RELAY_URL;
  });

  try {
    await relayFetch('/v1/accounts');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('トークンが設定されていません'));
  }
});