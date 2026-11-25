import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadFablePolicy, fableAllowedForSupervisor, fableAllowedForSubagent } = await import('./fable-policy.mjs');

function policyDir(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-policy-'));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'fable-policy.json'), contents, 'utf8');
  return dir;
}

test('ファイルが無ければ planIncluded は false（未確認アカウントで課金させない）', () => {
  const policy = loadFablePolicy({ dir: policyDir(undefined) });
  assert.equal(policy.planIncluded, false);
  assert.equal(fableAllowedForSupervisor(policy), false);
});

test('不正な JSON でも例外を投げず planIncluded は false', () => {
  const policy = loadFablePolicy({ dir: policyDir('{ そのまま壊れた') });
  assert.equal(policy.planIncluded, false);
  assert.equal(fableAllowedForSupervisor(policy), false);
});

test('BOM 付きの JSON を読める', () => {
  // PowerShell が書き出すと BOM が付く。除去しないと JSON.parse が落ちて
  // planIncluded:false に倒れ、定額内なのに警告が出続ける。
  const dir = policyDir('﻿{"planIncluded":true,"scope":"supervisor-only"}');
  const policy = loadFablePolicy({ dir });
  assert.equal(policy.planIncluded, true);
  assert.equal(fableAllowedForSupervisor(policy), true);
});

test('planIncluded:true + scope:supervisor-only は監督のみ許可', () => {
  const policy = loadFablePolicy({ dir: policyDir('{"planIncluded":true,"scope":"supervisor-only"}') });
  assert.equal(fableAllowedForSupervisor(policy), true);
  assert.equal(fableAllowedForSubagent(policy), false);
});

test('scope:all のときだけサブエージェントも許可になる', () => {
  const policy = loadFablePolicy({ dir: policyDir('{"planIncluded":true,"scope":"all"}') });
  assert.equal(fableAllowedForSubagent(policy), true);
});

test('planIncluded が false なら scope:all でもサブエージェントは不許可', () => {
  const policy = loadFablePolicy({ dir: policyDir('{"planIncluded":false,"scope":"all"}') });
  assert.equal(fableAllowedForSupervisor(policy), false);
  assert.equal(fableAllowedForSubagent(policy), false);
});

test('配布された実ファイルが読め、planIncluded が真偽値である', () => {
  // hook はリポの tools/ を直接指すので、同じ tools/ に置いた JSON が読めることが前提。
  const policy = loadFablePolicy();
  assert.equal(typeof policy.planIncluded, 'boolean');
});
