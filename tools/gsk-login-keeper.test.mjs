import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startKeeper } from './gsk-login-keeper.mjs';

async function fixture(t, source, extraArgs = []) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsk-keeper-'));
  const cli = path.join(home, 'stub.mjs');
  await fsp.writeFile(cli, source);
  const logs = [];
  const keeper = await startKeeper({
    args: ['--port', '0', '--cli', cli, '--url-timeout-ms', '500', ...extraArgs],
    env: { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_HOME: home, STUB_HOME: home },
    log: (line) => logs.push(line),
    errorLog: (line) => logs.push(line),
  });
  t.after(async () => {
    await keeper.close().catch(() => {});
    await fsp.rm(home, { recursive: true, force: true });
  });
  const port = keeper.server.address().port;
  assert.equal(keeper.server.address().address, '127.0.0.1');
  return { home, port, logs, keeper };
}

function request(port, pathname = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
  });
}

const sleepingStub = `
import fs from 'node:fs'; import path from 'node:path';
const count = path.join(process.env.STUB_HOME, 'attempts.txt');
fs.appendFileSync(count, '1\\n');
console.error('[INFO] Login URL: https://example.test/verify?code=stub-secret');
setTimeout(() => {}, 60_000);
`;

test('GET / は stderr の Login URL へ 302 する', async (t) => {
  const { port } = await fixture(t, sleepingStub);
  const result = await request(port);
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://example.test/verify?code=stub-secret');
});

test('GET / は stdout の Login URL へも 302 する', async (t) => {
  const stdoutStub = `
    console.log('[INFO] Login URL: https://example.test/verify?code=stdout-secret');
    setTimeout(() => {}, 60_000);
  `;
  const { port } = await fixture(t, stdoutStub);
  const result = await request(port);
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://example.test/verify?code=stdout-secret');
});

test('540秒以内は同じURLを再利用し子プロセスを増やさない', async (t) => {
  const { home, port } = await fixture(t, sleepingStub);
  const first = await request(port);
  const second = await request(port);
  assert.equal(second.headers.location, first.headers.location);
  assert.equal((await fsp.readFile(path.join(home, 'attempts.txt'), 'utf8')).trim().split(/\r?\n/).length, 1);
});

test('GET /status は認可状態と試行回数を JSON で返す', async (t) => {
  const { port } = await fixture(t, sleepingStub);
  await request(port);
  const result = await request(port, '/status');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(result.body), { authorized: false, hasUrl: true, ageSec: 0, attempts: 1 });
});

test('config.json に api_key が現れると genspark.env に保存してサーバを閉じる', async (t) => {
  const writingStub = `
    import fs from 'node:fs'; import path from 'node:path';
    console.log('[INFO] Login URL: https://example.test/verify?code=write-key');
    const dir = path.join(process.env.STUB_HOME, '.genspark-tool-cli');
    fs.mkdirSync(dir, { recursive: true });
    setTimeout(() => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ api_key: 'key-super-secret' })), 100);
    setTimeout(() => {}, 60_000);
  `;
  const { home, port, logs, keeper } = await fixture(t, writingStub);
  await request(port);
  await once(keeper.server, 'close');
  const saved = await fsp.readFile(path.join(home, '.claude', 'genspark.env'), 'utf8');
  assert.equal(saved, 'GSK_API_KEY=key-super-secret\n');
  assert.match(logs.join('\n'), /\[OK\] 認可完了/);
  assert.doesNotMatch(logs.join('\n'), /key-super-secret|write-key/);
});

test('URLを出さず終了した子プロセスはハングせず 500 と説明を返す', async (t) => {
  const { port } = await fixture(t, `console.error('stub failure'); process.exit(7);`);
  const result = await request(port);
  assert.equal(result.status, 500);
  assert.match(result.body, /Login URL を出さずに終了.*exit 7.*stub failure/);
});

test('タイムアウト時は子プロセス出力末尾を秘密値をマスクして返す', async (t) => {
  const timeoutStub = `
    console.error('[INFO] waiting code=very-secret-code');
    console.log('credential gsk_very-secret-key');
    setTimeout(() => {}, 60_000);
  `;
  const { port } = await fixture(t, timeoutStub, ['--url-timeout-ms', '100']);
  const result = await request(port);
  assert.equal(result.status, 500);
  assert.match(result.body, /子プロセス出力末尾/);
  assert.match(result.body, /code=\*\*\*/);
  assert.doesNotMatch(result.body, /very-secret-code|gsk_very-secret-key/);
});

test('ポートが使用中なら明示エラーになる', async (t) => {
  const blocker = http.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsk-keeper-port-'));
  const cli = path.join(home, 'stub.mjs');
  await fsp.writeFile(cli, sleepingStub);
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await assert.rejects(
    startKeeper({ args: ['--port', String(port), '--cli', cli], env: { ...process.env, ORGIAST_HOME: home } }),
    /127\.0\.0\.1:.*待ち受けできません.*EADDRINUSE/,
  );
});
