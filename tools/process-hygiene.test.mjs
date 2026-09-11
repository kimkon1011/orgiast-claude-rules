import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, parseOptions } from './process-hygiene.mjs';

const now = Date.parse('2026-09-11T06:00:00Z');
const processInfo = (name, commandLine, ageMin, mb = 100) => ({ Name: name, ProcessId: ageMin, CommandLine: commandLine, CreationDate: new Date(now - ageMin * 60_000).toISOString(), WorkingSetSize: mb * 1024 * 1024 });

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

test('閾値は超えた時だけ対象になり上書きできる', () => {
  const rows = [processInfo('node.exe', 'node C:\\x\\orgiast-main\\tools\\x.mjs', 10), processInfo('node.exe', 'node batch-run.mjs', 20)];
  assert.equal(classify(rows, now, { maxAgeMin: 10, maxBatchAgeMin: 20 }).length, 0);
  assert.equal(classify(rows, now + 1, { maxAgeMin: 10, maxBatchAgeMin: 20 }).length, 2);
  assert.deepEqual(parseOptions(['--kill', '--max-age-min', '3', '--max-batch-age-min', '4', '--alert-threshold', '5']), { kill: true, maxAgeMin: 3, maxBatchAgeMin: 4, alertThreshold: 5 });
});
