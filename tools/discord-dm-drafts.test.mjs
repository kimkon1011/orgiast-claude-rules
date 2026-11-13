import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLock, scan, readRows } from './discord-dm-drafts.mjs';

test('生存中かつ14分以内のlockは奪わない', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'lock'), now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ pid: 42, createdAt: new Date(now - 1000).toISOString() }));
  assert.equal(acquireLock(file, { now, isAlive: () => true }), null);
});

test('死亡PIDまたは14分超のlockを回収しfinally相当で解放', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, age, alive] of [['dead', 1000, false], ['old', 15 * 60000, true]]) {
    const file = path.join(dir, name), now = Date.now();
    fs.writeFileSync(file, JSON.stringify({ pid: 42, createdAt: new Date(now - age).toISOString() }));
    const release = acquireLock(file, { now, isAlive: () => alive });
    assert.equal(typeof release, 'function');
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(owner.pid, process.pid);
    release(); assert.equal(fs.existsSync(file), false);
  }
});


test('フレンド画面では復帰操作なしで全未読の返信案を保存', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'drafts.jsonl'), visited = [];
  const ui = {
    state: async () => ({ idleMs: 300001, original: '', unread: ['A', 'B'] }),
    idle: async () => 300001,
    read: async chat => { visited.push(chat); return [{ id: chat, chat, from: 'member', ts: '2026-11-12T09:00:00+09:00', question: '確認してください' }]; },
    restore: async () => assert.fail('no original conversation to restore'),
    post: async () => assert.fail('scan must never send'),
  };
  assert.equal(await scan({ ui, file, generate: async () => '【確認】返信案です' }), '返信案 2件を保存');
  assert.deepEqual(visited, ['A', 'B']);
  assert.equal(readRows(file).filter(r => r.status === 'pending').length, 2);
});

test('元の会話ありは読み取り失敗でも復帰、なしは復帰せず失敗を伝える', async () => {
  for (const original of ['', 'Original']) {
    const restored = [];
    const ui = {
      state: async () => ({ idleMs: 300001, original, unread: ['A'] }), idle: async () => 300001,
      read: async () => { throw new Error('read failed'); }, restore: async chat => restored.push(chat),
    };
    await assert.rejects(scan({ ui }), /read failed/);
    assert.deepEqual(restored, original ? ['Original'] : []);
  }
});

test('戻し先なしdry-runは会話切替・生成・保存せず、操作中はスキップ', async () => {
  const ui = {
    state: async () => ({ idleMs: 300001, original: '', unread: ['A'] }),
    read: async () => assert.fail('must not switch'), restore: async () => assert.fail('must not restore'),
  };
  assert.match(await scan({ ui, dryRun: true, generate: async () => assert.fail('must not generate') }), /DRY-RUN/);
  ui.state = async () => ({ idleMs: 1 });
  assert.match(await scan({ ui }), /SKIP/);
});

test('Windows: Discord未起動は一度起動して待ち、起動済みは待つだけ、期限切れと起動失敗を伝える', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-startup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL('./lib/discord-dm-window.ps1', import.meta.url)).replaceAll("'", "''");
  const script = path.join(dir, 'test.ps1');
  fs.writeFileSync(script, `
$ErrorActionPreference = 'Stop'
. '${helper}'
function Assert($condition, $message) { if (-not $condition) { throw $message } }
foreach ($running in @($false, $true)) {
 $script:starts = 0; $script:polls = 0; $script:delays = 0
 $window = Wait-DiscordWindow -FindWindow { $script:polls++; if ($script:polls -ge 3) { 'window' } } -IsRunning { $running } -StartDiscord { $script:starts++ } -Delay { $script:delays++ } -Attempts 3
 Assert ($window -eq 'window') 'must wait for window'
 Assert ($script:starts -eq [int](-not $running)) 'must start only when not running'
 Assert ($script:delays -eq 2) 'must wait between polls'
}
$window = Wait-DiscordWindow -FindWindow { 'existing' } -IsRunning { throw 'unnecessary process lookup' } -StartDiscord { throw 'must not launch' }
Assert ($window -eq 'existing') 'existing window'
$script:delays = 0; $failed = $false
try { Wait-DiscordWindow -FindWindow { $null } -IsRunning { $true } -Delay { $script:delays++ } -Attempts 2 } catch { $failed = $_.Exception.Message -match 'after startup wait' }
Assert ($failed -and $script:delays -eq 2) 'bounded startup wait'
$failed = $false
try { Wait-DiscordWindow -FindWindow { $null } -IsRunning { $false } -StartDiscord { throw 'missing installer' } -Delay { throw 'must not wait' } } catch { $failed = $_.Exception.Message -eq 'missing installer' }
Assert $failed 'startup errors propagate'
Write-Output 'PASS'
`);
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.match(output, /PASS/);
});
