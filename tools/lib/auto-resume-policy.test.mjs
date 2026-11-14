import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoResumeAllowed } from './auto-resume-policy.mjs';

function repoWith(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-policy-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'auto-resume.json'), content);
  return root;
}

test('既定は false', () => {
  const root = repoWith('{"enabled":false,"allowSources":["fleet-exec"]}');
  assert.equal(autoResumeAllowed({ repoRoot: root }), false);
});

test('壊れた JSON は false', () => {
  assert.equal(autoResumeAllowed({ repoRoot: repoWith('{broken') }), false);
});

test('allowSources の fleet-exec は true', () => {
  const root = repoWith('{"enabled":false,"allowSources":["fleet-exec"]}');
  assert.equal(autoResumeAllowed({ repoRoot: root, source: 'fleet-exec' }), true);
});

test('ORGIAST_AUTO_RESUME=1 は true', () => {
  const before = process.env.ORGIAST_AUTO_RESUME;
  process.env.ORGIAST_AUTO_RESUME = '1';
  try { assert.equal(autoResumeAllowed({ repoRoot: repoWith('{broken') }), true); }
  finally { before === undefined ? delete process.env.ORGIAST_AUTO_RESUME : process.env.ORGIAST_AUTO_RESUME = before; }
});
