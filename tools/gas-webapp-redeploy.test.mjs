import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyProbe, execUrlOf, getAccessToken, healGasWebApp, probeWebApp } from './gas-webapp-redeploy.mjs';

const DENIED_HTML = '<html><head><title>アクセスが拒否されました</title></head><body>ドライブ アクセス権が必要です</body></html>';
const SIGNIN_HTML = '<html><head><title>Sign in - Google Accounts</title></head><body>login</body></html>';
const APP_HTML = '<html><head><title>倉庫アプリ</title></head><body>備品検索</body></html>';

function res(status, body) {
  return { status, text: async () => body, json: async () => JSON.parse(body) };
}

test('denied ページだけを deployment 記録の壊れとして分類する', () => {
  assert.equal(classifyProbe({ status: 200, body: DENIED_HTML, authed: true }).kind, 'denied');
  assert.equal(classifyProbe({ status: 403, body: DENIED_HTML, authed: true }).kind, 'denied');
  assert.equal(classifyProbe({ status: 200, body: APP_HTML, authed: true }).kind, 'healthy');
  assert.equal(classifyProbe({ status: 200, body: APP_HTML, authed: true }).title, '倉庫アプリ');
  // anon の sign-in は ANYONE 設定で正常。壊れ判定に混ぜない。
  assert.equal(classifyProbe({ status: 200, body: SIGNIN_HTML, authed: false }).kind, 'signin');
  assert.equal(classifyProbe({ status: 401, body: SIGNIN_HTML, authed: true }).kind, 'signin');
  assert.equal(classifyProbe({ status: 500, body: 'boom', authed: true }).kind, 'http-error');
});

test('exec URL は deploymentId から組める', () => {
  assert.equal(execUrlOf('AKfycb-x'), 'https://script.google.com/macros/s/AKfycb-x/exec');
});

test('probeWebApp は bearer を付け、ネットワーク断でも落ちない', async () => {
  const seen = [];
  const r = await probeWebApp('https://example.test/exec', {
    token: 'tok',
    fetchImpl: async (url, opts) => { seen.push(opts.headers.Authorization); return res(200, APP_HTML); },
  });
  assert.equal(r.kind, 'healthy');
  assert.deepEqual(seen, ['Bearer tok']);
  const off = await probeWebApp('https://example.test/exec', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(off.kind, 'network-error');
  assert.equal(off.status, 0);
});

test('正常なら PUT しない / 壊れていれば同じ version で所有者 PUT → 再診断 ok', async () => {
  const scriptId = 'SCRIPT', deploymentId = 'DEP';
  const url = execUrlOf(deploymentId);

  // 1) 正常系: GET/PUT を一切呼ばない
  let calls = [];
  const healthyFetch = async (u, o = {}) => {
    calls.push([o.method || 'GET', u]);
    if (u === url) return res(200, APP_HTML);
    throw new Error('呼ばれてはいけない: ' + u);
  };
  const ok = await healGasWebApp({ scriptId, deploymentId, token: 't', fetchImpl: healthyFetch });
  assert.equal(ok.healed, false);
  assert.equal(ok.action, 'none');
  assert.equal(calls.length, 1);

  // 2) 壊れている系: 診断 denied → deployments.get → PUT(同 version) → 再診断 healthy
  calls = [];
  let repaired = false;
  const brokenFetch = async (u, o = {}) => {
    calls.push([o.method || 'GET', u]);
    if (u === url) return res(200, repaired ? APP_HTML : DENIED_HTML);
    if (u.endsWith(`/deployments/${deploymentId}`) && !o.method) {
      return res(200, JSON.stringify({ deploymentId, deploymentConfig: { versionNumber: 59, manifestFileName: 'appsscript', description: '旧' } }));
    }
    if (u.endsWith(`/deployments/${deploymentId}`) && o.method === 'PUT') {
      const body = JSON.parse(o.body);
      assert.deepEqual(body.deploymentConfig, { versionNumber: 59, manifestFileName: 'appsscript', description: '所有者で再デプロイ' });
      repaired = true;
      return res(200, JSON.stringify({ deploymentId }));
    }
    throw new Error('想定外 ' + u);
  };
  const fixed = await healGasWebApp({ scriptId, deploymentId, token: 't', fetchImpl: brokenFetch, description: '所有者で再デプロイ' });
  assert.equal(fixed.action, 'redeploy-as-owner');
  assert.equal(fixed.healed, true);
  assert.equal(fixed.before.kind, 'denied');
  assert.equal(fixed.after.kind, 'healthy');
  assert.equal(fixed.after.title, '倉庫アプリ');
  assert.deepEqual(calls.map((c) => c[0]), ['GET', 'GET', 'PUT', 'GET']);

  // 3) dry-run は PUT しない
  const dryCalls = [];
  const dry = await healGasWebApp({
    scriptId, deploymentId, token: 't', dryRun: true,
    fetchImpl: async (u, o = {}) => { dryCalls.push(o.method || 'GET'); return res(200, DENIED_HTML); },
  });
  assert.equal(dry.action, 'dry-run');
  assert.deepEqual(dryCalls, ['GET']);
});

test('getAccessToken は clasprc の refresh_token を使い、欠落時は例外', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-redeploy-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.clasprc.json'), JSON.stringify({ tokens: { default: { client_id: 'cid', client_secret: 'sec', refresh_token: 'rt' } } }));
  let sent = '';
  const token = await getAccessToken({
    home,
    fetchImpl: async (u, o) => { sent = o.body; return res(200, JSON.stringify({ access_token: 'AT', expires_in: 3599 })); },
  });
  assert.equal(token, 'AT');
  assert.match(sent, /refresh_token=rt/);
  assert.match(sent, /grant_type=refresh_token/);

  fs.writeFileSync(path.join(home, '.clasprc.json'), JSON.stringify({ tokens: { default: {} } }));
  await assert.rejects(() => getAccessToken({ home, fetchImpl: async () => res(200, '{}') }), /refresh_token/);
});
