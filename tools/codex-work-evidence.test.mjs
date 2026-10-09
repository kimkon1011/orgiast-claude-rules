import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyExternalWork } from './codex-work-evidence.mjs';
import { snapshotWorkingTree } from './codex-do.mjs';

const url = 'https://github.com/example/repo/pull/12';
const sha = 'a'.repeat(40);
test('new PR is read back; old, malformed and unavailable PRs are not success evidence', () => {
  const started = Date.now();
  const input = { output: `修正済み: ${url}`, started, status: 0 };
  for (const [createdAt, expected] of [[new Date(started).toISOString(), true], ['2020-01-01T00:00:00Z', false], ['bad', false]]) {
    const found = verifyExternalWork(input, { spawnImpl(command, args) {
      assert.equal(command, 'gh');
      assert.deepEqual(args.slice(0, 3), ['pr', 'view', url]);
      return { status: 0, stdout: JSON.stringify({ url, createdAt, headRefOid: sha, commits: [{ oid: sha }] }) };
    } });
    assert.equal(Boolean(found), expected);
  }
  assert.equal(verifyExternalWork(input, { spawnImpl: () => ({ status: 1 }) }), null);
  assert.equal(verifyExternalWork(input, { spawnImpl: () => ({ status: 0, stdout: '{}' }) }), null);
});

test('failure or timeout stays failed even when output mentions a PR', () => {
  for (const input of [{ status: 1 }, { status: 0, timedOut: true }]) {
    assert.equal(verifyExternalWork({ output: url, started: Date.now(), ...input }, { spawnImpl() { assert.fail('must not probe'); } }), null);
  }
  assert.equal(verifyExternalWork({ output: '修正しました。PR を作成する予定です', started: Date.now(), status: 0 }), null);
});

test('real committed work in another clone is detected; unchanged cwd, old and missing commits are rejected', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(['init']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'first');
  git(['add', '.']); git(['commit', '-m', 'initial']);
  const before = snapshotWorkingTree(repo);
  const started = Date.now();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'second');
  git(['add', '.']); git(['commit', '-m', 'fix']);
  const hash = git(['rev-parse', 'HEAD']);
  assert.notEqual(snapshotWorkingTree(repo), before, 'clean commit in cwd also changes snapshot');
  const input = { output: `独立 clone: ${repo}\ncommit: ${hash}\n修正済み`, started, status: 0 };
  assert.equal(verifyExternalWork(input)?.sha, hash);
  assert.equal(verifyExternalWork({ ...input, started: started + 5000 }), null);
  assert.equal(verifyExternalWork({ ...input, output: `${repo}\ncommit: deadbee` }), null);
});

test('Windows reads a WSL clone using argv, without shell interpolation', () => {
  const started = Date.now();
  const calls = [];
  const found = verifyExternalWork({ output: `/tmp/isolated\n[fix/work ${sha.slice(0, 7)}] 修正`, started, status: 0 }, {
    platform: 'win32', spawnImpl(command, args, options) {
      calls.push([command, args]);
      assert.equal(options.shell, undefined);
      return { status: 0, stdout: args.includes('show') ? `${sha}\n${Math.floor(started / 1000)}` : '' };
    },
  });
  assert.equal(found?.kind, 'commit');
  assert.deepEqual(calls[0][1].slice(0, 4), ['--exec', 'git', '-C', '/tmp/isolated']);
  assert.equal(calls[0][0], 'wsl');
});

test('CLI succeeds without escalation for a separate clone commit and still rejects an empty implementation', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const cwd = path.join(home, 'cwd'); fs.mkdirSync(cwd);
  const repo = path.join(home, 'other'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
const repo = process.env.EVIDENCE_REPO;
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git(['init']); git(['config','user.name','Test']); git(['config','user.email','test@example.invalid']);
fs.writeFileSync(repo + '/fix.txt', 'implemented'); git(['add','.']); git(['commit','-m','fix']);
console.log('修正済み clone: ' + repo + '\\ncommit: ' + git(['rev-parse','HEAD']));
`, { mode: 0o755 });
  const cli = fileURLToPath(new URL('./codex-do.mjs', import.meta.url));
  const env = { ...process.env, ORGIAST_HOME: home, CODEX_DO_AUTH_MODE: 'apikey', CODEX_DO_MOCK_RESULTS: '', EVIDENCE_REPO: repo, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const good = spawnSync(process.execPath, [cli, '--force-native', '--cwd', cwd, '--kind', 'implement', '修正して'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(good.status, 0, good.stderr);
  assert.doesNotMatch(good.stderr, /read-only サンドボックスの疑い|empty_diff/);
  const rows = fs.readFileSync(path.join(home, '.claude/executor-usage.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1, 'no unnecessary Astra execution');
  const bad = spawnSync(process.execPath, [cli, '--force-native', '--cwd', cwd, '--model', 'sol', '修正して'], { env: { ...env, CODEX_DO_MOCK_RESULTS: JSON.stringify([{ status: 0, output: '修正しました' }]) }, encoding: 'utf8', timeout: 20000 });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /read-only サンドボックスの疑い/);
});
