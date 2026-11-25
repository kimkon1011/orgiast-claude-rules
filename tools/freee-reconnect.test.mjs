import test from 'node:test';
import assert from 'node:assert/strict';
import { runReconnect } from './freee-reconnect.mjs';

const secrets = {
  clientId: 'secret-client-id', clientSecret: 'secret-client-secret',
  code: 'secret-code', access: 'secret-access-token', refresh: 'secret-refresh-token',
};

function makeSql() {
  let accessToken = 'old-token';
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join('?');
    calls.push({ query, values });
    if (query.startsWith('select client_id')) return [{ client_id: secrets.clientId, client_secret: secrets.clientSecret }];
    if (query.startsWith('update freee_tokens')) { accessToken = values[1]; return []; }
    if (query.startsWith('select access_token')) return [{ access_token: accessToken }];
    throw new Error('unexpected query');
  };
  sql.calls = calls;
  return sql;
}

function harness(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const opened = [];
  const sql = makeSql();
  const deps = {
    argv: [], sql, output: (v) => stdout.push(v), errorOutput: (v) => stderr.push(v),
    openBrowser: async (url) => opened.push(url), readLine: async () => secrets.code,
    fetch: async (url) => url.includes('/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: secrets.access, refresh_token: secrets.refresh, expires_in: 3600 }) }
      : { ok: true, status: 200, json: async () => ({ companies: [{ id: 1 }, { id: 2 }] }) },
    ...overrides,
  };
  return { deps, stdout, stderr, opened, sql };
}

test('成功経路で更新、読み戻し、会社確認を行う', async () => {
  const h = harness();
  assert.equal(await runReconnect(h.deps), 0);
  assert.deepEqual(h.stdout, ['freee 再接続 OK（会社数 2）']);
  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0], /prompt=select_company/);
  assert.ok(h.sql.calls.some((c) => c.query.startsWith('update freee_tokens')));
});

test('URL貼付からcodeを抽出する', async () => {
  let postedCode;
  const h = harness({
    readLine: async () => `https://example.test/callback?code=${encodeURIComponent(secrets.code)}&state=x`,
    fetch: async (url, options) => {
      if (url.includes('/token')) {
        postedCode = options.body.get('code');
        return { ok: true, status: 200, json: async () => ({ access_token: secrets.access, refresh_token: secrets.refresh, expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({ companies: [] }) };
    },
  });
  assert.equal(await runReconnect(h.deps), 0);
  assert.equal(postedCode, secrets.code);
});

test('トークン交換失敗はstatusとerror名だけ表示する', async () => {
  const h = harness({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_grant', error_description: secrets.code }) }) });
  assert.equal(await runReconnect(h.deps), 3);
  assert.deepEqual(h.stderr, ['NG: トークン取得失敗 HTTP 401 error=invalid_grant']);
});

test('companies失敗はexit 4になる', async () => {
  let call = 0;
  const h = harness({ fetch: async () => (++call === 1
    ? { ok: true, status: 200, json: async () => ({ access_token: secrets.access, refresh_token: secrets.refresh, expires_in: 3600 }) }
    : { ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(await runReconnect(h.deps), 4);
  assert.deepEqual(h.stderr, ['NG: 確認 HTTP 503']);
});

test('標準出力と標準エラーに秘密値を含めない', async () => {
  const h = harness();
  await runReconnect(h.deps);
  const visible = [...h.stdout, ...h.stderr].join('\n');
  for (const value of Object.values(secrets)) assert.equal(visible.includes(value), false);
});

test('--checkはブラウザもfetchも使わない', async () => {
  let sideEffects = 0;
  const h = harness({ argv: ['--check'], openBrowser: async () => { sideEffects++; }, fetch: async () => { sideEffects++; } });
  assert.equal(await runReconnect(h.deps), 0);
  assert.deepEqual(h.stdout, ['check OK']);
  assert.equal(sideEffects, 0);
});
