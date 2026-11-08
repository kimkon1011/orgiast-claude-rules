import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./beeper-send.mjs', import.meta.url));

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-send-test-'));
}

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function setupQueue(home, id, overrides = {}) {
  const queueDir = path.join(home, '.claude', 'reply-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const receiptId = 'rc-test-' + Math.random().toString(36).slice(2, 10);
  const now = new Date();
  const item = {
    id,
    key: `line:chat1:msg-101`,
    channel: 'line',
    thread: 'beeper:!chat1:localhost',
    message: 'msg-101',
    from: { id: 'u2', name: '相手', external: true },
    receivedAt: now.toISOString(),
    body: '質問です',
    state: 'approved',
    draft: { text: 'はい、承知しました', createdAt: now.toISOString() },
    receipt: {
      id: receiptId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      latestMessageId: 'msg-101',
    },
    history: [{ at: now.toISOString(), state: 'approved' }],
    ...overrides,
  };
  const queue = { version: 1, items: { [id]: item } };
  fs.writeFileSync(path.join(queueDir, 'queue.json'), JSON.stringify(queue, null, 2));
  return { queueDir, receiptId, item };
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

test('1. 正常送信: receipt 検証通過 → 送信 → 読み戻し成功', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-001';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, 'はい、承知しました', 'utf8');

  let sendCount = 0;
  let listCount = 0;
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST' && req.url.includes('/messages')) {
      sendCount++;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.end(JSON.stringify({ chatID: '!chat1:localhost', pendingMessageID: 'pending-123' }));
      });
    } else if (req.method === 'GET' && req.url.includes('/messages')) {
      listCount++;
      // 読み戻し: 送信済みメッセージが見つかる
      res.end(JSON.stringify({
        items: [
          { id: '999', chatID: '!chat1:localhost', accountID: 'line', senderID: '@kim:localhost', senderName: 'Kim', timestamp: new Date().toISOString(), type: 'TEXT', text: 'はい、承知しました', isSender: true },
        ],
        hasMore: false, oldestCursor: null, newestCursor: null,
      }));
    } else {
      res.end('{}');
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.messageID, '999');
  assert.equal(parsed.pendingMessageID, 'pending-123');
  assert.equal(sendCount, 1);
  assert.ok(listCount >= 1);
});

test('2. receipt 無効: 期限切れ', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-002';
  setupQueue(home, queueID, {
    receipt: {
      id: 'rc-expired',
      issuedAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      latestMessageId: 'msg-101',
    },
  });
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本文', 'utf8');

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', 'rc-expired', // フィクスチャの receipt.id と一致させる
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999',
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 4);
  assert.ok(result.stderr.includes('期限'));
});

test('3. receipt 無効: receipt ID 不一致', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-003';
  setupQueue(home, queueID); // receipt ID は auto-generated
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本文', 'utf8');

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', 'rc-wrong-id',
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999',
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 4);
  assert.ok(result.stderr.includes('一致しません') || result.stderr.includes('receipt'));
});

test('4. 状態不正: queued からの送信は拒否', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-004';
  const { receiptId } = setupQueue(home, queueID, { state: 'queued', receipt: undefined });
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本文', 'utf8');

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999',
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 4);
  assert.ok(result.stderr.includes('approved/edited') || result.stderr.includes('現在:'));
});

test('5. Beeper 停止: exit 2', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-005';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本文', 'utf8');

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19998',
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes('起動していません') || result.stderr.includes('接続できません'));
});

test('6. レート制限: 同一チャット 3 通/時', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-006';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本文', 'utf8');

  // 過去ログ: 同一チャットに 3 通送信済み
  const logDir = path.join(home, '.claude', 'reply-queue');
  fs.mkdirSync(logDir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(logDir, 'beeper-send-log.jsonl'),
      JSON.stringify({ ts: new Date(now - (i * 60000)).toISOString(), chatID: '!chat1:localhost', messageID: `msg-${i}`, queueID: `rq-old-${i}`, receiptID: 'rc-old' }) + '\n', 'utf8');
  }

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999',
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 1); // exit 1 from general error
  assert.ok(result.stderr.includes('上限'));
});

test('7. レート制限: 全体 20 通/時', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-007';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本文', 'utf8');

  const logDir = path.join(home, '.claude', 'reply-queue');
  fs.mkdirSync(logDir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    fs.appendFileSync(path.join(logDir, 'beeper-send-log.jsonl'),
      JSON.stringify({ ts: new Date(now - (i * 60000)).toISOString(), chatID: `!other-${i}:localhost`, messageID: `msg-${i}`, queueID: `rq-old-${i}`, receiptID: 'rc-old' }) + '\n', 'utf8');
  }

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999',
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('上限'));
});

test('8. 読み戻し失敗: exit 3', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-008';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '読み戻せない本文', 'utf8');

  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST' && req.url.includes('/messages')) {
      res.end(JSON.stringify({ chatID: '!chat1:localhost', pendingMessageID: 'pending-456' }));
    } else if (req.method === 'GET' && req.url.includes('/messages')) {
      // 該当する送信メッセージが無い（文脈チェックにも抵触しないよう古い時刻にする）
      res.end(JSON.stringify({
        items: [
          { id: 'old-msg', chatID: '!chat1:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '相手', timestamp: new Date(Date.now() - 60000).toISOString(), type: 'TEXT', text: '以前のメッセージ', isSender: false },
        ],
        hasMore: false, oldestCursor: null, newestCursor: null,
      }));
    } else {
      res.end('{}');
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 3);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.uncertain, true);
});

test('9. 本文はファイルから: argv に本文を渡さない', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-009';
  setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, 'ファイルからの本文', 'utf8');

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', 'rc-wrong-id', // receipt 不一致 → Beeper 接続前に exit 4
  ], {
    BEEPER_API_BASE: 'http://127.0.0.1:19999', // down, but receipt fails first
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  // receipt の問題で exit 4 になるはず。本文がファイルから読まれたかは確認できないが、
  // 少なくとも本文が argv に含まれていないことだけ確認
  assert.equal(result.code, 4);
  assert.ok(!result.stderr.includes('ファイルからの本文'), '本文が stderr に含まれていない');
});

test('10. 文脈変化: 送信直前に相手の新着あり → exit 4・sendMessage が呼ばれない', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-010';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, 'はい、承知しました', 'utf8');

  let sendCount = 0;
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST' && req.url.includes('/messages')) {
      sendCount++;
      res.end(JSON.stringify({ chatID: '!chat1:localhost', pendingMessageID: 'pending-789' }));
    } else if (req.method === 'GET' && req.url.includes('/messages')) {
      // 相手の新着（基準時刻より後）
      res.end(JSON.stringify({
        items: [
          { id: 'new-msg', chatID: '!chat1:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '相手', timestamp: new Date(Date.now() + 60000).toISOString(), type: 'TEXT', text: '追加の質問です', isSender: false },
        ],
        hasMore: false, oldestCursor: null, newestCursor: null,
      }));
    } else {
      res.end('{}');
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 4);
  assert.ok(result.stderr.includes('context_changed'));
  assert.equal(sendCount, 0, 'sendMessage が呼ばれていないこと');
});

test('11. 文脈変化なし: 相手の古いメッセージのみ → 従来通り送信できる', async t => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queueID = 'rq-test-011';
  const { receiptId } = setupQueue(home, queueID);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, 'はい、承知しました', 'utf8');

  let sendCount = 0;
  let sent = false;
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST' && req.url.includes('/messages')) {
      sendCount++;
      sent = true;
      res.end(JSON.stringify({ chatID: '!chat1:localhost', pendingMessageID: 'pending-abc' }));
    } else if (req.method === 'GET' && req.url.includes('/messages')) {
      if (sent) {
        // 読み戻し: 送信済みメッセージが見つかる
        res.end(JSON.stringify({
          items: [
            { id: '999', chatID: '!chat1:localhost', accountID: 'line', senderID: '@kim:localhost', senderName: 'Kim', timestamp: new Date().toISOString(), type: 'TEXT', text: 'はい、承知しました', isSender: true },
          ],
          hasMore: false, oldestCursor: null, newestCursor: null,
        }));
      } else {
        // 文脈チェック: 相手の発言は基準時刻より前のみ
        res.end(JSON.stringify({
          items: [
            { id: 'old-msg', chatID: '!chat1:localhost', accountID: 'line', senderID: '@other:localhost', senderName: '相手', timestamp: new Date(Date.now() - 60000).toISOString(), type: 'TEXT', text: '質問です', isSender: false },
          ],
          hasMore: false, oldestCursor: null, newestCursor: null,
        }));
      }
    } else {
      res.end('{}');
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await runCli([
    '--chat', '!chat1:localhost',
    '--body-file', bodyFile,
    '--queue-id', queueID,
    '--receipt', receiptId,
  ], {
    BEEPER_API_BASE: `http://127.0.0.1:${port}`,
    BEEPER_ACCESS_TOKEN: 'test',
    ORGIAST_HOME: home,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.messageID, '999');
  assert.equal(sendCount, 1);
});