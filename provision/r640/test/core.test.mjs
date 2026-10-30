import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT, columns, parseCsv, password, hashes, encrypt, run, capacity, versions, atomic } from '../lib/core.mjs';
import { reconcile, accountSql, RDP_PARAMETERS } from '../bin/accounts.mjs';
import { secrets } from '../lib/keyserve.mjs';

const employees = parseCsv(fs.readFileSync(path.join(ROOT, 'employees.example.csv'), 'utf8'));
const hasAge = spawnSync('age', ['--version']).status === 0;
const hasOpenSSL = spawnSync('openssl', ['version']).status === 0;
const header = columns.join(',');
test('public desktop config parents are traversable; credential parents stay private', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r640-modes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prior = process.umask(0o077);
  try {
    atomic(path.join(dir, 'public', 'policy.json'), '{}', 0o644);
    atomic(path.join(dir, 'private', 'secret'), 'test-only');
  } finally { process.umask(prior); }
  assert.equal(fs.statSync(path.join(dir, 'public')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(dir, 'private')).mode & 0o777, 0o700);
});
test('CSV handles quoted comma, escaped quotes, BOM and CRLF', () => {
  const parsed = parseCsv(`\uFEFF${header}\r\nsample,"Test, ""Name""",test@example.invalid,employee\r\n`);
  assert.equal(parsed[0].display_name, 'Test, "Name"');
  assert.equal(employees.length, 2);
});
test('CSV rejects duplicates, reserved users, injection, extra cells, bad roles and quoting', () => {
  for (const row of ['root,x,x@example.invalid,employee', 'bad;cmd,x,x@example.invalid,employee', 'x,"bad\nname",x@example.invalid,employee', 'x,x,x@example.invalid,sudo', 'x,x,invalid,employee', 'x,x,x@example.invalid,employee,extra', 'x,"unclosed,x@example.invalid,employee', 'x,x,x@example.invalid,employee\nx,y,y@example.invalid,employee']) assert.throws(() => parseCsv(`${header}\n${row}\n`));
});
test('memory budget and versions have explicit pins', () => {
  assert.deepEqual([192, 128, 96, 64].map(capacity), [20, 20, 14, 8]);
  assert.throws(() => capacity(32));
  assert.match(versions().NODE_VERSION, /^22\.\d+\.\d+$/);
  for (const [name, value] of Object.entries(versions())) {
    assert.match(value, name === 'POSTGRES_VERSION' ? /^\d+\.\d+-bookworm$/ : /^\d+\.\d+\.\d+$/);
  }
});
test('openssl passwords have 256 bits, salted hashes match Guacamole JDBC algorithm', { skip: !hasOpenSSL }, () => {
  const values = new Set(Array.from({ length: 100 }, password));
  assert.equal(values.size, 100);
  for (const value of values) assert.match(value, /^[a-f0-9]{64}$/);
  const secret = password(), result = hashes(secret);
  assert.match(result.linux, /^\$6\$/);
  assert.equal(result.guac, createHash('sha256').update(secret + result.salt.toUpperCase()).digest('hex'));
  assert.equal(run('openssl', ['passwd', '-6', '-salt', result.linux.split('$')[2], '-stdin'], `${secret}\n`).trim(), result.linux);
});
function identity() { const privateKey = run('age-keygen'); return { privateKey, recipient: run('age-keygen', ['-y'], privateKey).trim() }; }
function decrypt(ciphertext, key, dir) { const file = path.join(dir, 'cipher.age'); fs.writeFileSync(file, ciphertext); return run('age', ['--decrypt', '--identity', '-', file], key); }
test('age roundtrip; plaintext never appears in archives or captured failure output', { skip: !hasAge || !hasOpenSSL }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r640-age-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = identity(), secret = password(), cipher = encrypt(secret, key.recipient);
  assert.ok(!cipher.includes(secret));
  assert.equal(decrypt(cipher, key.privateKey, directory), secret);
  assert.throws(() => run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(secret)});process.exit(1)`]), error => !error.message.includes(secret));
});
test('account crash recovery, idempotence, salted-only state, scoped prune and no sudo', { skip: !hasAge || !hasOpenSSL }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r640-accounts-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = identity(), site = { ageRecipient: key.recipient, hostname: 'desktop.example.test' }, existing = new Set(['external']);
  const calls = [];
  const runner = (cmd, args = [], input) => {
    calls.push({ cmd, args, input });
    if (cmd === 'getent') return [...existing].map(u => `${u}:x:1000:1000::/home/${u}:/bin/bash`).join('\n');
    if (cmd === 'id') return 'orgiast-r640';
    if (cmd === 'useradd') existing.add(args.at(-1));
    if (cmd === 'loginctl') return '';
    return '';
  };
  assert.throws(() => reconcile(employees, site, { directory, runner, sync: () => { throw new Error('DB down'); } }));
  const pending = JSON.parse(fs.readFileSync(path.join(directory, 'accounts.json')));
  assert.ok(Object.values(pending).every(v => v.pending));
  const archive = fs.readFileSync(path.join(directory, 'initial-passwords.csv.age'), 'utf8');
  const plaintext = decrypt(archive, key.privateKey, directory);
  const secret = plaintext.trim().split('\n')[1].split(',').at(-1).replaceAll('"', '');
  assert.ok(!fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8').includes(secret));
  const statements = [];
  reconcile(employees, site, { directory, runner, sync: s => statements.push(s) });
  assert.equal(fs.readFileSync(path.join(directory, 'initial-passwords.csv.age'), 'utf8'), archive);
  const applied = calls.filter(c => c.cmd === 'chpasswd').length;
  reconcile(employees, site, { directory, runner, sync: s => statements.push(s) });
  assert.equal(calls.filter(c => c.cmd === 'chpasswd').length, applied);
  assert.ok(!statements.join('').includes(secret));
  reconcile(employees.slice(0, 1), site, { directory, runner, sync: () => {}, prune: true });
  assert.ok(calls.some(c => c.cmd === 'usermod' && c.args.includes('--lock') && c.args.includes(employees[1].username)));
  assert.ok(!calls.some(c => c.args.includes('external')));
  assert.ok(!calls.some(c => c.cmd === 'userdel'));
  assert.throws(() => reconcile([], site, { directory, runner, sync: () => {}, prune: true }));
  assert.ok(!calls.some(c => c.cmd === 'usermod' && c.args.includes('sudo')));
});
test('SQL only grants own desktop READ and uses real tokens', () => {
  const state = Object.fromEntries(employees.map(u => [u.username, { guac: 'a'.repeat(64), salt: 'b'.repeat(64) }]));
  const statement = accountSql(employees, state);
  for (const value of Object.values(RDP_PARAMETERS)) assert.ok(statement.includes(value));
  assert.ok(!statement.includes('%PASSWORD%'));
  assert.ok(!statement.includes('guacamole_system_permission'));
  assert.ok(statement.includes('ON CONFLICT(entity_id) DO UPDATE SET disabled=false'));
});
test('dry-run succeeds and does not call mutation commands or generate password', t => {
  if (process.platform === 'win32') return t.skip('bash verification runs on Linux');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r640-dry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const command of ['openssl', 'age', 'sudo', 'useradd', 'apt-get', 'docker', 'systemctl', 'ufw']) fs.writeFileSync(path.join(dir, command), '#!/bin/sh\necho MUTATION >&2\nexit 91\n', { mode: 0o755 });
  const result = spawnSync('bash', [path.join(ROOT, 'bin/provision.sh'), '--dry-run', '--csv', path.join(ROOT, 'employees.example.csv')], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`OK: users=${employees.length} desktop=xfce guacamole=planned xrdp=planned`));
  assert.ok(!result.stderr.includes('MUTATION'));
  assert.equal(fs.readdirSync(dir).length, 8);
});
test('keyserve uses HMAC, extracts only r640.json, rejects insecure URL', async () => {
  const env = { ORGIAST_KEYSERVE_SECRET: 'test-only-hmac-secret', ORGIAST_KEYSERVE_PC: 'test-pc', ORGIAST_KEYSERVE_URL: 'https://keys.example.invalid/keys' };
  let calls = 0;
  const result = await secrets(async (_url, options) => { calls++; assert.equal(options.method, 'POST'); assert.match(options.headers['x-orgiast-auth'], /^[a-f0-9]{64}$/); return { ok: true, json: async () => ({ files: { 'r640.json': '{"databasePassword":"test-only"}' } }) }; }, env);
  assert.equal(calls, 1); assert.equal(result.databasePassword, 'test-only');
  await assert.rejects(secrets(async () => { throw new Error('should not fetch'); }, { ...env, ORGIAST_KEYSERVE_URL: 'http://keys.invalid' }), /HTTPS/);
});
