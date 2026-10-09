import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverGates, readContract, toolsDir, contractErrors } from './gate-contracts.mjs';

for (const name of discoverGates()) test(`${name}: reachable remedy contract`, () => {
  const contract = readContract(path.join(toolsDir, `${name}.mjs`));
  assert.equal(contract?.name, name, 'deny hook has no contract');
  assert.deepEqual(contractErrors(contract), []);
});
test('reject missing declaration, nonexistent repo file, undeployed key and unexplained consent', () => {
  assert.ok(contractErrors(null).length);
  for (const remedy of [{kind:'repo-file',ref:'nonexistent'}, {kind:'keyserve-key',ref:'unpublished.env#SECRET'}, {kind:'user-consent',ref:'bypass'}]) {
    assert.ok(contractErrors({name:'test',remedies:[remedy]}).length);
  }
});
test('new rollout entries must declare the seven day window; legacy inventory is frozen', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(toolsDir, 'gate-rollout-manifest.json')));
  const baseline = JSON.parse(fs.readFileSync(path.join(toolsDir, 'fixtures/legacy-deny-gates.json')));
  assert.deepEqual(Object.entries(manifest.gates).filter(([,v])=>v.legacy).map(([k])=>k).sort(), baseline);
  for (const name of discoverGates()) {
    const row = manifest.gates[name];
    assert.ok(row, `${name}: missing rollout entry`);
    assert.ok(['warn','deny'].includes(row.rollout));
    if (!row.legacy) {
      assert.ok(Number.isFinite(Date.parse(row.distributedAt)));
      if (row.rollout === 'deny') assert.ok(Date.parse(row.denyAfter) >= Date.parse(row.distributedAt) + 7*86400000);
    }
  }
});
