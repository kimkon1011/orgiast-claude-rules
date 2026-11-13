import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./beeper-unreplied.mjs', import.meta.url));

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-unreplied-test-'));
}

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('1. Beeper 停止時: exit 2 + 日本語理由', async t => {
  const result = await runCli(['--since', '7d', '--networks', 'line'], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999',
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes('起動していません') || result.stderr.includes('接続できません'));
});

test('2. 401 認証エラー: exit 2 + 日本語理由', async t => {
  const server = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'unauthorized' }));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '7d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'bad',
  });
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes('認証'));
});

test('3. 0 件: exit 0 + []', async t => {
  const server = await startMockServer((req, res) => {
    if (req.url.startsWith('/v1/accounts')) {
      res.end(JSON.stringify([{ accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' }]));
    } else if (req.url.startsWith('/v1/chats')) {
      res.end(JSON.stringify({ items: [], hasMore: false, oldestCursor: null, newestCursor: null }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '[]');
});

test('4. 単一チャット・未返信あり', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!chat1:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '101', chatID: '!chat1:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '田中', timestamp: new Date(now.getTime() - 3600000).toISOString(), type: 'TEXT', text: '質問があります', isSender: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  let callCount = 0;
  const server = await startMockServer((req, res) => {
    callCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].channel, 'line');
  assert.equal(parsed[0].from.name, '田中');
  assert.equal(parsed[0].body, '質問があります');
  assert.ok(parsed[0].thread.startsWith('beeper:'));
});

test('5. ミュートチャットは除外', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!muted:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: true, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else res.end(JSON.stringify(chats));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '[]');
});

test('6. グループチャット: メンションありのみ含む', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!group1:localhost', accountID: 'line', network: 'LINE', type: 'group', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '201', chatID: '!group1:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '佐藤', timestamp: new Date(now.getTime() - 1800000).toISOString(), type: 'TEXT', text: '@kim 確認お願いします', isSender: false, mentions: ['@kim:localhost'] },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].from.name, '佐藤');
});

test('7. グループチャット: メンションなしは除外', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!group2:localhost', accountID: 'line', network: 'LINE', type: 'group', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '301', chatID: '!group2:localhost', accountID: 'line', senderID: '@other2:localhost', senderName: '高橋', timestamp: new Date(now.getTime() - 1800000).toISOString(), type: 'TEXT', text: '今日の天気いいですね', isSender: false, mentions: null },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '[]');
});

test('8. kim が最後に送信したチャットはスキップ', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!chat3:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 0, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '401', chatID: '!chat3:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '山田', timestamp: new Date(now.getTime() - 7200000).toISOString(), type: 'TEXT', text: '昨日はありがとう', isSender: false },
      { id: '402', chatID: '!chat3:localhost', accountID: 'line', senderID: '@kim:localhost', senderName: 'Kim', timestamp: new Date(now.getTime() - 3600000).toISOString(), type: 'TEXT', text: 'こちらこそ', isSender: true },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '[]');
});

test('9. コンテキスト（直前5件）が含まれる', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!chat4:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '501', chatID: '!chat4:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '鈴木', timestamp: new Date(now.getTime() - 5000000).toISOString(), type: 'TEXT', text: 'こんにちは', isSender: false },
      { id: '502', chatID: '!chat4:localhost', accountID: 'line', senderID: '@kim:localhost', senderName: 'Kim', timestamp: new Date(now.getTime() - 4000000).toISOString(), type: 'TEXT', text: 'はい', isSender: true },
      { id: '503', chatID: '!chat4:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '鈴木', timestamp: new Date(now.getTime() - 3000000).toISOString(), type: 'TEXT', text: '確認事項があります', isSender: false },
      { id: '504', chatID: '!chat4:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '鈴木', timestamp: new Date(now.getTime() - 2000000).toISOString(), type: 'TEXT', text: '来週の打ち合わせについて', isSender: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].body, '確認事項があります\n来週の打ち合わせについて');
  assert.ok(parsed[0].context.length >= 3);
  // body に kim の発言（"はい"）が含まれていない
  assert.equal(parsed[0].body.includes('はい'), false);
  // context に全部のメッセージが含まれている
  const contextBodies = parsed[0].context.map(c => c.body).join(' ');
  assert.ok(contextBodies.includes('確認事項があります'));
});

test('10. 既定ネットワークで LINE・Facebook・WhatsApp・Google Messages が収集される', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
    { accountID: 'fb', network: 'Facebook', bridge: { id: 'fb' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
    { accountID: 'wa', network: 'WhatsApp', bridge: { id: 'wa' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
    { accountID: 'gm', network: 'Google Messages', bridge: { id: 'gm' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chatIDs = ['!c-line:localhost', '!c-fb:localhost', '!c-wa:localhost', '!c-gm:localhost'];
  const chats = {
    items: chatIDs.map((id, i) => ({
      id, accountID: ['line', 'fb', 'wa', 'gm'][i], network: ['LINE', 'Facebook', 'WhatsApp', 'Google Messages'][i],
      type: 'single', lastActivity: now.toISOString(), unreadCount: 1,
      isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false,
    })),
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const senders = ['A子', 'B子', 'C子', 'D子'];
  const msgByChat = Object.fromEntries(chatIDs.map((id, i) => [id, {
    items: [{
      id: `60${i + 1}`, chatID: id, accountID: ['line', 'fb', 'wa', 'gm'][i],
      senderID: `@s${i}:localhost`, senderName: senders[i],
      timestamp: new Date(now.getTime() - 1000000).toISOString(), type: 'TEXT',
      text: ['lineです', 'messengerです', 'whatsappです', 'smsです'][i], isSender: false,
    }],
    hasMore: false, oldestCursor: null, newestCursor: null,
  }]));
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.method === 'GET' && req.url.startsWith('/v1/chats')) {
      const decoded = decodeURIComponent(req.url);
      const m = decoded.match(/\/chats\/([^/?]+)\/messages/);
      if (m) { res.end(JSON.stringify(msgByChat[m[1]] || { items: [], hasMore: false, oldestCursor: null, newestCursor: null })); return; }
      res.end(JSON.stringify(chats));
    } else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  // --networks を指定せず既定値で実行
  const result = await runCli(['--since', '1d'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map(p => p.channel).sort(), ['line', 'messenger', 'sms', 'whatsapp']);
});

test('11. --networks facebook は messenger チャネルに正規化される', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
    { accountID: 'fb', network: 'Facebook', bridge: { id: 'fb' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!c-line:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
      { id: '!c-fb:localhost', accountID: 'fb', network: 'Facebook', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const msgByChat = {
    '!c-line:localhost': { items: [{ id: '611', chatID: '!c-line:localhost', accountID: 'line', senderID: '@a:localhost', senderName: 'A子', timestamp: new Date(now.getTime() - 1000000).toISOString(), type: 'TEXT', text: 'lineです', isSender: false }], hasMore: false, oldestCursor: null, newestCursor: null },
    '!c-fb:localhost': { items: [{ id: '612', chatID: '!c-fb:localhost', accountID: 'fb', senderID: '@b:localhost', senderName: 'B子', timestamp: new Date(now.getTime() - 1000000).toISOString(), type: 'TEXT', text: 'messengerです', isSender: false }], hasMore: false, oldestCursor: null, newestCursor: null },
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.method === 'GET' && req.url.startsWith('/v1/chats')) {
      const decoded = decodeURIComponent(req.url);
      const m = decoded.match(/\/chats\/([^/?]+)\/messages/);
      if (m) { res.end(JSON.stringify(msgByChat[m[1]] || { items: [], hasMore: false, oldestCursor: null, newestCursor: null })); return; }
      res.end(JSON.stringify(chats));
    } else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'facebook'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].channel, 'messenger');
  assert.equal(parsed[0].from.name, 'B子');
});

test('12. 人名 "Caroline" は公式アカウントと誤判定されない', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!chat-caroline:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '621', chatID: '!chat-caroline:localhost', accountID: 'line', senderID: '@caroline:localhost', senderName: 'Caroline', timestamp: new Date(now.getTime() - 1000000).toISOString(), type: 'TEXT', text: 'こんにちは', isSender: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].from.name, 'Caroline');
});

test('13. "公式" を含むアカウント名は除外される', async t => {
  const now = new Date();
  const accounts = [
    { accountID: 'line', network: 'LINE', bridge: { id: 'line' }, user: { id: '@kim:localhost', isSelf: true }, status: 'connected' },
  ];
  const chats = {
    items: [
      { id: '!chat-official:localhost', accountID: 'line', network: 'LINE', type: 'single', lastActivity: now.toISOString(), unreadCount: 1, isMuted: false, isArchived: false, isLowPriority: false, isReadOnly: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const messages = {
    items: [
      { id: '631', chatID: '!chat-official:localhost', accountID: 'line', senderID: '@official:localhost', senderName: 'オージャスト公式', timestamp: new Date(now.getTime() - 1000000).toISOString(), type: 'TEXT', text: 'お知らせです', isSender: false },
    ],
    hasMore: false, oldestCursor: null, newestCursor: null,
  };
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/accounts') res.end(JSON.stringify(accounts));
    else if (req.url.includes('/messages')) res.end(JSON.stringify(messages));
    else if (req.url.startsWith('/v1/chats') && req.method === 'GET') res.end(JSON.stringify(chats));
    else res.end('[]');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await runCli(['--since', '1d', '--networks', 'line'], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '[]');
});