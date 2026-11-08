import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { FILES, installDir } from './knowledge-pack.mjs';

test('clean-install receiver installs validated fixture bytes; required verifier still rejects missing knowledge', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-install-knowledge-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve(import.meta.dirname, '..');
  const item = JSON.parse(fs.readFileSync(path.join(repo, 'tools/setup-manifest.json'), 'utf8')).items.find(x => x.id === 'knowledge:production-sales');
  assert.equal(item.severity, 'required');
  const manifest = path.join(home, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, items: [item] }));
  const run = args => spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true });
  const verify = () => run(['tools/setup.mjs', '--verify', '--manifest', manifest, '--home', home]);
  assert.equal(verify().status, 1, 'missing knowledge must fail');
  const result = run(['--import', './.github/fixtures/knowledge-channel.mjs', 'tools/onboarding-sync.mjs', '--knowledge-only', '--knowledge-receiver', '--force']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /7 files, updated=7/);
  const installed = JSON.parse(fs.readFileSync(path.join(installDir(home), 'manifest.json'), 'utf8'));
  assert.deepEqual(installed.files.map(x => x.name), FILES);
  for (const file of installed.files) {
    const bytes = fs.readFileSync(path.join(installDir(home), file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.equal(verify().status, 0);
  fs.unlinkSync(path.join(installDir(home), FILES[0]));
  assert.equal(verify().status, 1, 'fixture must not disable the required check');
});
