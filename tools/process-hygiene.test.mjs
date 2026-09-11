import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, classifyDetailed, parseOptions, parseProcessLines } from './process-hygiene.mjs';

const now = Date.parse('2026-09-11T06:00:00Z');
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
  assert.deepEqual(parseOptions(['--kill', '--max-age-min', '3', '--max-batch-age-min', '4', '--alert-threshold', '5']), { kill: true, maxAgeMin: 3, maxBatchAgeMin: 4, alertThreshold: 5 });
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
