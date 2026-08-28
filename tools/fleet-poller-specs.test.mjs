import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 回帰テスト: 夜間ジョブが --specs を渡さないと、どのPCもハードウェアスペックを
// 一度も送らない。実際に PC管理表 が「手で叩いた1台」だけの状態で止まっていた
// (2026-08-28 実測)。引数が落ちても誰も気付けないのでテストで固定する。
const dir = path.resolve(import.meta.dirname);

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
