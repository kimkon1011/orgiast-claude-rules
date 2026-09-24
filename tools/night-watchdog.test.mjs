import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskHealth, buildWatchdogMessage, main, WATCHED_TASKS } from './night-watchdog.mjs';

const NOW = new Date('2026-09-18T00:00:00.000Z');

// 実機のスケジュールタスクには一切触らない。queryTask / enableTask / notifyFn を必ず差し替える。
function healthy(taskName = 'X', overrides = {}) {
  return {
    taskName,
    state: 'Ready',
    lastRunTime: '2026-09-17T15:00:00.000Z',
    nextRunTime: '2026-09-18T15:00:00.000Z',
    lastTaskResult: 0,
    neverRun: false,
    ...overrides
  };
}

function collectLogs() {
  const lines = [];
  return { lines, appendLog: (line) => lines.push(line) };
}

function ioFor({ infos = {}, ...rest } = {}) {
  const calls = { queried: [], enabled: [], notified: [] };
  const logs = collectLogs();
  return {
    calls,
    io: {
      now: NOW,
      home: 'C:/fake-home',
      logFile: 'C:/fake-home/.claude/logs/night-watchdog.log',
      appendLog: logs.appendLog,
      webhook: '',
      setExitCode: () => {},
      queryTask: async (name) => (name in infos ? infos[name] : healthy(name)),
      enableTask: async (name) => { calls.enabled.push(name); },
      notifyFn: async (_webhook, text) => { calls.notified.push(text); },
      ...rest
    },
    logs
  };
}

test('classify: タスク未登録は missing で自動修復しない', () => {
  const [item] = classifyTaskHealth('OrgiastNightlyBatch', null, { now: NOW });
  assert.equal(item.kind, 'missing');
  assert.equal(item.autoFixable, false);
});

test('classify: Disabled は既知原因として自動修復対象になる', () => {
  const [item] = classifyTaskHealth('OrgiastAutoSession', healthy('OrgiastAutoSession', { state: 'Disabled' }), { now: NOW });
  assert.equal(item.kind, 'disabled');
  assert.equal(item.autoFixable, true);
});

// 順序の回帰テスト。Disabled を neverRun で先に除外すると、無効化されたタスクが
// 完全に黙って見逃される（この道具の主目的がそこなので明示的に固定する）。
test('classify: Disabled かつ未実行でも見逃さない（neverRun より Disabled を優先）', () => {
  const info = healthy('OrgiastFleetPoller', { state: 'Disabled', neverRun: true, lastRunTime: '1999-12-31T23:00:00.000Z' });
  const items = classifyTaskHealth('OrgiastFleetPoller', info, { now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'disabled');
});

test('classify: 未実行(Ready)は新規PCの初回として何も出さない', () => {
  const info = healthy('X', { neverRun: true, lastRunTime: '1999-12-31T23:00:00.000Z' });
  assert.deepEqual(classifyTaskHealth('X', info, { now: NOW }), []);
});

test('classify: 実行中(267009)と未実行(267011)は失敗扱いにしない', () => {
  for (const result of [267009, 267011]) {
    assert.deepEqual(classifyTaskHealth('X', healthy('X', { lastTaskResult: result }), { now: NOW }), [], `lastTaskResult=${result}`);
  }
});

test('classify: 0 以外の実行結果は last-run-failed', () => {
  const [item] = classifyTaskHealth('OrgiastNightlyBatch', healthy('OrgiastNightlyBatch', { lastTaskResult: 1 }), { now: NOW });
  assert.equal(item.kind, 'last-run-failed');
  assert.equal(item.autoFixable, false);
});

test('classify: 上限を超えて Running のままは running-too-long', () => {
  const info = healthy('X', { state: 'Running', lastRunTime: '2026-09-17T12:00:00.000Z' });
  const [item] = classifyTaskHealth('X', info, { now: NOW, maxRunHours: 5 });
  assert.equal(item.kind, 'running-too-long');
});

test('main: 全て正常なら通知せず ok', async () => {
  const { io, calls, logs } = ioFor();
  const result = await main([], io);
  assert.equal(result.ok, true);
  assert.equal(result.found.length, 0);
  assert.equal(calls.notified.length, 0);
  assert.ok(logs.lines.some((line) => line.includes('found=0')), '正常でもログは必ず書く');
});

test('main: Disabled を有効化し、再取得で確認できたものだけ fixed に数える', async () => {
  const states = { OrgiastFleetPoller: 'Disabled' };
  const { io, calls } = ioFor({
    infos: {},
    queryTask: async (name) => {
      if (name === 'OrgiastFleetPoller') return healthy(name, { state: states.OrgiastFleetPoller });
      return healthy(name);
    },
    enableTask: async (name) => { calls.enabled.push(name); states[name] = 'Ready'; }
  });
  const result = await main([], io);
  assert.deepEqual(calls.enabled, ['OrgiastFleetPoller']);
  assert.equal(result.fixed.length, 1);
  assert.equal(result.problems.length, 0);
  assert.equal(result.ok, true);
  assert.equal(calls.notified.length, 1, '自動修復した日も報告する');
  assert.match(calls.notified[0], /自動修復: 1件/);
});

// 「有効化コマンドが通った」で満足しないことの回帰テスト。
test('main: 再有効化しても Disabled のままなら直ったことにしない', async () => {
  let exitCode = null;
  const { io, calls } = ioFor({
    queryTask: async (name) => healthy(name, { state: name === 'OrgiastAutoSession' ? 'Disabled' : 'Ready' }),
    enableTask: async (name) => { calls.enabled.push(name); }
  });
  io.setExitCode = (code) => { exitCode = code; };
  const result = await main([], io);
  assert.equal(result.fixed.length, 0);
  assert.equal(result.problems.length, 1);
  assert.equal(result.ok, false);
  assert.equal(exitCode, 1);
  assert.match(calls.notified[0], /Disabled のまま/);
});

test('main: 再有効化が例外を投げても落ちず、要確認として報告する', async () => {
  const { io, calls } = ioFor({
    queryTask: async (name) => healthy(name, { state: name === 'OrgiastNightlyBatch' ? 'Disabled' : 'Ready' }),
    enableTask: async () => { throw new Error('アクセスが拒否されました'); }
  });
  const result = await main([], io);
  assert.equal(result.fixed.length, 0);
  assert.equal(result.problems.length, 1);
  assert.match(calls.notified[0], /再有効化に失敗/);
});

test('main: --dry-run は修復も送信もしない', async () => {
  const { io, calls } = ioFor({
    queryTask: async (name) => healthy(name, { state: name === 'OrgiastFleetPoller' ? 'Disabled' : 'Ready' })
  });
  const result = await main(['--dry-run'], io);
  assert.deepEqual(calls.enabled, [], 'dry-run で enableTask を呼ばない');
  assert.equal(calls.notified.length, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.problems.length, 1, '要確認としては残る');
});

test('main: 状態取得の失敗を「異常なし」に倒さない', async () => {
  const { io, calls } = ioFor({
    queryTask: async () => { throw new Error('powershell が見つかりません'); }
  });
  const result = await main([], io);
  assert.equal(result.found.length, WATCHED_TASKS.length);
  assert.equal(result.found[0].kind, 'query-failed');
  assert.equal(result.ok, false);
  assert.equal(calls.notified.length, 1);
});

test('main: 監視対象外の異常では鳴らない（対象は3件で固定）', async () => {
  const { io } = ioFor({ queryTask: async (name) => healthy(name, { lastTaskResult: name === 'OrgiastAutoSession' ? 1 : 0 }) });
  const result = await main(['--json'], io);
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].taskName, 'OrgiastAutoSession');
});

test('main: webhook 未設定でも例外を投げない', async () => {
  const { io } = ioFor({
    queryTask: async (name) => healthy(name, { state: name === 'OrgiastAutoSession' ? 'Disabled' : 'Ready' }),
    webhook: '',
    notifyFn: undefined
  });
  delete io.notifyFn;
  const result = await main([], io);
  assert.equal(result.ok, false);
  assert.equal(result.notified, false);
});

test('buildWatchdogMessage: 監視対象と件数を含む', () => {
  const text = buildWatchdogMessage({
    found: [{ taskName: 'OrgiastAutoSession', kind: 'disabled', message: 'm' }],
    fixed: [{ taskName: 'OrgiastAutoSession', kind: 'disabled' }],
    problems: [],
    now: NOW
  });
  for (const name of WATCHED_TASKS) assert.ok(text.includes(name), name);
  assert.match(text, /自動修復: 1件/);
  assert.match(text, /要確認: 0件/);
});
