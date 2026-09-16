import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./keyserve-rotation-gate.mjs', import.meta.url));

async function serve(body, status = 200) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function run(url, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--json'], {
      env: { ...process.env, FLEET_SHEET_URL: url, FLEET_SHEET_TOKEN: 'test-token', ...extraEnv },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('全台 primary なら exit 0', async (t) => {
  const fixture = await serve({ ok: true, rows: [{ pcName: '営業 PC', hostname: 'host-01', keyserveAuth: 'primary', keyserveCheckedAt: new Date().toISOString() }] });
  t.after(() => fixture.server.close());
  const result = await run(fixture.url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
});

test('legacy 1 台は exit 1 で PC 名と hostname を出す', async (t) => {
  const fixture = await serve({ ok: true, rows: [{ pcName: '制作 PC', hostname: 'DESKTOP-LEGACY', keyserveAuth: 'legacy', keyserveCheckedAt: new Date().toISOString() }] });
  t.after(() => fixture.server.close());
  const result = await run(fixture.url);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /制作 PC/);
  assert.match(result.stdout, /DESKTOP-LEGACY/);
});

test('古い行は primary でも未確認として不合格', async (t) => {
  const fixture = await serve({ ok: true, rows: [{ pcName: '総務 PC', hostname: 'host-stale', keyserveAuth: 'primary', keyserveCheckedAt: '2020-01-01T00:00:00.000Z' }] });
  t.after(() => fixture.server.close());
  const result = await run(fixture.url);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).blockers[0].reason, '未確認');
});

test('台帳取得失敗は fail-open せず不合格', async () => {
  const result = await run('http://127.0.0.1:1/');
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.passed, false);
  assert.equal(payload.ok, false);
});
