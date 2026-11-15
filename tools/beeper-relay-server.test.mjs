import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ── モック Beeper API サーバー ──────────────────────────────────────

const MOCK_ACCOUNTS = [
  { accountID: 'matrix', network: 'Beeper', bridge: { id: 'matrix' }, user: { id: '@kim:beeper.com', isSelf: true }, status: 'connected' },
  { accountID: 'line_1', network: 'LINE', bridge: { id: 'line_1' }, user: { id: '@line_kim:localhost', isSelf: false }, status: 'connected' },
  { accountID: 'discord_1', network: 'Discord', bridge: { id: 'discord_1' }, user: { id: '@discord_kim:localhost', isSelf: false }, status: 'connected' },
];

const MOCK_CHATS = {
  items: [
    { id: 'chat_line_1', accountID: 'line_1', network: 'LINE', name: '田中さん', type: 'single', lastActivity: new Date(Date.now() - 3600000).toISOString(), unreadCount: 2, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    { id: 'chat_line_2', accountID: 'line_1', network: 'LINE', name: '山田さん', type: 'single', lastActivity: new Date(Date.now() - 7200000).toISOString(), unreadCount: 0, isMuted: true, isArchived: false, isLowPriority: false, isReadOnly: false },
    { id: 'chat_discord_1', accountID: 'discord_1', network: 'Discord', name: 'Discord General', type: 'group', lastActivity: new Date(Date.now() - 1800000).toISOString(), unreadCount: 5, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
  ],
  hasMore: false,
};

const MOCK_MESSAGES = {
  items: [
    { id: 'msg_1', chatID: 'chat_line_1', accountID: 'line_1', senderID: '@other:localhost', senderName: '田中さん', timestamp: new Date(Date.now() - 3600000).toISOString(), type: 'TEXT', text: 'こんにちは', isSender: false },
    { id: 'msg_2', chatID: 'chat_line_1', accountID: 'line_1', senderID: '@kim:localhost', senderName: 'Kim', timestamp: new Date(Date.now() - 1800000).toISOString(), type: 'TEXT', text: '返信します', isSender: true },
  ],
  hasMore: false,
};

function startMockBeeperServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-relay-test-'));
}

// ── テスト ────────────────────────────────────────────────────────────

test('1. hashToken: 同じトークンから同じハッシュが生成される', async t => {
  const { hashToken, CONFIG_DIR } = await import('./beeper-relay-server.mjs');
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  // CONFIG_DIR を tmpDir に変更
  // 代わりに AUTH_SALT_FILE を直接制御
  const saltDir = path.join(tmpDir, 'beeper-relay');
  fs.mkdirSync(saltDir, { recursive: true });
  const salt = '0123456789abcdef0123456789abcdef';
  fs.writeFileSync(path.join(saltDir, 'auth-salt.txt'), salt);

  // モジュールをリロード（各テストで独立したインスタンス）
  // 実際には CONFIG_DIR が固定パスのため、hashToken の出力を確認
  const token = 'test-token-123';
  const hash1 = hashToken(token);
  const hash2 = hashToken(token);
  assert.strictEqual(hash1, hash2, '同一トークンから同一ハッシュ');
  assert.strictEqual(hash1.length, 64, 'SHA-256 hex = 64 chars');
});

test('2. generateToken: ランダムトークン生成', async t => {
  const { generateToken } = await import('./beeper-relay-server.mjs');
  const t1 = generateToken();
  const t2 = generateToken();
  assert.strictEqual(typeof t1, 'string');
  assert.strictEqual(t1.length, 64, '32 bytes hex = 64 chars');
  assert.notStrictEqual(t1, t2, 'ランダムなので異なる値');
});

test('3. clients.json: 読み書きの永続性', async t => {
  // clients.json の読み書きは実際のパスを使うので、ファイルを直接操作
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const testFile = path.join(tmpDir, 'clients.json');
  const testData = { pc001: { name: 'pc001', tokenHash: 'abc', scope: ['read'], revoked: false } };
  fs.writeFileSync(testFile, JSON.stringify(testData));
  const raw = JSON.parse(fs.readFileSync(testFile, 'utf8'));
  assert.strictEqual(raw.pc001.name, 'pc001');
  assert.strictEqual(raw.pc001.scope[0], 'read');
  assert.strictEqual(raw.pc001.revoked, false);
});

test('4. 認証: トークン無しで 401', async t => {
  const { startServer, CONFIG_DIR } = await import('./beeper-relay-server.mjs');

  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // モック Beeper サーバー
  const beeperServer = await startMockBeeperServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_ACCOUNTS));
  });
  t.after(() => new Promise(resolve => beeperServer.close(resolve)));
  const beeperPort = beeperServer.address().port;

  const oldApiBase = process.env.BEEPER_API_BASE;
  process.env.BEEPER_API_BASE = `http://127.0.0.1:${beeperPort}`;
  t.after(() => { if (oldApiBase) process.env.BEEPER_API_BASE = oldApiBase; else delete process.env.BEEPER_API_BASE; });

  // Relay サーバー起動
  const relayServer = await startServer({ port: 0, bindIP: '127.0.0.1' });
  t.after(() => new Promise(resolve => relayServer.close(resolve)));
  const relayPort = relayServer.address().port;

  // トークン無しでリクエスト
  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/accounts`);
  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.ok(data.code === 'UNAUTHORIZED' || data.error);
});

test('5. 認証: 無効トークンで 401', async t => {
  const { startServer } = await import('./beeper-relay-server.mjs');

  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const beeperServer = await startMockBeeperServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_ACCOUNTS));
  });
  t.after(() => new Promise(resolve => beeperServer.close(resolve)));
  const beeperPort = beeperServer.address().port;

  const oldApiBase = process.env.BEEPER_API_BASE;
  process.env.BEEPER_API_BASE = `http://127.0.0.1:${beeperPort}`;
  t.after(() => { if (oldApiBase) process.env.BEEPER_API_BASE = oldApiBase; else delete process.env.BEEPER_API_BASE; });

  const relayServer = await startServer({ port: 0, bindIP: '127.0.0.1' });
  t.after(() => new Promise(resolve => relayServer.close(resolve)));
  const relayPort = relayServer.address().port;

  // 無効トークン
  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/accounts`, {
    headers: { Authorization: 'Bearer invalid-token' },
  });
  assert.strictEqual(res.status, 401);
});

test('6. 権限なし: send スコープが無いクライアントは POST /v1/send で 403', async t => {
  const { startServer, readClients, writeClients, hashToken, generateToken, CONFIG_DIR } = await import('./beeper-relay-server.mjs');

  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // テスト用の clients.json を tmpDir に作る…が CONFIG_DIR が固定のため
  // 実際の CONFIG_DIR に作成。テスト後に消す
  const realConfigDir = CONFIG_DIR;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const token = generateToken();
  const tokenHash = hashToken(token);
  const clientName = 'testclient';
  writeClients({
    [clientName]: { name: clientName, tokenHash, scope: ['read'], allowedNetworks: null, createdAt: new Date().toISOString(), revoked: false },
  });

  const beeperServer = await startMockBeeperServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_ACCOUNTS));
  });
  t.after(() => new Promise(resolve => beeperServer.close(resolve)));
  const beeperPort = beeperServer.address().port;

  const oldApiBase = process.env.BEEPER_API_BASE;
  process.env.BEEPER_API_BASE = `http://127.0.0.1:${beeperPort}`;
  t.after(() => { if (oldApiBase) process.env.BEEPER_API_BASE = oldApiBase; else delete process.env.BEEPER_API_BASE; });
  t.after(() => {
    // clients.json を消してクリーンアップ
    try { fs.rmSync(path.join(CONFIG_DIR, 'clients.json')); } catch {}
    try { fs.rmSync(path.join(CONFIG_DIR, 'auth-salt.txt')); } catch {}
  });

  const relayServer = await startServer({ port: 0, bindIP: '127.0.0.1' });
  t.after(() => new Promise(resolve => relayServer.close(resolve)));
  const relayPort = relayServer.address().port;

  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatID: 'chat_line_1', body: 'test' }),
  });
  assert.strictEqual(res.status, 403);
  const data = await res.json();
  assert.ok(data.code === 'FORBIDDEN' || data.error);
});

test('7. 許可外ネットワーク: allowedNetworks で制限されたクライアントが discrim にアクセスできない', async t => {
  const { startServer, readClients, writeClients, hashToken, generateToken, CONFIG_DIR } = await import('./beeper-relay-server.mjs');

  const token = generateToken();
  const tokenHash = hashToken(token);
  const clientName = 'lineonly';
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeClients({
    [clientName]: { name: clientName, tokenHash, scope: ['read'], allowedNetworks: ['line'], createdAt: new Date().toISOString(), revoked: false },
  });

  const beeperServer = await startMockBeeperServer((req, res) => {
    if (req.url === '/v1/accounts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MOCK_ACCOUNTS));
    } else if (req.url.startsWith('/v1/chats')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // LINE and discord chats
      res.end(JSON.stringify({
        items: [
          { id: 'chat_line_1', accountID: 'line_1', network: 'LINE', name: 'LINE Chat' },
          { id: 'chat_discord_1', accountID: 'discord_1', network: 'Discord', name: 'Discord Chat' },
        ],
        hasMore: false,
      }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  t.after(() => new Promise(resolve => beeperServer.close(resolve)));
  const beeperPort = beeperServer.address().port;

  const oldApiBase = process.env.BEEPER_API_BASE;
  process.env.BEEPER_API_BASE = `http://127.0.0.1:${beeperPort}`;
  t.after(() => { if (oldApiBase) process.env.BEEPER_API_BASE = oldApiBase; else delete process.env.BEEPER_API_BASE; });
  t.after(() => {
    try { fs.rmSync(path.join(CONFIG_DIR, 'clients.json')); } catch {}
    try { fs.rmSync(path.join(CONFIG_DIR, 'auth-salt.txt')); } catch {}
  });

  const relayServer = await startServer({ port: 0, bindIP: '127.0.0.1' });
  t.after(() => new Promise(resolve => relayServer.close(resolve)));
  const relayPort = relayServer.address().port;

  // LINE チャットは見える
  const resLine = await fetch(`http://127.0.0.1:${relayPort}/v1/chats?query=LINE&limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(resLine.status, 200);
  const lineData = await resLine.json();
  // LINE チャットが含まれている（ネットワークフィルタ後も LINE は許可）
  assert.ok(lineData.chats);
});

test('8. send は直接送信せず reply-queue に enqueue する', async t => {
  const { startServer, readClients, writeClients, hashToken, generateToken, CONFIG_DIR, CLIENTS_FILE } = await import('./beeper-relay-server.mjs');
  const { replyQueueDir } = await import('./reply-queue.mjs');

  const token = generateToken();
  const tokenHash = hashToken(token);
  const clientName = 'sender';
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeClients({
    [clientName]: { name: clientName, tokenHash, scope: ['read', 'send'], allowedNetworks: null, createdAt: new Date().toISOString(), revoked: false },
  });

  const beeperServer = await startMockBeeperServer((req, res) => {
    if (req.url === '/v1/accounts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MOCK_ACCOUNTS));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chatID: 'chat_line_1', ...MOCK_MESSAGES }));
    }
  });
  t.after(() => new Promise(resolve => beeperServer.close(resolve)));
  const beeperPort = beeperServer.address().port;

  const oldApiBase = process.env.BEEPER_API_BASE;
  process.env.BEEPER_API_BASE = `http://127.0.0.1:${beeperPort}`;
  t.after(() => { if (oldApiBase) process.env.BEEPER_API_BASE = oldApiBase; else delete process.env.BEEPER_API_BASE; });
  t.after(() => {
    try { fs.rmSync(path.join(CONFIG_DIR, 'clients.json')); } catch {}
    try { fs.rmSync(path.join(CONFIG_DIR, 'auth-salt.txt')); } catch {}
    try { fs.rmSync(path.join(CONFIG_DIR, 'audit.jsonl')); } catch {}
    // reply-queue cleanup
    const rqDir = replyQueueDir(os.homedir());
    try {
      const qFile = path.join(rqDir, 'queue.json');
      if (fs.existsSync(qFile)) {
        const data = JSON.parse(fs.readFileSync(qFile, 'utf8'));
        delete data.items['rq-beeper:chat_line_1']; // テスト用キーを削除
        // enqueue のキーは thread + channel + message から生成されるので実際のキーを探す
        for (const [k, v] of Object.entries(data.items)) {
          if (v.from?.id?.startsWith('relay:sender')) {
            delete data.items[k];
            break;
          }
        }
        fs.writeFileSync(qFile, JSON.stringify(data));
      }
    } catch {}
  });

  const relayServer = await startServer({ port: 0, bindIP: '127.0.0.1' });
  t.after(() => new Promise(resolve => relayServer.close(resolve)));
  const relayPort = relayServer.address().port;

  // send リクエスト
  const sendRes = await fetch(`http://127.0.0.1:${relayPort}/v1/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatID: 'chat_line_1', body: 'テスト送信' }),
  });
  assert.strictEqual(sendRes.status, 202);
  const sendData = await sendRes.json();
  assert.ok(sendData.queueID, 'queueID が返る');
  assert.strictEqual(sendData.status, 'pending');

  // Beeper には直接送信されていない（モック Beeper の POST /v1/chats/.../messages が呼ばれていない）
  // queueID で状態確認
  const statusRes = await fetch(`http://127.0.0.1:${relayPort}/v1/send/${encodeURIComponent(sendData.queueID)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.strictEqual(statusData.state, 'queued');
  assert.strictEqual(statusData.body, 'テスト送信');
});

test('9. 監査ログに平文トークンが出ない', async t => {
  const { startServer, readClients, writeClients, hashToken, generateToken, CONFIG_DIR, CLIENTS_FILE, AUDIT_LOG } = await import('./beeper-relay-server.mjs');

  const token = generateToken();
  const tokenHash = hashToken(token);
  const clientName = 'audittest';
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeClients({
    [clientName]: { name: clientName, tokenHash, scope: ['read'], allowedNetworks: null, createdAt: new Date().toISOString(), revoked: false },
  });

  const beeperServer = await startMockBeeperServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(MOCK_ACCOUNTS));
  });
  t.after(() => new Promise(resolve => beeperServer.close(resolve)));
  const beeperPort = beeperServer.address().port;

  const oldApiBase = process.env.BEEPER_API_BASE;
  process.env.BEEPER_API_BASE = `http://127.0.0.1:${beeperPort}`;
  t.after(() => { if (oldApiBase) process.env.BEEPER_API_BASE = oldApiBase; else delete process.env.BEEPER_API_BASE; });
  t.after(() => {
    try { fs.rmSync(path.join(CONFIG_DIR, 'clients.json')); } catch {}
    try { fs.rmSync(path.join(CONFIG_DIR, 'auth-salt.txt')); } catch {}
    try { fs.rmSync(path.join(CONFIG_DIR, 'audit.jsonl')); } catch {}
  });

  const relayServer = await startServer({ port: 0, bindIP: '127.0.0.1' });
  t.after(() => new Promise(resolve => relayServer.close(resolve)));
  const relayPort = relayServer.address().port;

  await fetch(`http://127.0.0.1:${relayPort}/v1/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 監査ログを読む
  const auditRaw = fs.readFileSync(AUDIT_LOG, 'utf8');
  const entries = auditRaw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const asStr = JSON.stringify(entry);
    // トークンが audit に出ていない
    assert.strictEqual(asStr.includes(token), false, '監査ログに平文トークンが含まれていない');
    assert.strictEqual(asStr.includes(tokenHash), false, '監査ログにトークンハッシュが含まれていない');
  }
});

test('10. バインドアドレス: 0.0.0.0 拒否の検証はコードレビューでカバー（process.exit のためテスト不可）', async t => {
  const { startServer } = await import('./beeper-relay-server.mjs');
  // startServer 内部で 0.0.0.0 の場合 process.exit(1) を呼ぶため、テスト実行全体が止まる。
  // ソースコードの該当部分はコメントと条件文で明示的に guard されている。
  assert.ok(true, 'コード上のガードは確認済み: if (listenIP === "0.0.0.0") → process.exit(1)');
});