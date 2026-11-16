import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ダミー鍵 — テスト内で生成し、実際の鍵には触れない
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_EMAIL = 'test-sa@test-project.iam.gserviceaccount.com';
const SA_JSON = JSON.stringify({ client_email: SA_EMAIL, private_key: privateKey });
const ACCESS_TOKEN = 'ya29.test-token-value';

function decodeJwtClaims(jwt) {
  const parts = jwt.split('.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}

test('getServiceAccountToken reads from GOOGLE_SERVICE_ACCOUNT_JSON env var', async (t) => {
  const orig = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  t.after(() => { process.env.GOOGLE_SERVICE_ACCOUNT_JSON = orig; });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;

  const { getServiceAccountToken } = await import('./drive-auth.mjs');
  const token = await getServiceAccountToken({
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const claims = decodeJwtClaims(body.get('assertion'));
      assert.equal(claims.sub, undefined, 'SA本人モードのJWTに sub があってはいけない');
      assert.equal(claims.iss, SA_EMAIL);
      return Response.json({ access_token: ACCESS_TOKEN });
    },
  });
  assert.equal(token, ACCESS_TOKEN);
});

test('getServiceAccountToken reads from ~/.claude/workspace-sa.env fallback', async (t) => {
  const saEnvPath = path.join(os.homedir(), '.claude', 'workspace-sa.env');
  const origEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let origFile = '';
  let fileExisted = false;
  try {
    origFile = fs.readFileSync(saEnvPath, 'utf8');
    fileExisted = true;
  } catch { /* ファイルが存在しなくてもOK */ }
  t.after(() => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = origEnv;
    if (fileExisted) fs.writeFileSync(saEnvPath, origFile, 'utf8');
    else try { fs.unlinkSync(saEnvPath); } catch { /* ignore */ }
  });
  // env を空にしてファイルフォールバックを強制
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '';
  fs.mkdirSync(path.dirname(saEnvPath), { recursive: true });
  fs.writeFileSync(saEnvPath, `GOOGLE_SERVICE_ACCOUNT_JSON=${SA_JSON}\n`, 'utf8');

  const { getServiceAccountToken } = await import('./drive-auth.mjs');
  const token = await getServiceAccountToken({
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const claims = decodeJwtClaims(body.get('assertion'));
      assert.equal(claims.sub, undefined);
      assert.equal(claims.iss, SA_EMAIL);
      return Response.json({ access_token: ACCESS_TOKEN });
    },
  });
  assert.equal(token, ACCESS_TOKEN);
});

test('invalid JSON throws without leaking the value', async (t) => {
  const orig = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  t.after(() => { process.env.GOOGLE_SERVICE_ACCOUNT_JSON = orig; });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{invalid json!!!}';

  const { getServiceAccountToken } = await import('./drive-auth.mjs');
  await assert.rejects(
    () => getServiceAccountToken({ fetchImpl: async () => new Response('{}') }),
    (err) => {
      assert.equal(err.message, 'サービスアカウントJSONのパースに失敗しました');
      assert.doesNotMatch(err.message, /invalid/u);
      return true;
    },
  );
});

test('missing client_email/private_key throws without leaking values', async (t) => {
  const orig = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  t.after(() => { process.env.GOOGLE_SERVICE_ACCOUNT_JSON = orig; });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: '', private_key: '' });

  const { getServiceAccountToken } = await import('./drive-auth.mjs');
  await assert.rejects(
    () => getServiceAccountToken({ fetchImpl: async () => new Response('{}') }),
    (err) => {
      assert.equal(err.message, 'サービスアカウントJSONの形式が不正です（client_email/private_key が不足）');
      return true;
    },
  );
});

test('no env var and no file throws a clear error', async (t) => {
  const saEnvPath = path.join(os.homedir(), '.claude', 'workspace-sa.env');
  const origEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let origFile = '';
  let fileExisted = false;
  try {
    origFile = fs.readFileSync(saEnvPath, 'utf8');
    fileExisted = true;
  } catch { /* ファイルが存在しなくてもOK */ }
  t.after(() => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = origEnv;
    if (fileExisted) fs.writeFileSync(saEnvPath, origFile, 'utf8');
    else try { fs.unlinkSync(saEnvPath); } catch { /* ignore */ }
  });
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  // ファイルが存在しない or 空の状態にする
  try { fs.unlinkSync(saEnvPath); } catch { /* ignore */ }

  const { getServiceAccountToken } = await import('./drive-auth.mjs');
  await assert.rejects(
    () => getServiceAccountToken({ fetchImpl: async () => new Response('{}') }),
    (err) => {
      assert.match(err.message, /サービスアカウントJSONが見つかりません/u);
      return true;
    },
  );
});

test('getDriveToken with asServiceAccount:true delegates to SA本人モード', async (t) => {
  const orig = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  t.after(() => { process.env.GOOGLE_SERVICE_ACCOUNT_JSON = orig; });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA_JSON;

  const { getDriveToken } = await import('./drive-auth.mjs');
  const token = await getDriveToken({
    asServiceAccount: true,
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const claims = decodeJwtClaims(body.get('assertion'));
      assert.equal(claims.sub, undefined, 'asServiceAccount:true でも sub が付かない');
      return Response.json({ access_token: ACCESS_TOKEN });
    },
  });
  assert.equal(token, ACCESS_TOKEN);
});

test('existing getDriveToken path still uses sub (impersonation)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-auth-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const keyPath = path.join(tmpDir, 'test-sa.json');
  fs.writeFileSync(keyPath, SA_JSON, 'utf8');

  const origKey = process.env.GOOGLE_SA_KEY;
  t.after(() => { process.env.GOOGLE_SA_KEY = origKey; });
  process.env.GOOGLE_SA_KEY = keyPath;

  const { getDriveToken } = await import('./drive-auth.mjs');
  const token = await getDriveToken({
    impersonate: 'user@test.com',
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      const claims = decodeJwtClaims(body.get('assertion'));
      assert.equal(claims.sub, 'user@test.com', '既存経路では sub に impersonate が入る');
      assert.equal(claims.iss, SA_EMAIL);
      return Response.json({ access_token: ACCESS_TOKEN });
    },
  });
  assert.equal(token, ACCESS_TOKEN);
});