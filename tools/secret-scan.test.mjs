import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSecret } from './lib/secret-scan.mjs';
import { rescueTree } from './rescue-policy.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-secret-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'base');
  git('init', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  const messages = [];
  const options = { now: new Date(2026, 10, 18, 12).getTime(), notify: async message => { messages.push(message); return { delivered: 'dm' }; } };
  return { repo, home, git, messages, options };
}

test('secret file is excluded while normal file remains in rescue commit', async t => {
  const f = fixture(t);
  const dummy = 'sk-THIS_IS_A_DUMMY_TOKEN_12345';
  fs.writeFileSync(path.join(f.repo, 'secret.js'), `const token = "${dummy}";\n`);
  fs.writeFileSync(path.join(f.repo, 'normal.js'), 'export const ok = true;\n');
  const result = await rescueTree(f.repo, f.home, f.options);
  assert.equal(f.git('show', 'HEAD:normal.js'), 'export const ok = true;\n');
  assert.throws(() => f.git('show', 'HEAD:secret.js'));
  assert.equal(fs.readFileSync(path.join(f.repo, 'secret.js'), 'utf8'), `const token = "${dummy}";\n`);
  const output = JSON.stringify({ events: result.events, messages: f.messages });
  assert.match(output, /secret\.js/);
  assert.match(output, /api-token|assigned-secret/);
  assert.doesNotMatch(output, new RegExp(dummy));
});

test('all excluded files skip commit and push without changing local file', async t => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(f.repo, '.env'), 'PASSWORD="dummy-password-value"\n');
  const result = await rescueTree(f.repo, f.home, f.options);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), before);
  assert.equal(f.git('for-each-ref', '--format=%(refname)', 'refs/heads/rescue/'), '');
  assert.ok(result.events.some(event => event.step === 'RESCUE_EMPTY_AFTER_SECRET_SCAN'));
  assert.ok(fs.existsSync(path.join(f.repo, '.env')));
});

test('filename and known-prefix patterns are classified without exposing values', () => {
  assert.deepEqual(scanSecret({ filePath: 'config/credentials-prod.json', content: '{}' }), ['credentials-file']);
  assert.deepEqual(scanSecret({ filePath: 'cert/server.pem', content: 'public material' }), ['private-key-file']);
  assert.ok(scanSecret({ filePath: 'x.txt', content: '-----BEGIN TEST PRIVATE KEY-----' }).includes('private-key'));
  for (const value of ['ghp_123456789012', 'xoxb-123456789012', 'AKIA1234567890123456', 'AIza123456789012', 'sk-123456789012']) {
    assert.ok(scanSecret({ filePath: 'x.txt', content: value }).length > 0, value);
  }
});

test('descriptive words and environment references do not cause false positives', () => {
  for (const content of [
    'This paragraph explains the password policy.\n',
    'const token = process.env.API_TOKEN;\n',
    'password = "short"\n',
    'export function secretSauce() { return true; }\n',
  ]) assert.deepEqual(scanSecret({ filePath: 'docs/example.js', content }), []);
});
