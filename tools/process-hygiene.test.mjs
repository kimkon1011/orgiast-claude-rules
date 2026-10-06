import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, classifyDetailed, classifyOrphanConsoleWindows, classifyVscodeIdle, parseOptions, parseProcessLines, shouldKillVscodeIdle } from './process-hygiene.mjs';

const now = Date.parse('2026-09-11T06:00:00Z');
const VSC_CMD = 'C:\\Users\\kim\\.vscode\\extensions\\anthropic.claude-code-2.1.285-win32-x64\\resources\\native-binary\\claude.exe --output-format stream-json';
const APP_CMD = 'C:\\Program Files\\WindowsApps\\Claude_1.0_x64__abc\\app\\claude.exe';
const vscProc = (pid, startedAt, cmd = VSC_CMD) => ({ Name: 'claude.exe', ProcessId: pid, ParentProcessId: 1, CommandLine: cmd, CreationDate: new Date(startedAt).toISOString(), WorkingSetSize: 200 * 1024 * 1024 });
const idleSession = (pid, startedAt, idleMinutes, extra = {}) => ({ pid, sessionId: `sid-${pid}`, startedAt, entrypoint: 'claude-vscode', status: 'idle', statusUpdatedAt: now - idleMinutes * 60_000, updatedAt: now - idleMinutes * 60_000, ...extra });
const idleRun = (procs, sessions, opts = {}) => classifyVscodeIdle(procs, now, { readSession: (pid) => sessions[pid] ?? null, transcriptMtime: () => null, ...opts });
const t0 = Date.parse('2026-09-11T06:00:00Z') - 20 * 3600_000;

test('vscode-idle: 12時間超の idle は止める', () => {
  const r = idleRun([vscProc(1, t0)], { 1: idleSession(1, t0, 721) });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'vscode-claude-idle');
  assert.equal(Math.round(r[0].idleMin), 721);
});

test('vscode-idle: busy と 11時間は止めない', () => {
  assert.equal(idleRun([vscProc(1, t0)], { 1: idleSession(1, t0, 500, { status: 'busy' }) }).length, 0);
  assert.equal(idleRun([vscProc(1, t0)], { 1: idleSession(1, t0, 660) }).length, 0);
});

test('vscode-idle: sessions 読めない・壊れ・entrypoint違いは止めない', () => {
  assert.equal(idleRun([vscProc(1, t0)], {}).length, 0);
  assert.equal(idleRun([vscProc(1, t0)], {}, { readSession: () => { throw new Error('bad json'); } }).length, 0);
  assert.equal(idleRun([vscProc(1, t0)], { 1: idleSession(1, t0, 500, { entrypoint: 'cli' }) }).length, 0);
});

test('vscode-idle: デスクトップアプリは止めない', () => {
  assert.equal(idleRun([vscProc(1, t0, APP_CMD)], { 1: idleSession(1, t0, 800) }).length, 0);
});

test('vscode-idle: 起動時刻ずれ(PID再利用)は止めない', () => {
  assert.equal(idleRun([vscProc(1, t0 + 5 * 60_000)], { 1: idleSession(1, t0, 800) }).length, 0);
  assert.equal(idleRun([vscProc(1, t0 + 60_000)], { 1: idleSession(1, t0, 800) }).length, 1);
});

test('vscode-idle: transcript が新しければ止めない / バッチロック中は止めない', () => {
  const s = { 1: idleSession(1, t0, 800) };
  assert.equal(idleRun([vscProc(1, t0)], s, { transcriptMtime: () => now - 60 * 60_000 }).length, 0);
  assert.equal(idleRun([vscProc(1, t0)], s, { batchLockActive: true }).length, 0);
});

test('vscode-idle: 1回の上限は15個', () => {
  const procs = Array.from({ length: 20 }, (_, i) => vscProc(i + 1, t0));
  const sessions = Object.fromEntries(procs.map((p) => [p.ProcessId, idleSession(p.ProcessId, t0, 730 + p.ProcessId)]));
  const r = idleRun(procs, sessions);
  assert.equal(r.length, 15);
  assert.equal(r[0].pid, 20);
});

test('vscode-idle gate: コミット空きが閾値以上なら止めない', () => {
  assert.equal(shouldKillVscodeIdle(63.5, 16).kill, false);
  assert.equal(shouldKillVscodeIdle(16, 16).kill, false);
});

test('vscode-idle gate: コミット空きが閾値未満なら止める', () => {
  assert.equal(shouldKillVscodeIdle(8, 16).kill, true);
  assert.equal(shouldKillVscodeIdle(15.9, 16).kill, true);
});

test('vscode-idle gate: 空き不明なら止めない / 閾値0ならゲート無効', () => {
  assert.equal(shouldKillVscodeIdle(Number.NaN, 16).kill, false);
  assert.equal(shouldKillVscodeIdle(undefined, 16).kill, false);
  assert.equal(shouldKillVscodeIdle(Number.NaN, 0).kill, true);
  assert.equal(shouldKillVscodeIdle(100, 0).kill, true);
});

const processInfo = (name, commandLine, ageMin, mb = 100, parentPid = 999_999) => ({ Name: name, ProcessId: ageMin, ParentProcessId: parentPid, CommandLine: commandLine, CreationDate: new Date(now - ageMin * 60_000).toISOString(), WorkingSetSize: mb * 1024 * 1024 });

test('repo tools と hooks の期限超過だけを対象にする', () => {
  const result = classify([
    processInfo('node.exe', 'node C:\\Users\\kim\\orgiast-main\\tools\\hook-selfcheck.mjs', 121),
    processInfo('pwsh.exe', 'pwsh -File C:\\Users\\kim\\.claude\\hooks\\legacy.ps1', 180),
    processInfo('node.exe', 'node C:\\Users\\kim\\orgiast-claude-rules\\tools\\watcher.mjs', 119),
    processInfo('python.exe', 'node C:\\Users\\kim\\orgiast-main\\tools\\old.mjs', 500),
  ], now, {});
  assert.deepEqual(result.map((item) => item.kind), ['tool', 'hook']);
});

test('batch/eval は4時間まで許容し場所に依存しない', () => {
  const result = classify([
    processInfo('node.exe', 'node D:\\tmp\\batch-run.mjs', 239),
    processInfo('node.exe', 'node D:\\tmp\\eval-harness.mjs', 241, 512),
    processInfo('node.exe', 'node D:\\tmp\\hook-tree-selfheal.mjs', 121),
  ], now, {});
  assert.deepEqual(result.map((item) => [item.kind, item.mb]), [['batch', 512], ['tool', 100]]);
});

test('next/MCP/claude/codex-do と tools 外は対象外', () => {
  const commands = ['next start', 'node mcp-server.mjs', 'claude', 'node codex-do.mjs', 'node C:\\tmp\\random.mjs'];
  assert.equal(classify(commands.map((command) => processInfo('node.exe', command, 999)), now, {}).length, 0);
});

test('親プロセスが一覧に存在する期限超過プロセスは除外する', () => {
  const child = processInfo('node.exe', 'node C:\\Users\\kim\\orgiast-main\\tools\\hook-selfcheck.mjs', 121, 100, 42);
  const parent = { ...processInfo('node.exe', 'claude', 300), ProcessId: 42 };
  const result = classifyDetailed([child, parent], now);
  assert.equal(result.stale.length, 0);
  assert.equal(result.parentAliveExcluded, 1);
});

test('長時間ジョブは12時間以内なら除外し12時間超なら候補へ戻す', () => {
  const result = classifyDetailed([
    processInfo('node.exe', 'node C:\\Users\\kim\\orgiast-main\\tools\\auto-session-launcher.mjs', 719),
    processInfo('pwsh.exe', 'pwsh -File C:\\Users\\kim\\orgiast-main\\tools\\fleet-poller.ps1', 719),
    processInfo('node.exe', 'node C:\\Users\\kim\\orgiast-main\\tools\\fleet-agent.mjs --config config.mjs', 721),
  ], now);
  assert.equal(result.longRunningExcluded, 2);
  assert.deepEqual(result.stale.map((item) => item.ageMin), [721]);
});

test('batch-run は8時間以内の一致するロックを保持中なら除外する', () => {
  const batch = { ...processInfo('node.exe', 'node D:\\tmp\\batch-run.mjs', 300), ProcessId: 4321 };
  const result = classifyDetailed([batch], now, { batchLock: { pid: 4321, startedAt: new Date(now - 7 * 60 * 60_000).toISOString() } });
  assert.equal(result.lockHeldExcluded, 1);
  assert.equal(result.stale.length, 0);
  assert.equal(classify([batch], now, { batchLock: { pid: 9999, startedAt: new Date(now).toISOString() } }).length, 1);
});

test('孤児 hook は120分を超えると残留判定する', () => {
  const result = classify([processInfo('node.exe', 'node C:\\Users\\kim\\.claude\\hooks\\orphan.mjs', 121)], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'hook');
});

test('閾値は超えた時だけ対象になり上書きできる', () => {
  const rows = [processInfo('node.exe', 'node C:\\x\\orgiast-main\\tools\\x.mjs', 10), processInfo('node.exe', 'node batch-run.mjs', 20)];
  assert.equal(classify(rows, now, { maxAgeMin: 10, maxBatchAgeMin: 20 }).length, 0);
  assert.equal(classify(rows, now + 1, { maxAgeMin: 10, maxBatchAgeMin: 20 }).length, 2);
  assert.deepEqual(parseOptions(['--kill', '--max-age-min', '3', '--max-batch-age-min', '4', '--alert-threshold', '5']), { kill: true, dryRun: false, maxAgeMin: 3, maxBatchAgeMin: 4, alertThreshold: 5, vscodeIdleMin: 720, vscodeIdleMinFreeGb: 16 });
  assert.equal(parseOptions(['--vscode-idle-min', '60']).vscodeIdleMin, 60);
  assert.equal(parseOptions([]).vscodeIdleMinFreeGb, 16);
  assert.equal(parseOptions(['--vscode-idle-min-free-gb', '4']).vscodeIdleMinFreeGb, 4);
});

test('--dry-run は --kill より優先する', () => {
  assert.equal(parseOptions(['--kill', '--dry-run']).kill, false);
  assert.equal(parseOptions(['--kill', '--dry-run']).dryRun, true);
});

test('クライアントのいない Windows Terminal だけを孤児窓にする', () => {
  const row = (ProcessId, ParentProcessId, Name) => ({ ProcessId, ParentProcessId, Name, WorkingSetSize: 1024 });
  const result = classifyOrphanConsoleWindows([
    row(10, 1, 'WindowsTerminal.exe'), row(11, 10, 'OpenConsole.exe'),
    row(20, 1, 'WindowsTerminal.exe'), row(21, 20, 'conhost.exe'), row(22, 21, 'node.exe'),
    row(30, 1, 'WindowsTerminal.exe'),
  ]);
  assert.deepEqual(result.map((item) => item.pid), [10]);
});

test('US区切りを行単位でパースし壊れた行だけを捨てる', () => {
  const us = '\x1f';
  const fixture = [
    ['123', '10', '2026-09-11T05:00:00.0000000Z', '1048576', 'node.exe', 'node C:\\Users\\kim\\orgiast-main\\tools\\x.mjs'].join(us),
    '区切りのない壊れた行',
    ['456', '10', '2026-09-11T05:30:00.0000000Z', '2048', 'pwsh.exe', `pwsh command${us}with-us`].join(us),
  ].join('\r\n');
  const result = parseProcessLines(`\uFEFF${fixture}\r\n`);
  assert.equal(result.totalLines, 3);
  assert.equal(result.failedLines, 1);
  assert.equal(result.processes.length, 2);
  assert.deepEqual(result.processes[0], {
    ProcessId: 123,
    ParentProcessId: 10,
    CreationDate: '2026-09-11T05:00:00.0000000Z',
    WorkingSetSize: 1048576,
    Name: 'node.exe',
    CommandLine: 'node C:\\Users\\kim\\orgiast-main\\tools\\x.mjs',
  });
  assert.equal(result.processes[1].CommandLine, `pwsh command${us}with-us`);
});
