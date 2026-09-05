import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = {
  apply: resolve('tools/apply-nightly-schedule.ps1'),
  plaud: resolve('tools/register-plaud-task.ps1'),
  installer: resolve('tools/install-orgiast.ps1'),
};

test('all changed schedule PowerShell files have a UTF-8 BOM', () => {
  for (const [name, path] of Object.entries(files)) {
    assert.deepEqual([...readFileSync(path).subarray(0, 3)], [0xef, 0xbb, 0xbf], name);
  }
});

// OrgiastBoothFeedbackIntake は対象外。main では 12:05 起点の 10 分ポーリングに作り替わっており、
// 日次 03:06 へ張り替えると不具合報告の即時取り込みが 1 日 1 回に退行する（2026-09-05 実測）。
test('registration triggers are dispersed and use two-minute random delay', () => {
  const plaud = readFileSync(files.plaud, 'utf8');
  const installer = readFileSync(files.installer, 'utf8');
  assert.match(plaud, /Date\.AddMinutes\(8\)[\s\S]*-RepetitionInterval \(New-TimeSpan -Hours 1\) -RandomDelay \(New-TimeSpan -Minutes 2\)/);
  assert.match(installer, /-Daily -At 3:00am -RandomDelay \(New-TimeSpan -Minutes 2\)/);
});

test('apply script retains actions, supports DryRun, skips missing tasks, and reads back updates', () => {
  const source = readFileSync(files.apply, 'utf8');
  for (const [name, time] of [
    ['OrgiastNightlyBatch', '03:00'],
    ['Orgiast Growi 自動クリーンアップ', '03:12'],
    ['OrgiastPlaudToTldv', '00:08'],
  ]) {
    assert.match(source, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'[^\\n]+At = '" + time));
  }
  assert.match(source, /\[switch\]\$DryRun/);
  assert.match(source, /SKIP\(なし\)/);
  assert.match(source, /Set-ScheduledTask -TaskName \$definition\.Name -Trigger \$newTrigger/);
  assert.match(source, /\$verified = Get-ScheduledTask/);
  assert.doesNotMatch(source, /Set-ScheduledTask[^\n]+-Action/);
});

test('apply script must not touch the 10-minute booth feedback poller', () => {
  const source = readFileSync(files.apply, 'utf8');
  assert.doesNotMatch(source, /Name = 'OrgiastBoothFeedbackIntake'/);
});
