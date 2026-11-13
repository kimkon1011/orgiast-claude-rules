import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { BeeperApiError, getBeeperToken, beeperFetch, getAccounts, listChats, listMessages, sendMessage } from './beeper-api.mjs';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-api-test-'));
}

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

const MOCK_ACCOUNTS = [
  { accountID: 'matrix', network: 'Beeper', bridge: { id: 'matrix' }, user: { id: '@kim:beeper.com', isSelf: true }, status: 'connected' },
  { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@line_kim:localhost', isSelf: false }, status: 'connected' },
  { accountID: 'discordgo', network: 'Discord', bridge: { id: 'discordgo' }, user: { id: '@discord_kim:localhost', isSelf: false }, status: 'connected' },
];

const MOCK_CHATS = {
  items: [
    { id: '!line_1:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: new Date().toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    { id: '!line_2:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: new Date().toISOString(), unreadCount: 0, isMuted: true, isArchived: false, isLowPriority: false, isReadOnly: false },
  ],
  hasMore: false,
  oldestCursor: null,
  newestCursor: null,
};

const MOCK_MESSAGES = {
  items: [
    { id: '101', chatID: '!line_1:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '相手A', timestamp: new Date(Date.now() - 3600000).toISOString(), type: 'TEXT', text: 'よろしくお願いします', isSender: false },
    { id: '102', chatID: '!line_1:localhost', accountID: 'line', senderID: '@kim:localhost', senderName: 'Kim', timestamp: new Date(Date.now() - 1800000).toISOString(), type: 'TEXT', text: 'こちらこそ', isSender: true },
  ],
  hasMore: false,
  oldestCursor: null,
  newestCursor: null,
};

test('1. トークン: 環境変数 BEEPER_ACCESS_TOKEN から取得', async t => {
  const token = 'env-token-test';
  const result = getBeeperToken({ env: { BEEPER_ACCESS_TOKEN: token } });
  assert.strictEqual(result, token);
});

test('2. トークン: account.db から取得', async t => {
  const dir = createTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbDir = path.join(dir, 'BeeperTexts');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'account.db'));
  db.exec('CREATE TABLE account (access_token TEXT)');
  db.prepare('INSERT INTO account (access_token) VALUES (?)').get('db-token-value');
  db.close();
  const result = getBeeperToken({ env: {}, appData: dir });
  assert.strictEqual(result, 'db-token-value');
});

test('3. トークン: どちらもなければ null', async t => {
  const dir = createTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = getBeeperToken({ env: {}, appData: dir });
  assert.strictEqual(result, null);
});

test('4. トークンがログに出ない: BeeperApiError の message に含まれない', async t => {
  // モックサーバーで 401 を返し、エラーメッセージにトークンが含まれないことを確認
  const server = await startMockServer((req, res) => {
    // auth header を読んでみるがエラーには含めない
    const auth = req.headers.authorization || '';
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'unauthorized' }));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  try {
    await beeperFetch('/v1/accounts', {
      env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'super-secret-token' },
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert(err instanceof BeeperApiError);
    assert.equal(err.message.includes('super-secret-token'), false, 'トークンがエラーメッセージに含まれている');
    assert.equal(err.code, 'BEEPER_UNAUTHORIZED');
  }
});

test('5. getAccounts: 正常系', async t => {
  const server = await startMockServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/accounts');
    assert.ok(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_ACCOUNTS));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await getAccounts({
    env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'test' },
    fetchImpl: globalThis.fetch,
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].accountID, 'matrix');
});

test('6. listChats: 正常系（クエリパラメータつき）', async t => {
  let queryReceived = '';
  const server = await startMockServer((req, res) => {
    queryReceived = req.url || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_CHATS));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await listChats({ limit: 50, accountIDs: ['line'] }, {
    env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'test' },
  });
  assert.ok(queryReceived.includes('limit=50'));
  assert.ok(queryReceived.includes('accountIDs=line'));
});

test('7. listMessages: 正常系', async t => {
  const server = await startMockServer((req, res) => {
    assert.ok(req.url.startsWith('/v1/chats/'));
    assert.ok(decodeURIComponent(req.url).includes('!line_1:localhost'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_MESSAGES));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await listMessages('!line_1:localhost', { limit: 50 }, {
    env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'test' },
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, '101');
});

test('8. sendMessage: 正常系', async t => {
  let requestBody = null;
  const server = await startMockServer((req, res) => {
    assert.equal(req.method, 'POST');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chatID: '!line_1:localhost', pendingMessageID: 'pending-123' }));
    });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await sendMessage('!line_1:localhost', 'こんにちは', { replyToMessageID: '101' }, {
    env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'test' },
  });
  assert.equal(requestBody.text, 'こんにちは');
  assert.equal(requestBody.replyToMessageID, '101');
  assert.equal(result.pendingMessageID, 'pending-123');
});

test('9. 401 エラー: code = BEEPER_UNAUTHORIZED', async t => {
  const server = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'unauthorized' }));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  try {
    await getAccounts({
      env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'bad' },
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert(err instanceof BeeperApiError);
    assert.equal(err.code, 'BEEPER_UNAUTHORIZED');
  }
});

test('10. 接続不能: code = BEEPER_DOWN', async t => {
  const port = 19999; // 使われていないポート
  try {
    await getAccounts({
      env: { BEEPER_API_BASE: `http://127.0.0.1:${port}`, BEEPER_ACCESS_TOKEN: 'test' },
      timeoutMs: 500,
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert(err instanceof BeeperApiError);
    assert.equal(err.code, 'BEEPER_DOWN');
  }
});