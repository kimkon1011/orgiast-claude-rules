// muse-handoff の単体テスト（P-0306）。ORGIAST_HOME は実環境に触れないよう一時ディレクトリで隔離する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  wrapSecret, unwrapSecret, parseBundle, loadProviderKey,
  getMasterKey, auditLog, redact, BUNDLE_MAGIC,
} from './muse-handoff.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-handoff-test-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
// ASCII 固定キー（env 経由の CLI テストでロスなく往復できるようにする）
const MASTER_STR = 'muse-handoff-test-master-key-0123456789abcdef';
const MASTER = Buffer.from(MASTER_STR, 'utf8');
const SECRET = 'sk-test-0123456789abcdef0123456789abcdef';

function opts(extra = {}) {
  return { masterKey: MASTER, home: HOME, notBefore: Date.now() - 1000, ...extra };
}

test('roundtrip: wrap → unwrap で秘密が一致する', () => {
  const b = wrapSecret(SECRET, opts({ scope: 'eval' }));
  const { header, secret } = unwrapSecret(b, opts({ scope: 'eval' }));
  assert.equal(secret, SECRET);
  assert.equal(header.recipient, 'muse-wonder');
  assert.deepEqual(header.scope, ['eval']);
});

test('scope 部分集合の要求は許可される（最小権限の正側）', () => {
  const b = wrapSecret(SECRET, opts({ scope: 'eval,sales,marketing' }));
  const { secret } = unwrapSecret(b, opts({ scope: 'eval' }));
  assert.equal(secret, SECRET);
});

test('権限昇格: 付与されていない scope の要求は拒否される', () => {
  const b = wrapSecret(SECRET, opts({ scope: 'eval' }));
  assert.throws(() => unwrapSecret(b, opts({ scope: 'eval,admin' })), /not granted/);
  assert.throws(() => unwrapSecret(b, opts({ scope: 'admin' })), /not granted/);
});

test('recipient 不一致は拒否される', () => {
  const b = wrapSecret(SECRET, opts({ recipient: 'muse-wonder' }));
  assert.throws(() => unwrapSecret(b, opts({ recipient: 'other-ai' })), /recipient mismatch/);
});

test('purpose 不一致は拒否される', () => {
  const b = wrapSecret(SECRET, opts({ purpose: 'eval-daily' }));
  assert.throws(() => unwrapSecret(b, opts({ purpose: 'marketing' })), /purpose mismatch/);
});

test('TTL 期限切れは拒否される（リプレイ/長期保持への防御）', () => {
  const b = wrapSecret(SECRET, opts({ ttl: 60, notBefore: Date.now() - 120000 }));
  assert.throws(() => unwrapSecret(b, opts({ now: Date.now() })), /expired/);
});

test('有効開始前（notBefore 未来）は拒否される', () => {
  const b = wrapSecret(SECRET, opts({ notBefore: Date.now() + 60000 }));
  assert.throws(() => unwrapSecret(b, opts({})), /not yet active/);
});

test('暗号文ビット反転は認証失敗（tamper-evident）', () => {
  const b = wrapSecret(SECRET, opts());
  const { aad, header, salt, nonce, tag, ct } = parseBundle(b);
  const flipped = Buffer.from(ct);
  flipped[0] ^= 0x01;
  const evilBody = Buffer.concat([salt, nonce, tag, flipped]);
  const evil = `${BUNDLE_MAGIC}.${Buffer.from(aad).toString('base64url')}.${evilBody.toString('base64url')}`;
  assert.throws(() => unwrapSecret(evil, opts()), /authentication failed/);
});

test('ヘッダ改ざん（scope 昇格の挿入）は認証失敗', () => {
  const b = wrapSecret(SECRET, opts({ scope: 'eval' }));
  const { aad, header, salt, nonce, tag, ct } = parseBundle(b);
  const evilHeader = { ...header, scope: [...header.scope, 'admin'] };
  const evilAad = Buffer.from(JSON.stringify(evilHeader), 'utf8');
  const evil = `${BUNDLE_MAGIC}.${evilAad.toString('base64url')}.${Buffer.concat([salt, nonce, tag, ct]).toString('base64url')}`;
  assert.throws(() => unwrapSecret(evil, opts()), /authentication failed/);
});

test('暗号学的束縛: ヘッダの recipient を別名に改ざんしても復号できない（HKDF 束縛）', () => {
  const b = wrapSecret(SECRET, opts({ recipient: 'muse-wonder' }));
  const { aad, header, salt, nonce, tag, ct } = parseBundle(b);
  const evilHeader = { ...header, recipient: 'evil-ai' };
  const evilAad = Buffer.from(JSON.stringify(evilHeader), 'utf8');
  const evil = `${BUNDLE_MAGIC}.${evilAad.toString('base64url')}.${Buffer.concat([salt, nonce, tag, ct]).toString('base64url')}`;
  assert.throws(() => unwrapSecret(evil, opts()), /authentication failed/);
});

test('マスターキー欠如は fail closed', () => {
  const b = wrapSecret(SECRET, opts());
  assert.throws(() => unwrapSecret(b, { home: path.join(TMP, 'empty-home') }), /no master key/);
  assert.throws(() => getMasterKey({ home: path.join(TMP, 'empty-home') }), /no master key/);
});

test('マスターキーが短い場合は拒否', () => {
  assert.throws(() => wrapSecret(SECRET, { ...opts(), masterKey: Buffer.from('short') }), /32 bytes/);
});

test('loadProviderKey: env → .claude/<name>.env の優先順位', () => {
  const home = path.join(TMP, 'pk-home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OPENROUTER_API_KEY=sk-from-file\n', 'utf8');
  assert.equal(loadProviderKey('openrouter', { home }), 'sk-from-file');
  fs.writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OPENROUTER_API_KEY=sk-from-file2\n', 'utf8');
  assert.equal(loadProviderKey('openrouter', { home }), 'sk-from-file2');
});

test('発行バンドルの出力に秘密文字列が現れない（wrap 平文リーク防止）', () => {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    const b = wrapSecret(SECRET, opts({ name: 'openrouter' }));
    parseBundle(b);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(out.join('').includes(SECRET), false);
  // バンドル文字列にも秘密は含まれない
  const b = wrapSecret(SECRET, opts());
  assert.equal(b.includes(SECRET), false);
});

test('監査ログに秘密は書かれない', () => {
  const home = path.join(TMP, 'audit-home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const b = wrapSecret(SECRET, opts({ home }));
  unwrapSecret(b, opts({ home }));
  auditLog(`sample name=openrouter`, { home });
  const log = fs.readFileSync(path.join(home, '.claude', 'logs', 'muse-handoff.log'), 'utf8');
  assert.equal(log.includes(SECRET), false);
  assert.match(log, /sample name=openrouter/);
});

test('redact は長いトークン列を伏せる', () => {
  assert.match(redact(`err with sk-test-1234567890abcdef long`), /<REDACTED>/);
  assert.ok(!redact(`err with ${SECRET}`).includes(SECRET));
});

test('CLI: open は --allow-print なしで秘密を出力しない', () => {
  const b = wrapSecret(SECRET, opts());
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const res = spawnSync(process.execPath, ['tools/muse-handoff.mjs', 'open', b, '--scope', 'eval'], {
    cwd: repo,
    env: { ...process.env, MUSE_HANDOFF_MASTER_KEY: MASTER_STR, ORGIAST_HOME: HOME },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.includes(SECRET), false);
  assert.match(res.stdout, /\[ok\]/);
});