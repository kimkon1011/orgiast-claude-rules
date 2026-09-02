import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 回帰テスト: 夜間ジョブが --specs を渡さないと、どのPCもハードウェアスペックを
// 一度も送らない。実際に PC管理表 が「手で叩いた1台」だけの状態で止まっていた
// (2026-08-28 実測)。引数が落ちても誰も気付けないのでテストで固定する。
const dir = path.resolve(import.meta.dirname);
const pollerSource = fs.readFileSync(path.join(dir, 'fleet-poller.mjs'), 'utf8');
const installerSource = fs.readFileSync(path.join(dir, 'install-orgiast.ps1'), 'utf8');

const callInMjs = () => {
  const source = fs.readFileSync(path.join(dir, 'fleet-poller.mjs'), 'utf8');
  const call = source.match(/fleet-sheet-report\.mjs'[^\n]*/);
  assert.ok(call, 'fleet-sheet-report.mjs の呼び出しが見つからない');
  return call[0];
};

const callInPs1 = () => {
  const source = fs.readFileSync(path.join(dir, 'fleet-poller.ps1'), 'utf8');
  const call = source.split(/\r?\n/).find((line) => line.includes('fleet-sheet-report.mjs') && !line.trim().startsWith('#'));
  assert.ok(call, 'fleet-sheet-report.mjs の呼び出しが見つからない');
  return call;
};

test('fleet-poller.mjs は fleet-sheet-report に --specs を渡す', () => {
  assert.match(callInMjs(), /--specs/);
});

test('fleet-poller.ps1 は fleet-sheet-report に --specs を渡す', () => {
  assert.match(callInPs1(), /--specs/);
});

// --cloud も同じ理由で固定する。落ちるとクラウド台帳の「PCログイン」タブが
// 永久に空のままになり、しかも誰も気付かない(送信側は未設定時に exit 0 で黙る)。
test('fleet-poller.mjs は fleet-sheet-report に --cloud を渡す', () => {
  assert.match(callInMjs(), /--cloud/);
});

test('fleet-poller.ps1 は fleet-sheet-report に --cloud を渡す', () => {
  assert.match(callInPs1(), /--cloud/);
});

test('fleet-poller.mjs は register-fleet-agent を許可する', () => {
  const allowed = pollerSource.match(/const allowed = new Set\(\[([^\]]+)\]\)/);
  assert.ok(allowed, '許可タスク一覧が見つからない');
  assert.match(allowed[1], /['"]register-fleet-agent['"]/);
});

test('fleet-poller.mjs は register-fleet-agent.ps1 を実行する', () => {
  const branch = pollerSource.match(/if \(task === 'register-fleet-agent'\)[\s\S]*?\n  }/);
  assert.ok(branch, 'register-fleet-agent の分岐が見つからない');
  assert.match(branch[0], /register-fleet-agent\.ps1/);
});

test('fleet-poller.mjs の既存5タスクが許可リストに残っている', () => {
  const allowed = pollerSource.match(/const allowed = new Set\(\[([^\]]+)\]\)/);
  assert.ok(allowed, '許可タスク一覧が見つからない');
  for (const task of ['verify-setup', 'rules-resync', 'cost-report', 'thermal-guard', 'power-save']) {
    assert.match(allowed[1], new RegExp(`['"]${task}['"]`), `${task} が許可リストにない`);
  }
});

test('install-orgiast.ps1 は register-fleet-agent.ps1 を呼ぶ', () => {
  assert.match(installerSource, /& powershell\.exe[^\r\n]*-File \$fa/);
  assert.match(installerSource, /register-fleet-agent\.ps1/);
});
