import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoResumeAllowed, autoResumeDisabledByConfig } from './auto-resume-policy.mjs';

const roots = [];
test.beforeEach(t => {
  const before = process.env.ORGIAST_AUTO_RESUME;
  delete process.env.ORGIAST_AUTO_RESUME;
  t.after(() => {
    before === undefined ? delete process.env.ORGIAST_AUTO_RESUME : process.env.ORGIAST_AUTO_RESUME = before;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
});

function repoWith(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-policy-'));
  roots.push(root);
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

test('設定欠損は fleet-exec でも false、enabled は真偽値 true だけ許可', () => {
  const root = repoWith('{}');
  fs.unlinkSync(path.join(root, 'config', 'auto-resume.json'));
  assert.equal(autoResumeAllowed({ repoRoot: root, source: 'fleet-exec' }), false);
  for (const content of ['null', '{}', '{"enabled":"true"}', '{"allowSources":"fleet-exec"}']) {
    assert.equal(autoResumeAllowed({ repoRoot: repoWith(content), source: 'fleet-exec' }), false);
  }
  assert.equal(autoResumeAllowed({ repoRoot: repoWith('{"enabled":true}') }), true);
  for (const value of ['0', 'true', 'yes']) {
    process.env.ORGIAST_AUTO_RESUME = value;
    assert.equal(autoResumeAllowed({ repoRoot: root }), false);
  }
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

// ---- autoResumeDisabledByConfig ----

test('autoResumeDisabledByConfig: enabled:false の設定で true', () => {
  const root = repoWith('{"enabled":false}');
  assert.equal(autoResumeDisabledByConfig({ repoRoot: root }), true);
});

test('autoResumeDisabledByConfig: 設定ファイル欠損で false', () => {
  const root = repoWith('{}');
  fs.unlinkSync(path.join(root, 'config', 'auto-resume.json'));
  assert.equal(autoResumeDisabledByConfig({ repoRoot: root }), false);
});

test('autoResumeDisabledByConfig: enabled:true で false', () => {
  assert.equal(autoResumeDisabledByConfig({ repoRoot: repoWith('{"enabled":true}') }), false);
});

test('autoResumeDisabledByConfig: 壊れた JSON で false', () => {
  assert.equal(autoResumeDisabledByConfig({ repoRoot: repoWith('{broken') }), false);
});

test('autoResumeDisabledByConfig: enabled が未定義の設定で false', () => {
  assert.equal(autoResumeDisabledByConfig({ repoRoot: repoWith('{"allowSources":["fleet-exec"]}') }), false);
});
