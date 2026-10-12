import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoRunFixNow } from './fleet-mail.mjs';
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
test('fleet-fix-now の更新を検知したときだけ -NoLogin で起動し、初回は記録だけ', t => {
  const home = tmp(t); const repo = tmp(t); fs.mkdirSync(path.join(repo, 'tools'));
  fs.writeFileSync(path.join(repo, 'tools', 'fleet-fix-now.ps1'), 'v1');
  const calls = []; const launch = (f, a) => calls.push(a);
  const prev = process.env.FLEET_NO_SELF_HEAL; delete process.env.FLEET_NO_SELF_HEAL; t.after(() => { if (prev !== undefined) process.env.FLEET_NO_SELF_HEAL = prev; });
  assert.equal(autoRunFixNow({ dir: home, repo, platform: 'win32', launch }).skipped, 'first-seen');
  assert.equal(autoRunFixNow({ dir: home, repo, platform: 'win32', launch }).skipped, 'same');
  fs.writeFileSync(path.join(repo, 'tools', 'fleet-fix-now.ps1'), 'v2');
  assert.ok(autoRunFixNow({ dir: home, repo, platform: 'win32', launch }).launched);
  assert.equal(calls.length, 1); assert.ok(calls[0].includes('-NoLogin'));
  assert.equal(autoRunFixNow({ dir: home, repo, platform: 'linux', launch }).skipped, 'disabled');
});
