import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname);
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const agentSource = read('register-fleet-agent.ps1');
const pollerSource = read('register-fleet-poller.ps1');
const gtasksSource = read('register-gtasks-plan-task.ps1');
const installerSource = read('install-orgiast.ps1');

test('register-fleet-agent.ps1 は nightly-bootstrap 経由で fleet-agent.mjs を登録する', () => {
  assert.match(agentSource, /nightly-bootstrap\.ps1/);
  assert.match(agentSource, /'-Target', \$target/);
  assert.match(agentSource, /'tools\\fleet-agent\.mjs'/);
  assert.match(agentSource, /'--once'/);
  assert.doesNotMatch(agentSource, /-Execute \$node/); // 旧: 作業ツリーの node 直実行
});

test('register-fleet-poller.ps1 は nightly-bootstrap 経由で fleet-poller.ps1 を登録する', () => {
  assert.match(pollerSource, /nightly-bootstrap\.ps1/);
  assert.match(pollerSource, /'tools\\fleet-poller\.ps1'/);
  assert.match(pollerSource, /\$taskName = 'OrgiastFleetPoller'/);
  assert.match(pollerSource, /-TaskName \$taskName/);
  assert.match(pollerSource, /-Daily -At '03:15'/);
});

test('register-gtasks-plan-task.ps1 は nightly-bootstrap 経由で gtasks-loop.mjs を登録する', () => {
  assert.match(gtasksSource, /nightly-bootstrap\.ps1/);
  assert.match(gtasksSource, /'tools\\gtasks-loop\.mjs'/);
  assert.match(gtasksSource, /'--plan'/);
  assert.match(gtasksSource, /\$taskName = 'OrgiastGoogleTasksPlan'/);
  assert.match(gtasksSource, /-TaskName \$taskName/);
  assert.match(gtasksSource, /-Daily -At '00:20'/);
});

test('install-orgiast.ps1 は FleetPoller を register-fleet-poller.ps1 経由で登録し、直実行しない', () => {
  assert.match(installerSource, /& powershell\.exe[^\r\n]*-File \$fpr/);
  assert.match(installerSource, /register-fleet-poller\.ps1/);
  assert.doesNotMatch(installerSource, /Register-ScheduledTask -TaskName 'OrgiastFleetPoller'/);
  assert.doesNotMatch(installerSource, /-File, \$fp\)/);
});

test('register スクリプトにマシン固有パス(C:\\Users\\)が無い', () => {
  for (const [name, src] of [['register-fleet-agent.ps1', agentSource], ['register-fleet-poller.ps1', pollerSource], ['register-gtasks-plan-task.ps1', gtasksSource]]) {
    assert.doesNotMatch(src, /C:\\Users\\/i, `${name} にマシン固有パスがある`);
  }
});
