import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { updateRepositoryFiles } from './onboarding-sync.mjs';
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('onboarding distribution → setup --converge → registered runner → symptom block (read-back)', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'symptom-distribution-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'orgiast-claude-rules');
  const result = await updateRepositoryFiles(repo, {
    getZipRoot: async () => ({ root: source }), fallbackStatePath: path.join(home, 'sync-state.json'), emit: () => {},
  });
  assert.equal(result.ok, true);
  for (const name of ['reported-symptom-gate.mjs', 'state-claim-evidence.mjs', 'reported-symptom-gate.fixtures.json', 'external-state-claim-gate.mjs', 'stop-gate-runner.mjs', 'rules-registry.json'])
    assert.deepEqual(fs.readFileSync(path.join(repo, 'tools', name)), fs.readFileSync(path.join(source, 'tools', name)));
  const manifest = path.join(home, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, items: [{ id: 'symptom:runner', type: 'file-contains', severity: 'required', description: 'Stop runner registered', spec: { path: '.claude/settings.json', contains: 'stop-gate-runner.mjs' } }] }));
  const setup = spawnSync(process.execPath, [path.join(repo, 'tools/setup.mjs'), '--converge', '--strict', '--home', home, '--manifest', manifest, '--json'], { encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  assert.ok(JSON.parse(setup.stdout).items.every(item => item.status === 'OK'));
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.ok(settings.hooks.Stop.some(entry => entry.hooks.some(hook => hook.command.includes(path.join(repo, 'tools/stop-gate-runner.mjs')))));
  const { evaluateGates } = await import(pathToFileURL(path.join(repo, 'tools/stop-gate-runner.mjs')));
  const transcriptRaw = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Anthropic API が error で失敗しています' } });
  const verdict = await evaluateGates({ input: {}, assistantText: '残高は枯渇していません。', transcriptRaw, sessionId: 'distribution-check' }, { mode: 'off', home });
  assert.ok(verdict.results.some(r => r.name === 'reported-symptom-gate' && r.code === 'REPORTED-SYMPTOM'));
});

test('both onboarding entrypoints delegate settings changes to setup --converge', () => {
  const js = fs.readFileSync(path.join(source, 'tools/onboarding-sync.mjs'), 'utf8');
  const ps = fs.readFileSync(path.join(source, 'tools/onboarding-sync.ps1'), 'utf8');
  assert.match(js, /const registrar = path.join\(repoPath, 'tools', 'setup.mjs'\)/);
  assert.match(js, /\[registrar, '--converge', '--home', home\]/);
  assert.match(ps, /tools\\setup.mjs/);
  assert.match(ps, /node \$registrar --converge --home \$homeRoot/);
});
