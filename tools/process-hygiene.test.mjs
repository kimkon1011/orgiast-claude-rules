import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, classifyDetailed, classifyOrphanClaudeWaitLoops, classifyOrphanConsoleWindows, classifyVscodeIdle, parseOptions, parseProcessLines, shouldKillVscodeIdle, vscodeCpuPolicy, sampleVscodeCpu, main } from './process-hygiene.mjs';

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

test('vscode-idle: Remote Control 接続中(bridgeSessionId あり)は止めない', () => {
  assert.equal(idleRun([vscProc(1, t0)], { 1: idleSession(1, t0, 800, { bridgeSessionId: 'session_01abc' }) }).length, 0);
  assert.equal(idleRun([vscProc(1, t0)], { 1: idleSession(1, t0, 800, { bridgeSessionId: '' }) }).length, 1);
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
  assert.deepEqual(parseOptions(['--kill', '--max-age-min', '3', '--max-batch-age-min', '4', '--alert-threshold', '5']), { kill: true, dryRun: false, maxAgeMin: 3, maxBatchAgeMin: 4, alertThreshold: 5, vscodeIdleMin: 720, vscodeIdleMinFreeGb: 16, vscodeIdleCpuLoad: 90, vscodeIdleMinWhenCpu: 180 });
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


test('CPU gate: 両サンプルのみ、欠測は無効、閾値を切替', () => {
  for (const loads of [[90, 90], [97, 98]]) assert.deepEqual(vscodeCpuPolicy(loads), { cpuGate: true, idleMin: 180 });
  for (const loads of [[89, 98], [98, 89], [], [99], [null, 99], [NaN, 99]]) {
    assert.deepEqual(vscodeCpuPolicy(loads), { cpuGate: false, idleMin: 720 });
  }
  const opts = parseOptions(['--vscode-idle-cpu-load', '95', '--vscode-idle-min-when-cpu', '200', '--vscode-idle-min', '800']);
  assert.equal(vscodeCpuPolicy([94, 99], opts).idleMin, 800);
  assert.equal(vscodeCpuPolicy([95, 99], opts).idleMin, 200);
});

test('CPU gate: idle・transcript・cpu5s の全条件を満たす候補のみ', () => {
  const procs = [vscProc(1, t0)];
  const sessions = { 1: idleSession(1, t0, 180) };
  const opts = { ...vscodeCpuPolicy([97, 98]), cpu5sByPid: { 1: 1 } };
  assert.equal(idleRun(procs, sessions, opts).length, 1); // transcript不在でもidleなら対象
  assert.equal(idleRun(procs, sessions).length, 0);
  for (const cpu of [0, 0.999, -1, NaN, undefined]) {
    assert.equal(idleRun(procs, sessions, { ...opts, cpu5sByPid: { 1: cpu } }).length, 0);
  }
  assert.equal(idleRun(procs, sessions, { ...opts, transcriptMtime: () => now - 179 * 60_000 }).length, 0);
  for (const status of ['busy', 'unknown', undefined]) {
    assert.equal(idleRun(procs, { 1: { ...sessions[1], status } }, opts).length, 0);
  }
  assert.equal(idleRun(procs, { 1: idleSession(1, t0, 179) }, opts).length, 0);
  // 15本の上限はCPUフィルタの後に適用する。
  const many = Array.from({ length: 20 }, (_, i) => vscProc(i + 1, t0));
  const ss = Object.fromEntries(many.map((p) => [p.ProcessId, idleSession(p.ProcessId, t0, 800 + p.ProcessId)]));
  assert.deepEqual(idleRun(many, ss, opts).map((p) => p.pid), [1]);
});

test('CPU sampler: 採取失敗は閉じる（WMI は呼ばない）', () => {
  for (const result of [{ status: 1 }, { error: new Error('timeout') }, { status: 0, stdout: 'broken' }]) {
    assert.equal(vscodeCpuPolicy(sampleVscodeCpu([], () => result).loads).cpuGate, false);
  }
});

test('CPU gate: dry-run は停止・通知なし、成功分だけ通知し cooldown を守る', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-cpu-'));
  const previousLockHome = process.env.ORGIAST_LOCK_HOME;
  process.env.ORGIAST_LOCK_HOME = home;
  const notices = [];
  let stops = 0;
  const deps = {
    platform: 'win32', home, now, batchLock: {}, commitFreeGb: 100,
    listProcesses: () => [vscProc(1, t0), vscProc(2, t0)],
    readSession: (pid) => idleSession(pid, t0, 200), transcriptMtime: () => null,
    sampleVscodeCpu: () => ({ loads: [97, 98], cpu5sByPid: { 1: 1, 2: 2 } }),
    stopTrees: () => { stops++; return [2]; },
    stopProcesses: () => [], stopOrphanWindows: () => [],
    notify: async (message) => { notices.push(message); return { delivered: 'test' }; },
  };
  try {
    assert.equal(await main(['--kill', '--dry-run'], deps), 0);
    assert.equal(stops, 0);
    assert.equal(notices.length, 0);
    assert.equal(await main(['--kill'], deps), 0);
    assert.equal(stops, 1);
    assert.deepEqual(notices, ['VS Code の放置セッション 1 本を CPU 飽和のため停止（再開は VS Code の Claude パネルから /resume）']);
    await main(['--kill'], deps);
    assert.equal(notices.length, 1);
  } finally {
    if (previousLockHome === undefined) delete process.env.ORGIAST_LOCK_HOME;
    else process.env.ORGIAST_LOCK_HOME = previousLockHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 2026-10-29 実測: 起動元 Claude が 10/20 に終了した待機ループが9日間可視窓を出し続けた。
const SNAP = 'source /c/Users/kimko/.claude/shell-snapshots/snapshot-bash-1792450928180-nr37so.sh 2>/dev/null || true && ';
const WAIT_CMD = (exe) => `"${exe}" -c "${SNAP}eval 'until [ -f \\"C:/x/result.md\\" ]; do sleep 10; done; echo \\"ARTIFACT_READY\\"' < /dev/null"`;
const SERVER_CMD = (exe) => `"${exe}" -c "${SNAP}eval 'cd \\"C:/x/line_browser\\" && node launch.mjs' < /dev/null"`;
const bash = (pid, parent, cmd, at) => ({ Name: 'bash.exe', ProcessId: pid, ParentProcessId: parent, CommandLine: cmd, CreationDate: new Date(at).toISOString(), WorkingSetSize: 0 });
const LAUNCHER = String.raw`C:\Program Files\Git\bin\bash.exe`;
const INNER = String.raw`C:\Program Files\Git\bin\..\usr\bin\bash.exe`;

test('orphan-claude-wait-loop: 起動元 Claude 終了・2時間超の待機ループは最上位だけ返す', () => {
  const result = classifyOrphanClaudeWaitLoops([
    bash(34872, 32496, WAIT_CMD(LAUNCHER), t0),
    bash(43880, 34872, WAIT_CMD(INNER), t0),
  ], now);
  assert.deepEqual(result.map((item) => [item.pid, item.kind]), [[34872, 'orphan-claude-wait-loop']]);
});

test('orphan-claude-wait-loop: 起動元 Claude 生存・2時間以内・待機でないコマンドは止めない', () => {
  const claude = { ...vscProc(32496, t0 - 60_000) };
  assert.deepEqual(classifyOrphanClaudeWaitLoops([claude, bash(34872, 32496, WAIT_CMD(LAUNCHER), t0)], now), []);
  assert.deepEqual(classifyOrphanClaudeWaitLoops([bash(1, 999, WAIT_CMD(LAUNCHER), now - 60 * 60_000)], now), []);
  assert.deepEqual(classifyOrphanClaudeWaitLoops([bash(1, 999, SERVER_CMD(LAUNCHER), t0)], now), []);
  assert.deepEqual(classifyOrphanClaudeWaitLoops([bash(1, 999, `"${LAUNCHER}" -c "until false; do sleep 1; done"`, t0)], now), []);
});

test('orphan-claude-wait-loop: 親 PID が再利用されていても（親の方が新しい）孤児と判定する', () => {
  const reused = { Name: 'svchost.exe', ProcessId: 32496, ParentProcessId: 4, CommandLine: '', CreationDate: new Date(now - 60_000).toISOString() };
  assert.deepEqual(classifyOrphanClaudeWaitLoops([reused, bash(34872, 32496, WAIT_CMD(LAUNCHER), t0)], now).map((item) => item.pid), [34872]);
});

test('orphan-claude-wait-loop: --kill でツリー停止し dry-run では止めない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-wait-'));
  const previousLockHome = process.env.ORGIAST_LOCK_HOME;
  process.env.ORGIAST_LOCK_HOME = home;
  const stopped = [];
  const deps = {
    platform: 'win32', home, now, batchLock: {}, commitFreeGb: 100,
    listProcesses: () => [bash(34872, 32496, WAIT_CMD(LAUNCHER), t0), bash(43880, 34872, WAIT_CMD(INNER), t0)],
    sampleVscodeCpu: () => ({ loads: [], cpu5sByPid: {} }),
    stopOrphanShells: (items) => { stopped.push(...items.map((item) => item.pid)); return []; },
    stopTrees: () => [], stopProcesses: () => [], stopOrphanWindows: () => [],
    notify: async () => ({ delivered: 'test' }),
  };
  try {
    assert.equal(await main(['--kill', '--dry-run'], deps), 0);
    assert.deepEqual(stopped, []);
    assert.equal(await main(['--kill'], deps), 0);
    assert.deepEqual(stopped, [34872]);
  } finally {
    if (previousLockHome === undefined) delete process.env.ORGIAST_LOCK_HOME;
    else process.env.ORGIAST_LOCK_HOME = previousLockHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
