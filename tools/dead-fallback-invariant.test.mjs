import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRecords,
  findGuardedScripts,
  helperExists,
  runCheck,
} from './dead-fallback-invariant.mjs';

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-fallback-invariant-'));
  fs.mkdirSync(path.join(repo, 'tools'));
  return repo;
}

test('findGuardedScripts detects only guarded register scripts', (t) => {
  const repo = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tools', 'register-a.ps1'), 'Test-Path ensure-run-hidden.ps1');
  fs.writeFileSync(path.join(repo, 'tools', 'register-b.ps1'), 'Test-Path only');
  fs.writeFileSync(path.join(repo, 'tools', 'other-file.ps1'), 'Test-Path ensure-run-hidden.ps1');

  assert.deepEqual(findGuardedScripts(repo), ['tools/register-a.ps1']);
});

test('helperExists reflects whether ensure-run-hidden.ps1 exists', (t) => {
  const repo = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(helperExists(repo), false);
  fs.writeFileSync(path.join(repo, 'tools', 'ensure-run-hidden.ps1'), '');
  assert.equal(helperExists(repo), true);
});

test('buildRecords maps helper presence to the expected action and reason', () => {
  const guardedScripts = ['tools/register-a.ps1'];
  const present = buildRecords({ repoDir: 'unused', guardedScripts, helperPresent: true });
  assert.deepEqual(present, [{
    tool: 'dead-fallback-invariant',
    file: 'tools/register-a.ps1',
    action: 'uptodate',
    reason: 'ensure-run-hidden.ps1 present; fallback branch is dead code but harmless',
  }]);

  const missing = buildRecords({ repoDir: 'unused', guardedScripts, helperPresent: false });
  assert.deepEqual(missing, [{
    tool: 'dead-fallback-invariant',
    file: 'tools/register-a.ps1',
    action: 'flagged',
    reason: 'ensure-run-hidden.ps1 missing; fallback branch is reachable and will show a console window (#185 regression)',
  }]);
});

test('runCheck appends one uptodate record to the configured ledger', (t) => {
  const repo = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tools', 'register-a.ps1'), 'Test-Path ensure-run-hidden.ps1');
  fs.writeFileSync(path.join(repo, 'tools', 'ensure-run-hidden.ps1'), '');
  const ledgerFile = path.join(repo, 'state', 'ledger.jsonl');
  const previous = process.env.ORGIAST_SELFHEAL_LEDGER;
  process.env.ORGIAST_SELFHEAL_LEDGER = ledgerFile;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGIAST_SELFHEAL_LEDGER;
    else process.env.ORGIAST_SELFHEAL_LEDGER = previous;
  });

  const records = runCheck({ repo });
  assert.equal(records.length, 1);
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.action, 'uptodate');
  assert.equal(record.file, 'tools/register-a.ps1');
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
});
