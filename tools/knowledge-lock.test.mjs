import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { main, canonicalVerdict, parseCredentialBlob } from './knowledge-lock.mjs';
import { sealText, parseSealed, isSealed, openWithDataKey } from './lib/knowledge-envelope.mjs';
import { loadLedger } from './claude-account-ledger.mjs';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const plaintext = '引き継ぎの秘密\n日本語と emoji 🔑\n';
const makeSeal = (value = plaintext) => sealText(value, { name: 'handover.md', publicKeyPem: pair.publicKey, kid: 'k1' });
const unwrap = env => crypto.privateDecrypt({ key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(env.wrappedKey, 'base64url'));
const response = (data, ok = true) => ({ ok, json: async () => data });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-secret-test' } }));
  fs.writeFileSync(path.join(root, 'claude-account-ledger.json'), JSON.stringify(loadLedger()));
  fs.writeFileSync(path.join(root, 'knowledge-lock-pubkey.pem'), pair.publicKey);
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const f = { root, stdout: '', stderr: '', calls: [] };
  f.deps = { home: root, toolsDir: root, serverDir: root,
    env: { ORGIAST_KEYSERVE_SECRET: 'pc-secret', ORGIAST_KEYSERVE_PC: 'test-PC', ORGIAST_KEYSERVE_URL: 'https://example.test/api/keys' },
    stdout: text => { f.stdout += text; }, stderr: text => { f.stderr += text; },
    fetch: async () => { throw new Error('unexpected network'); },
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = input => {
        f.calls.push({ command, args, options, input });
        queueMicrotask(() => { child.stdout.emit('data', input); child.stderr.emit('data', input); child.emit('close', 0); });
      };
      return child;
    },
  };
  f.run = args => main(args, f.deps);
  return f;
}

function signed(contracted = true, reason = contracted ? 'active_email' : 'not_in_ledger', overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const verdict = { email: 'kim@orgiast.jp', orgUuid: 'org', contracted, reason, pcId: 'test-PC', iat: now, exp: now + 86400, ...overrides };
  const sig = crypto.sign('sha256', Buffer.from(canonicalVerdict(verdict)), { key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
  return { verdict, sig };
}

function blob() {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const value = { id: crypto.randomBytes(16).toString('base64url'), spki: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), alg: -7, createdAt: new Date().toISOString() };
  return { value, text: `${Buffer.from(JSON.stringify(value)).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}` };
}

test('seal → RSA-OAEP 復号 → open の往復と各 AAD/ct 改ざん検出', () => {
  const text = makeSeal();
  assert.equal(isSealed(text), true);
  assert.equal(isSealed('not sealed'), false);
  const env = parseSealed(text);
  const key = unwrap(env);
  assert.equal(openWithDataKey(env, key), plaintext);
  const empty = parseSealed(makeSeal(''));
  assert.equal(openWithDataKey(empty, unwrap(empty)), '');
});

test('ct, name, sealedAt, sha256, tag の改ざんと不正形式を拒否', () => {
  const env = parseSealed(makeSeal());
  const key = unwrap(env);
  for (const [field, value] of Object.entries({ ct: crypto.randomBytes(32).toString('base64url'), name: 'other.md', sealedAt: '2020-01-01T00:00:00.000Z', sha256: '0'.repeat(64), tag: crypto.randomBytes(16).toString('base64url') })) {
    assert.throws(() => openWithDataKey({ ...env, [field]: value }, key), field);
  }
  assert.throws(() => parseSealed('ORGLOCK1\nnull'));
  assert.throws(() => parseSealed(`ORGLOCK1\n${JSON.stringify({ ...env, iv: 'bad=' })}`));
  assert.throws(() => openWithDataKey(env, Buffer.alloc(31)));
  // 正しい GCM tag でも、平文ハッシュの不一致を独立に検出する。
  const altered = { ...env, sha256: '0'.repeat(64) };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64url'));
  cipher.setAAD(Buffer.from(`ORGLOCK1|${altered.name}|${altered.sealedAt}|${altered.sha256}`));
  altered.ct = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url');
  altered.tag = cipher.getAuthTag().toString('base64url');
  assert.throws(() => openWithDataKey(altered, key), /ハッシュ/);
});

test('seal は通信せず、未設定の公開鍵は exit 2', async t => {
  const f = fixture(t);
  const input = path.join(f.root, 'input.md');
  fs.writeFileSync(input, plaintext);
  assert.equal(await f.run(['seal', input]), 0);
  assert.equal(isSealed(fs.readFileSync(`${input}.lock`, 'utf8')), true);
  fs.rmSync(path.join(f.root, 'knowledge-lock-pubkey.pem'));
  assert.equal(await f.run(['seal', input]), 2);
  assert.match(f.stderr, /公開鍵未設定/);
  assert.equal(await f.run(['status']), 0);
  assert.match(f.stdout, /公開鍵未設定/);
});

test('open の ok / approval_required / request・grant / --out', async t => {
  const f = fixture(t);
  const text = makeSeal(); const env = parseSealed(text); const key = unwrap(env);
  const file = path.join(f.root, 'file.lock'); fs.writeFileSync(file, text);
  let mode = 'ok';
  f.deps.fetch = async (url, init) => {
    assert.equal(url, 'https://example.test/api/knowledge');
    assert.equal(init.headers['x-orgiast-pc'], 'test-PC');
    assert.match(init.headers['x-orgiast-auth'], /^[a-f0-9]{64}$/);
    const body = JSON.parse(init.body);
    assert.equal(body.claudeToken, 'oauth-secret-test');
    assert.equal(body.action, 'unwrap'); assert.equal(body.wrappedKey, env.wrappedKey);
    if (mode === 'approval') return response({ status: 'approval_required', request: 'request-token', approveUrl: 'https://approve.test', dmSent: false }, false);
    if (mode === 'grant') { assert.equal(body.request, 'request-token'); assert.equal(body.grant, '12345678'); }
    return response({ status: 'ok', dataKey: key.toString('base64url') });
  };
  assert.equal(await f.run(['open', file]), 0); assert.equal(f.stdout, plaintext);
  f.stdout = ''; mode = 'approval';
  assert.equal(await f.run(['open', file]), 3);
  assert.match(f.stderr, /--request request-token/); assert.match(f.stderr, /リンク: https:\/\/approve.test/); assert.equal(f.stdout, '');
  mode = 'grant'; const output = path.join(f.root, 'opened.md');
  assert.equal(await f.run(['open', file, '--request', 'request-token', '--grant', '12345678', '--out', output]), 0);
  assert.equal(fs.readFileSync(output, 'utf8'), plaintext);
  assert.equal(f.stdout, '');
  assert.ok(!f.stderr.includes(key.toString('base64url')) && !f.stderr.includes('oauth-secret-test'));
});

for (const [name, result, expected] of [
  ['契約', signed(), 0], ['契約外', signed(false), 4], ['判定不能', signed(false, 'profile_unavailable'), 5],
  ['署名改ざん', { ...signed(), sig: 'bad' }, 5], ['別PC', signed(true, 'active_email', { pcId: 'other-PC' }), 5],
  ['期限切れ', signed(true, 'active_email', { exp: 1 }), 5],
]) test(`verify-account: ${name}`, async t => {
  const f = fixture(t);
  f.deps.fetch = async () => response(result);
  assert.equal(await f.run(['verify-account', '--json']), expected);
  const saved = path.join(f.root, '.claude/state/knowledge-verdict.json');
  if (['契約', '契約外', '判定不能'].includes(name)) assert.deepEqual(JSON.parse(fs.readFileSync(saved)), result);
  else assert.equal(fs.existsSync(saved), false);
  assert.ok(!f.stdout.includes('oauth-secret-test'));
});

test('通信例外の秘密を出力せず verify は exit 5', async t => {
  const f = fixture(t);
  f.deps.fetch = async () => { throw new Error(`oauth-secret-test ${pair.privateKey}`); };
  assert.equal(await f.run(['verify-account']), 5);
  assert.ok(!f.stderr.includes('oauth-secret-test') && !f.stderr.includes('PRIVATE KEY'));
});

test('keygen 計画は無変更、apply は RSA-3072 を stdin のみに渡す (Windows shell)', async t => {
  const f = fixture(t); const pub = path.join(f.root, 'knowledge-lock-pubkey.pem');
  assert.equal(await f.run(['keygen']), 2); assert.match(f.stderr, /_OLD/);
  fs.rmSync(pub);
  assert.equal(await f.run(['keygen', '--kid', 'k2']), 0);
  assert.equal(fs.existsSync(pub), false); assert.equal(f.calls.length, 0);
  f.deps.platform = 'win32';
  assert.equal(await f.run(['keygen', '--kid', 'k2', '--apply']), 0);
  assert.equal(f.calls.length, 6);
  for (const call of f.calls) {
    assert.equal(call.command, 'vercel.cmd'); assert.equal(call.options.shell, true); assert.equal(call.options.cwd, f.root);
    assert.equal(call.args[0], 'env'); assert.equal(call.args[1], 'add'); assert.equal(call.args[4], '--sensitive');
    assert.ok(['production', 'preview'].includes(call.args[3]));
    assert.ok(!f.stdout.includes(call.input) || call.input === 'k2');
  }
  const privatePem = f.calls.find(c => c.args[2] === 'KNOWLEDGE_LOCK_PRIVATE_KEY').input;
  assert.equal(crypto.createPrivateKey(privatePem).asymmetricKeyDetails.modulusLength, 3072);
  assert.equal(crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }), fs.readFileSync(pub, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'knowledge-lock-pubkey.json'))).kid, 'k2');
  assert.ok(!f.stdout.includes('PRIVATE KEY') && !f.stderr.includes(privatePem));
  assert.match(f.stdout, /再デプロイ.*kim 承認待ち/);
  for (const name of fs.readdirSync(f.root)) {
    if (fs.statSync(path.join(f.root, name)).isFile()) assert.ok(!fs.readFileSync(path.join(f.root, name), 'utf8').includes('PRIVATE KEY'));
  }
});

test('passkey-install は形式を検査し公開情報全体を rm→add、計画では無変更', async t => {
  const f = fixture(t); const first = blob(); const second = blob();
  assert.deepEqual(parseCredentialBlob(first.text), first.value);
  assert.throws(() => parseCredentialBlob('bad.bad'));
  assert.equal(await f.run(['passkey-install', '--blob', first.text]), 0);
  const file = path.join(f.root, 'knowledge-passkeys.json');
  assert.equal(fs.existsSync(file), false); assert.equal(f.calls.length, 0);
  fs.writeFileSync(file, JSON.stringify([first.value]));
  assert.equal(await f.run(['passkey-install', '--blob', second.text, '--apply']), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), [first.value, second.value]);
  assert.equal(f.calls.length, 4);
  for (const target of ['production', 'preview']) {
    const calls = f.calls.filter(c => c.args[3] === target);
    assert.deepEqual(calls[0].args, ['env', 'rm', 'KIM_PASSKEY_CREDENTIALS', target, '-y']);
    assert.deepEqual(calls[1].args, ['env', 'add', 'KIM_PASSKEY_CREDENTIALS', target, '--sensitive']);
    assert.deepEqual(JSON.parse(calls[1].input), [first.value, second.value]);
  }
  assert.ok(!f.stdout.includes(second.text));
});

test('ledger-sync は差分計画、apply は全投影を stdin に渡す', async t => {
  const f = fixture(t);
  assert.equal(await f.run(['ledger-sync']), 0); assert.equal(f.calls.length, 0);
  assert.match(f.stdout, /追加=/);
  assert.equal(await f.run(['ledger-sync', '--apply']), 0); assert.equal(f.calls.length, 4);
  const calls = f.calls.filter(c => c.args[1] === 'add');
  assert.equal(calls[0].args[2], 'KNOWLEDGE_LEDGER_JSON');
  assert.equal(JSON.parse(calls[0].input).activeEmails.length, 4);
  assert.equal(calls[0].input, calls[1].input);
  f.stdout = '';
  assert.equal(await f.run(['ledger-sync']), 0); assert.match(f.stdout, /追加=\[\] 削除=\[\]/);
});

test('passkey-link は URL と dmSent のみ表示', async t => {
  const f = fixture(t);
  f.deps.fetch = async (_, init) => {
    assert.deepEqual(JSON.parse(init.body), { action: 'register-link' });
    return response({ registerUrl: 'https://register.test', dmSent: true });
  };
  assert.equal(await f.run(['passkey-link']), 0); assert.match(f.stdout, /registerUrl: https:\/\/register.test\ndmSent: true/);
});

const serverFile = process.env.ORGIAST_KEYSERVE_REPO
  ? path.join(process.env.ORGIAST_KEYSERVE_REPO, 'api/knowledge.js')
  : process.platform === 'win32' ? 'C:/Users/uers/Downloads/orgiast-keyserve/api/knowledge.js'
    : '/mnt/c/Users/uers/Downloads/orgiast-keyserve/api/knowledge.js';
test('実サーバ handler E2E: 契約開封、契約外→WebAuthn承認→grant開封', { skip: !fs.existsSync(serverFile) }, async t => {
  const f = fixture(t);
  const handler = createRequire(import.meta.url)(serverFile);
  const envNames = ['KNOWLEDGE_LOCK_PRIVATE_KEY', 'KNOWLEDGE_LOCK_KID', 'KNOWLEDGE_LEDGER_JSON', 'KNOWLEDGE_GRANT_SECRET', 'ORGIAST_SHARED_SECRET', 'ORGIAST_REVOKED_PCS', 'DISCORD_BOT_TOKEN', 'KIM_DISCORD_USER_ID', 'KIM_PASSKEY_CREDENTIALS', 'KNOWLEDGE_PUBLIC_BASE_URL'];
  const previous = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of envNames) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    handler._setFetch(globalThis.fetch);
  });
  for (const key of envNames) delete process.env[key];
  const passkey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = crypto.randomBytes(16).toString('base64url');
  Object.assign(process.env, { KNOWLEDGE_LOCK_PRIVATE_KEY: pair.privateKey, KNOWLEDGE_LOCK_KID: 'k1',
    KNOWLEDGE_LEDGER_JSON: JSON.stringify({ activeEmails: ['kim@orgiast.jp'] }), KNOWLEDGE_GRANT_SECRET: 'test-grant-secret', ORGIAST_SHARED_SECRET: 'pc-secret',
    KNOWLEDGE_PUBLIC_BASE_URL: 'https://knowledge.test', KIM_PASSKEY_CREDENTIALS: JSON.stringify([{ id: credentialId, spki: passkey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), alg: -7 }]) });
  let email = 'kim@orgiast.jp'; let pending;
  handler._setFetch(async url => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/profile');
    return response({ account: { email }, organization: { uuid: 'test-org' } });
  });
  async function dispatch(body, headers = {}) {
    let result; const res = { statusCode: 200, setHeader() {}, end(text) { result = JSON.parse(text); } };
    await handler({ method: 'POST', body, headers }, res);
    return { status: res.statusCode, result };
  }
  f.deps.fetch = async (_, init) => {
    const { status, result } = await dispatch(JSON.parse(init.body), init.headers);
    if (result.status === 'approval_required') pending = result.request;
    return response(result, status < 400);
  };
  const input = path.join(f.root, 'handover.md'); fs.writeFileSync(input, plaintext);
  assert.equal(await f.run(['seal', input]), 0); f.stdout = '';
  assert.equal(await f.run(['open', `${input}.lock`]), 0); assert.equal(f.stdout, plaintext);
  assert.equal(await f.run(['verify-account']), 0);
  email = 'external@example.com'; f.stdout = '';
  assert.equal(await f.run(['open', `${input}.lock`]), 3); assert.ok(pending);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: 'https://knowledge.test', challenge: crypto.createHash('sha256').update(`approve:${pending}`).digest('base64url') }));
  const authenticatorData = Buffer.alloc(37);
  crypto.createHash('sha256').update('knowledge.test').digest().copy(authenticatorData); authenticatorData[32] = 0x05;
  const signedData = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const approved = await dispatch({ action: 'approve', request: pending, credentialId,
    clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
    signature: crypto.sign('sha256', signedData, passkey.privateKey).toString('base64url') });
  assert.equal(approved.status, 200); assert.equal(approved.result.grant.length, 8);
  assert.equal(await f.run(['open', `${input}.lock`, '--request', pending, '--grant', '00000000']), 2);
  assert.equal(f.stdout, '');
  assert.equal(await f.run(['open', `${input}.lock`, '--request', pending, '--grant', approved.result.grant]), 0);
  assert.equal(f.stdout, plaintext);
});

test('Vercel 失敗時は子プロセスの秘密を表示せず、同期済みと記録しない', async t => {
  const f = fixture(t);
  f.deps.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => {
      child.stderr.emit('data', `oauth-secret-test ${pair.privateKey}`);
      child.emit('close', 1);
    });
    return child;
  };
  assert.equal(await f.run(['ledger-sync', '--apply']), 2);
  assert.equal(fs.existsSync(path.join(f.root, 'knowledge-ledger-synced.json')), false);
  assert.ok(!f.stderr.includes('oauth-secret-test') && !f.stderr.includes('PRIVATE KEY'));
  assert.ok(!f.stdout.includes('kim 承認待ち'));
});

test('passkey blob は欠落・不正SPKI・鍵種別不一致を拒否', () => {
  const valid = blob();
  for (const change of [{ spki: 'bad' }, { alg: -257 }, { createdAt: 'invalid' }, { id: '' }]) {
    const encoded = Buffer.from(JSON.stringify({ ...valid.value, ...change })).toString('base64url');
    assert.throws(() => parseCredentialBlob(`${encoded}.${'A'.repeat(43)}`));
  }
});

test('DM送信済みの承認依頼は request を表示、片方だけの grant 引数は拒否', async t => {
  const f = fixture(t); const file = path.join(f.root, 'file.lock'); fs.writeFileSync(file, makeSeal());
  f.deps.fetch = async () => response({ status: 'approval_required', request: 'signed-request', approveUrl: 'https://approve.test', dmSent: true }, false);
  assert.equal(await f.run(['open', file]), 3);
  assert.match(f.stderr, /kim のスマホに承認リンクを送りました/);
  assert.match(f.stderr, /--request signed-request/);
  assert.equal(await f.run(['open', file, '--grant', '12345678']), 2);
});
