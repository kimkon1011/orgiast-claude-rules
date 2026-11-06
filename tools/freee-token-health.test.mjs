import assert from 'node:assert/strict';
import test from 'node:test';
import { runFreeeTokenHealth } from './freee-token-health.mjs';

const secrets = {
  service: 'service-role-secret-value',
  access: 'access-token-secret-value',
  refresh: 'refresh-token-secret-value',
  client: 'client-secret-value',
};
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: secrets.service,
  FREEE_CLIENT_ID: 'client-id',
  FREEE_CLIENT_SECRET: secrets.client,
};
const row = { id: 'default', access_token: secrets.access, refresh_token: secrets.refresh, updated_at: 'old' };

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

async function execute(fetchImpl, options = {}) {
  const output = [];
  const notifications = [];
  const code = await runFreeeTokenHealth({
    env,
    fetchImpl,
    stdout: line => output.push(line),
    addItemImpl: async (...args) => { notifications.push(args); },
    home: 'test-home',
    ...options,
  });
  return { code, output, notifications };
}

test('all rows 200 returns ok without notification', async () => {
  const result = await execute(async url => url.includes('/rest/v1/') ? response(200, [row]) : response(200, []));
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, ['freee-token-health: ok']);
  assert.equal(result.notifications.length, 0);
});

test('401 refresh success PATCHes exactly three columns', async () => {
  let patchBody;
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/rest/v1/') && !options.method) return response(200, [row]);
    if (url.includes('/companies')) return response(401, {});
    if (url.includes('/public_api/token')) return response(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 86400 });
    if (options.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      return response(200, [{ id: row.id, ...patchBody }]);
    }
    throw new Error('unexpected fetch');
  };
  const result = await execute(fetchImpl);
  assert.equal(result.code, 0);
  assert.deepEqual(Object.keys(patchBody).sort(), ['access_token', 'refresh_token', 'updated_at']);
  assert.equal('expires_in' in patchBody, false);
  assert.equal(result.notifications.length, 0);
  assert.deepEqual(result.output, ['freee-token-health: ok']);
});

test('invalid_grant returns broken and notifies kim-inbox', async () => {
  const fetchImpl = async url => {
    if (url.includes('/rest/v1/')) return response(200, [row]);
    if (url.includes('/companies')) return response(401, {});
    return response(400, { error: 'invalid_grant' });
  };
  const result = await execute(fetchImpl);
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, ['freee-token-health: broken id=default']);
  assert.equal(result.notifications.length, 1);
  const [home, item, options] = result.notifications[0];
  assert.equal(home, 'test-home');
  assert.equal(item.kind, 'ask');
  assert.equal(item.source, 'freee-token-health');
  assert.equal(item.dedupeKey, 'freee-auth-broken-default');
  assert.deepEqual(options, { drain: false });
});

test('empty table returns pending without notification', async () => {
  const result = await execute(async () => response(200, []));
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, ['freee-token-health: pending']);
  assert.equal(result.notifications.length, 0);
});

test('Supabase failure returns unconfirmed without notification', async () => {
  const result = await execute(async () => { throw new Error(`network ${secrets.service}`); });
  assert.equal(result.code, 0);
  assert.match(result.output[0], /^freee-token-health: unconfirmed:/);
  assert.equal(result.notifications.length, 0);
});

test('output and notification never contain secret values', async () => {
  const fetchImpl = async url => {
    if (url.includes('/rest/v1/')) return response(200, [row]);
    if (url.includes('/companies')) return response(401, {});
    return response(401, { error: 'invalid_grant', token: secrets.refresh });
  };
  const result = await execute(fetchImpl);
  const visible = JSON.stringify({ output: result.output, notification: result.notifications });
  for (const secret of Object.values(secrets)) assert.equal(visible.includes(secret), false);
});
