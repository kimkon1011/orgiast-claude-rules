import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, main, parseArgs, run, pushLine } from './ai-daikodo-line.mjs';

test('inbox date is encoded; only GET and no redirects carrying auth', async () => {
  let request;
  const result = await run(['--inbox', '--since', '2026-06-01T00:00:00Z', '--json'], {
    key: 'test-key', fetchImpl: async (url, init) => { request = { url: String(url), init }; return Response.json([]); },
  });
  assert.deepEqual(result.body, []);
  assert.equal(result.exitCode, 0);
  assert.match(request.url, /since=2026-06-01T00%3A00%3A00Z/);
  assert.equal(request.init.method, undefined);
  assert.equal(request.init.redirect, 'error');
});
test('load existing protected local credential file without printing it', () => {
  const cfg = configuration({ env: {}, home: '/test', readFile: () => 'TANOM_ADMIN_KEY=private-key\nTANOM_BASE=https://ai-daikodo.com\n' });
  assert.equal(cfg.key, 'private-key');
});
test('rotated saved key overrides an obsolete parent environment', () => {
  assert.equal(configuration({ env: { TANOM_ADMIN_KEY: 'old', AI_DAIKODO_ADMIN_API_KEY: 'old' }, readFile: () => 'TANOM_ADMIN_KEY=new\n' }).key, 'new');
});
test('push uses POST and stable UUID; accepts LINE receipt or duplicate receipt only', async () => {
  const message = { userId: 'Uabc', text: 'ありがとうございます', retryKey: '419516b3-4544-5a39-a54d-620404630264' };
  for (const receipt of [{ lineStatus: 200, sentMessages: [{}] }, { lineStatus: 409, duplicate: true }]) {
    await pushLine(message, { key: 'key', fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, '/api/admin/line/push'); assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), message); assert.equal(init.redirect, 'error');
      return Response.json(receipt);
    } });
  }
  await assert.rejects(pushLine(message, { key: 'key', fetchImpl: async () => Response.json({}) }), /acknowledgement/);
  await assert.rejects(pushLine({ ...message, retryKey: 'not-a-uuid' }, { fetchImpl: () => assert.fail() }), /UUID/);
});
test('incomplete empty inbox never reports success', async () => {
  const body = { threads: [], incomplete: true, warnings: [{ status: 403 }] };
  const result = await run(['--inbox'], { key: 'key', fetchImpl: async () => Response.json(body, { status: 503 }) });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.body, body);
});
test('partial messages survive with failing exit code', async () => {
  const body = { threads: [{ messages: [{ text: 'saved' }] }], incomplete: true, warnings: [] };
  const result = await run(['--inbox'], { key: 'key', fetchImpl: async () => Response.json(body, { status: 206 }) });
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.threads[0].messages[0].text, 'saved');
});
test('status with Discord failure is degraded', async () => {
  const result = await run(['--status'], { key: 'key', fetchImpl: async () => Response.json({ discord: { channel: { ok: false } } }) });
  assert.equal(result.exitCode, 2);
});
test('reject malformed args and customer send', () => {
  for (const args of [['--push'], ['--inbox', '--since'], ['--status', '--inbox'], ['--inbox', '--since', 'bad']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('auth errors fail and never echo the API key', async () => {
  let error;
  const code = await main(['--status'], {
    env: {}, readFile: () => '', key: 'secret-value', out: () => assert.fail(),
    err: value => { error = value; }, fetchImpl: async () => Response.json({ error: 'secret-value' }, { status: 401 }),
  });
  assert.equal(code, 1);
  assert.doesNotMatch(error, /secret-value/);
});

