import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { getDriveToken, DRIVE_SCOPE } from './lib/drive-auth.mjs';
import vm from 'node:vm';
import { mintDwdToken } from './gmail-draft.mjs';
import { deploy } from './seisaku-gmail-token-deploy.mjs';
const user = 'seisaku-team@orgiast.jp';
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const json = value => new Response(JSON.stringify(value));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'seisaku-relay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ user, secret: randomBytes(24).toString('hex'), webAppUrl: `https://script.google.com/macros/s/${randomBytes(8).toString('hex')}/exec` }));
  return { statePath, keyPath: join(dir, 'missing.json'), impersonate: user, scope };
}
test('鍵なしは中継を利用しプロセス内キャッシュする', async t => {
  const opts = fixture(t); let calls = 0;
  const token = randomBytes(24).toString('hex');
  opts.fetchImpl = async (_url, options) => { calls++; assert.equal(options.method, 'POST'); assert.ok(JSON.parse(options.body).secret); return json({ ok: true, user, accessToken: token, expiresInSec: 3300 }); };
  assert.ok(await getDriveToken(opts) === token);
  assert.ok(await getDriveToken(opts) === token);
  assert.equal(calls, 1);
});
test('鍵ありは従来の JWT 経路', async t => {
  const opts = fixture(t);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(opts.keyPath, JSON.stringify({ client_email: 'sa@example.invalid', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }) }));
  opts.fetchImpl = async (url, options) => { assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.ok(options.body.includes('assertion=')); return json({ access_token: randomBytes(24).toString('hex') }); };
  assert.ok(await getDriveToken(opts));
});
for (const [name, override] of [['別ユーザー', { impersonate: 'other@example.invalid' }], ['Drive', { scope: DRIVE_SCOPE }], ['混在スコープ', { scope: scope + ' ' + DRIVE_SCOPE }]]) {
  test(`鍵なし＋${name}は従来どおり ENOENT`, async t => {
    await assert.rejects(getDriveToken({ ...fixture(t), ...override, fetchImpl: () => assert.fail('通信禁止') }), { code: 'ENOENT' });
  });
}
test('状態なしは ENOENT', async t => {
  const opts = fixture(t); rmSync(opts.statePath);
  await assert.rejects(getDriveToken(opts), { code: 'ENOENT' });
});
test('明示された GOOGLE_SA_KEY は中継しない', async t => {
  const previous = process.env.GOOGLE_SA_KEY; process.env.GOOGLE_SA_KEY = '/missing';
  try { await assert.rejects(getDriveToken(fixture(t)), { code: 'ENOENT' }); }
  finally { if (previous === undefined) delete process.env.GOOGLE_SA_KEY; else process.env.GOOGLE_SA_KEY = previous; }
});
for (const [name, response] of [['HTML', () => new Response('<html>Authorization needed</html>')], ['拒否', () => json({ ok: false, error: 'unauthorized' })], ['別ユーザー応答', () => json({ ok: true, user: 'other@example.invalid' })]]) {
  test(`${name}は承認 URL つき日本語エラー`, async t => {
    const opts = fixture(t);
    await assert.rejects(getDriveToken({ ...opts, fetchImpl: async () => response() }), /seisaku-gmail-token: 未承認または失敗（.*）。承認 URL: https:\/\/script.google.com/u);
  });
}
test('deploy は初回 POST・2回目 PUT、secret と URL を維持', async t => {
  const { statePath, keyPath } = fixture(t); rmSync(statePath);
  writeFileSync(keyPath, JSON.stringify({ tokens: { seisaku: { refresh_token: randomBytes(16).toString('hex'), client_id: 'fixture', client_secret: randomBytes(16).toString('hex') } } }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options.method]);
    if (url.includes('oauth2')) return json({ access_token: randomBytes(16).toString('hex') });
    if (url.endsWith('/projects')) return json({ scriptId: 'fixture-project' });
    if (url.endsWith('/content')) { const body = JSON.parse(options.body); assert.ok(!body.files[0].source.includes("const RELAY_SECRET = '__RELAY_SECRET__'")); return json({}); }
    if (url.endsWith('/versions')) return json({ versionNumber: 1 });
    return json({ deploymentId: 'fixture-deployment', entryPoints: [{ webApp: { url: 'https://script.google.com/macros/s/fixture/exec' } }] });
  };
  const options = { statePath, authPath: keyPath, fetchImpl };
  const first = await deploy(options); const saved = JSON.parse(readFileSync(statePath));
  const second = await deploy(options); const updated = JSON.parse(readFileSync(statePath));
  assert.ok(saved.secret === updated.secret);
  assert.equal(first.webAppUrl, second.webAppUrl);
  assert.ok(!JSON.stringify(first).includes(saved.secret));
  assert.ok(calls.some(([url, method]) => url.endsWith('/deployments') && method === 'POST'));
  assert.ok(calls.some(([url, method]) => url.endsWith('/deployments/fixture-deployment') && method === 'PUT'));
  assert.equal(calls.filter(([url]) => url.endsWith('/projects')).length, 1);
});
test('dry-run は認証ファイル不要で通信しない', async t => {
  const opts = fixture(t); rmSync(opts.statePath);
  const result = await deploy({ ...opts, dryRun: true, authPath: '/missing', fetchImpl: () => assert.fail('通信禁止') });
  assert.equal(result.project, 'create');
});

test('下書きのトークン取得も共通中継を利用する', async t => {
  const opts = fixture(t);
  const token = randomBytes(24).toString('hex');
  assert.ok(await mintDwdToken({ ...opts, user, fetchImpl: async () => json({ ok: true, user, accessToken: token, expiresInSec: 3300 }) }) === token);
});
test('GAS GET はトークンを返さず、POST は秘密一致時のみ発行する', () => {
  let tokenCalls = 0; let aliasCalls = 0;
  const secret = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const context = vm.createContext({
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => user }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) },
    GmailApp: { getAliases: () => { aliasCalls++; return []; } },
    ScriptApp: { getOAuthToken: () => { tokenCalls++; return token; } },
  });
  vm.runInContext(readFileSync(new URL('../gas/seisaku-gmail-token/Code.js', import.meta.url), 'utf8'), context);
  const get = JSON.parse(context.doGet().value);
  assert.equal(get.service, 'seisaku-gmail-token'); assert.equal(get.accessToken, undefined);
  assert.equal(JSON.parse(context.doPost({ postData: { contents: '{}' } }).value).error, 'unauthorized');
  assert.equal(JSON.parse(context.doPost({ postData: { contents: 'invalid' } }).value).ok, false);
  assert.equal(tokenCalls, 0);
  const accepted = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ secret }) } }).value);
  assert.ok(accepted.accessToken === token); assert.equal(aliasCalls, 1); assert.equal(tokenCalls, 1);
});
