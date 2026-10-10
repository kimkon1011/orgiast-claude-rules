import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 回帰テスト: 夜間ジョブが --specs を渡さないと、どのPCもハードウェアスペックを
// 一度も送らない。実際に PC管理表 が「手で叩いた1台」だけの状態で止まっていた
// (2026-08-28 実測)。引数が落ちても誰も気付けないのでテストで固定する。
const dir = path.resolve(import.meta.dirname);
const pollerSource = fs.readFileSync(path.join(dir, 'fleet-poller.mjs'), 'utf8');
const pollerPs1Source = fs.readFileSync(path.join(dir, 'fleet-poller.ps1'), 'utf8');
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

test('fleet-poller.ps1 は fleet-agent のScheduledTaskを自己登録する', () => {
  assert.match(pollerPs1Source, /OrgiastFleetAgent/);
  assert.match(pollerPs1Source, /register-fleet-agent\.ps1/);
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

// --- 2026-10-10 事故: 受信タスク(OrgiastFleetMail)の自己修復とウォッチドッグ登録 ---
test('fleet-poller.ps1 は日次で register-fleet-mail.mjs --ensure を呼ぶ（未登録/Disabled/24h未実行なら再登録）', () => {
  const line = pollerPs1Source.split(/\r?\n/).find(l => l.includes('register-fleet-mail.mjs') && l.includes('--ensure') && !l.trim().startsWith('#'));
  assert.ok(line, 'register-fleet-mail.mjs --ensure の呼び出しが見つからない');
});
test('register-fleet-mail.mjs --ensure は Disabled と 24時間未実行を健康判定に含む', () => {
  const source = fs.readFileSync(path.join(dir, 'register-fleet-mail.mjs'), 'utf8');
  assert.match(source, /'Disabled'\) \{ 'disabled'/);
  assert.match(source, /FromHours\(/);
  assert.match(source, /STALE_TASK_HOURS = 24/);
});
test('register-fleet-mail.ps1 は FLEET_MAIL_WATCHDOG=1 のときだけ OrgiastFleetMailWatchdog を登録し、Unregister でも削除する', () => {
  const source = fs.readFileSync(path.join(dir, 'register-fleet-mail.ps1'), 'utf8');
  assert.match(source, /FLEET_MAIL_WATCHDOG=1/);
  assert.match(source, /'OrgiastFleetMailWatchdog'/);
  const registerLine = source.split(/\r?\n/).find(l => l.includes("Register-ScheduledTask -TaskName $watchdogTask"));
  assert.ok(registerLine, 'ウォッチドッグタスクの Register-ScheduledTask が見つからない');
  const unregisterBlock = source.slice(source.indexOf('$Unregister'), source.indexOf('exit 0'));
  assert.match(unregisterBlock, /OrgiastFleetMailWatchdog/);
});
