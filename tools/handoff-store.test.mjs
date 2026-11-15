import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readHandoff, writeHandoff } from './lib/handoff-store.mjs';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
function fixture(t, enabled = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-store-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test' } }));
  if (enabled) fs.writeFileSync(path.join(home, 'knowledge-lock-pubkey.pem'), pair.publicKey);
  const deps = { home, toolsDir: home, env: { ORGIAST_KEYSERVE_SECRET: 'test', ORGIAST_KEYSERVE_PC: 'test-PC' },
    fetch: async (_url, options) => {
      assert.ok(options.signal);
      const body = JSON.parse(options.body);
      assert.equal(body.action, 'unwrap');
      const key = crypto.privateDecrypt({ key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.wrappedKey, 'base64url'));
      return { ok: true, json: async () => ({ status: 'ok', dataKey: key.toString('base64url') }) };
    } };
  return { file: path.join(home, 'next-session.md'), deps };
}
test('no public key: plaintext only, existing lock never opened', async t => {
  const { file, deps } = fixture(t, false);
  deps.fetch = () => assert.fail('network');
  writeHandoff(file, 'plain\n', deps);
  assert.equal(fs.existsSync(file + '.lock'), false);
  assert.equal(await readHandoff(file, deps), 'plain\n');
  fs.writeFileSync(file + '.lock', 'ignored');
  fs.unlinkSync(file);
  await assert.rejects(readHandoff(file, deps), { code: 'ENOENT' });
});
test('public key: fresh lock on each write, plaintext preferred, lock-only roundtrip', async t => {
  const { file, deps } = fixture(t);
  writeHandoff(file, 'old', deps);
  const old = fs.readFileSync(file + '.lock', 'utf8');
  writeHandoff(file, '日本語 🔑\n', deps);
  assert.notEqual(fs.readFileSync(file + '.lock', 'utf8'), old);
  assert.equal(await readHandoff(file, { ...deps, fetch: () => assert.fail('network') }), '日本語 🔑\n');
  fs.unlinkSync(file);
  assert.equal(await readHandoff(file, deps), '日本語 🔑\n');
});
test('approval_required preserves request and approveUrl', async t => {
  const { file, deps } = fixture(t);
  writeHandoff(file, 'secret', deps); fs.unlinkSync(file);
  deps.fetch = async () => ({ ok: false, json: async () => ({ status: 'approval_required', request: 'request', approveUrl: 'https://example.test/approve' }) });
  await assert.rejects(readHandoff(file, deps), { code: 'approval_required', request: 'request', approveUrl: 'https://example.test/approve' });
});
test('seal failure still saves plaintext and logs without exposing content', t => {
  const { file, deps } = fixture(t);
  writeHandoff(file, 'secret text', { ...deps, sealText: () => { throw Error('secret text'); } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret text');
  const log = fs.readFileSync(path.join(deps.home, '.claude/logs/knowledge-lock.log'), 'utf8');
  assert.match(log, /seal failed/); assert.doesNotMatch(log, /secret text/);
});
test('open request aborts after eight seconds', async t => {
  const { file, deps } = fixture(t);
  writeHandoff(file, 'secret', deps); fs.unlinkSync(file);
  let elapsed;
  deps.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    const started = Date.now();
    const keepAlive = setTimeout(() => reject(Error('timeout missing')), 10000);
    signal.addEventListener('abort', () => {
      elapsed = Date.now() - started;
      clearTimeout(keepAlive);
      reject(signal.reason);
    }, { once: true });
  });
  await assert.rejects(readHandoff(file, deps), { code: 'knowledge_open_failed' });
  assert.ok(elapsed >= 7900 && elapsed < 9500, String(elapsed));
});
