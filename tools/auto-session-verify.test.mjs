import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from './auto-session-verify.mjs';

const NOW = new Date(2026, 7, 30, 7, 45);
const HOME = '/fake/home';
const runs = path.join(HOME, '.claude', 'auto-session', 'runs');
const verify = path.join(HOME, '.claude', 'auto-session', 'verify');

function harness({ files = {}, task = { command: 'node auto-session-launcher.mjs --count all', lastRunTime: new Date(2026, 7, 30, 0, 30).toISOString(), lastTaskResult: '0', state: 'Ready' }, alive = false } = {}) {
  const store = new Map(Object.entries(files));
  const calls = { register: 0, notify: 0, unlink: [] };
  const io = {
    home: HOME,
    now: () => NOW,
    exists: (file) => store.has(file),
    list: (dir) => [...store.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
    readFile: (file) => { if (!store.has(file)) throw new Error('ENOENT'); return store.get(file); },
    writeFile: (file, value) => store.set(file, String(value)),
    mkdir: () => {},
    unlink: (file) => { calls.unlink.push(file); store.delete(file); },
    stat: () => ({ mtimeMs: NOW.getTime() - 7 * 60 * 60 * 1000 }),
    pidAlive: () => alive,
    queryTask: async () => task,
    register: async () => { calls.register += 1; return { ok: true, code: 0 }; },
    notify: async () => { calls.notify += 1; },
    log: () => {},
  };
  return { io, store, calls };
}

test('マニフェスト無しで killswitch があれば削除も登録もしない', async () => {
  const disabled = path.join(HOME, '.claude', 'auto-session', 'disabled');
  const h = harness({ files: { [disabled]: '' } });
  const result = await main([], h.io);
  assert.equal(result.cause, 'killswitch');
  assert.equal(h.calls.register, 0);
  assert.equal(h.store.has(disabled), true);
});

test('タスク未登録なら再登録し修復を報告する', async () => {
  const h = harness({ task: null });
  const result = await main([], h.io);
  assert.equal(result.cause, 'task-missing');
  assert.equal(h.calls.register, 1);
  assert.match(result.notice, /🔧 自動修復/);
});

test('--count all が無いタスクは引数ずれとして再登録する', async () => {
  const h = harness({ task: { command: 'node auto-session-launcher.mjs --count 1' } });
  const result = await main([], h.io);
  assert.equal(result.cause, 'task-args-drift');
  assert.equal(h.calls.register, 1);
});

test('LastRunTime が00:30より前なら未発火で登録しない', async () => {
  const h = harness({ task: { command: '--count all', lastRunTime: new Date(2026, 7, 29, 23).toISOString(), lastTaskResult: '267011', state: 'Ready' } });
  const result = await main([], h.io);
  assert.equal(result.cause, 'task-did-not-fire');
  assert.equal(h.calls.register, 0);
  assert.match(result.notice, /LastRunTime=.*LastTaskResult=267011/);
});

function batchFiles({ expected = 12, records = 7, status = 'success', deadline = true } = {}) {
  const files = { [path.join(runs, '2026-08-30-manifest.json')]: JSON.stringify({ selectedCount: expected - 1, feedbackCount: 1, options: { deadline: '07:30' } }) };
  for (let n = 1; n <= records; n += 1) files[path.join(runs, `2026-08-30-${n}.json`)] = JSON.stringify({ todo: `TODO ${n}`, status });
  if (deadline) files[path.join(runs, '2026-08-30-deadline-1.json')] = JSON.stringify({ status: 'deadline', unconsumed: expected - records, deadline: '07:30' });
  return files;
}

test('12件予定で7件実績とdeadlineなら partial と未消化を出す', async () => {
  const result = await main([], harness({ files: batchFiles() }).io);
  assert.equal(result.verdict, 'partial');
  assert.match(result.notice.split('\n')[0], /7\/12.*未消化5件/);
});

test('全件成功なら ok で結論がチェックから始まる', async () => {
  const result = await main([], harness({ files: batchFiles({ expected: 3, records: 3, deadline: false }) }).io);
  assert.equal(result.verdict, 'ok');
  assert.match(result.notice, /^✅/);
});

test('同じ正常結論は通知せず、異常は同じでも通知する', async () => {
  const okFiles = batchFiles({ expected: 2, records: 2, deadline: false });
  const first = await main([], harness({ files: okFiles }).io);
  const hOk = harness({ files: { ...okFiles, [path.join(verify, 'last-notice.txt')]: first.notice } });
  await main([], hOk.io);
  assert.equal(hOk.calls.notify, 0);
  const missingHeadline = '🚨 自動セッション 2026-08-30 1件も起動していません｜主因: スケジュールタスク未登録';
  const hBad = harness({ task: null, files: { [path.join(verify, 'last-notice.txt')]: missingHeadline } });
  await main([], hBad.io);
  assert.equal(hBad.calls.notify, 1);
});

test('失敗内容の token と Discord webhook URL をマスクする', async () => {
  const files = batchFiles({ expected: 1, records: 0, deadline: false });
  files[path.join(runs, '2026-08-30-1.json')] = JSON.stringify({ status: 'failure', todo: '秘密テスト', stderr: 'token=abcdef https://discord.com/api/webhooks/123/secret' });
  const result = await main([], harness({ files }).io);
  assert.doesNotMatch(result.notice, /abcdef|123\/secret/);
  assert.match(result.notice, /REDACTED/);
});

test('死んだpidの6時間超ロックを削除する', async () => {
  const lock = path.join(HOME, '.claude', 'auto-session', '.lock');
  const h = harness({ files: { [lock]: JSON.stringify({ pid: 42 }) }, alive: false });
  const result = await main([], h.io);
  assert.deepEqual(h.calls.unlink, [lock]);
  assert.match(result.notice, /🔧 自動修復/);
});

test('生きているpidのロックは削除しない', async () => {
  const lock = path.join(HOME, '.claude', 'auto-session', '.lock');
  const h = harness({ files: { [lock]: JSON.stringify({ pid: 42 }) }, alive: true });
  const result = await main([], h.io);
  assert.equal(result.cause, 'locked');
  assert.deepEqual(h.calls.unlink, []);
  assert.match(result.notice, /pid=42/);
});

test('マニフェストが無くても当日の実行記録があれば「1件も起動していません」と誤報せず、再登録もしない', async () => {
  // マニフェストの書き込みは夜間実行を止めないよう try/catch で握られている。
  // 失敗しただけで全滅扱いにすると、動いた夜に 🚨 が飛び無用な再登録まで走る。
  const { io, calls, store } = harness({
    files: {
      [path.join(runs, '2026-08-30-1.json')]: JSON.stringify({ status: 'success', todo: 'なにか' }),
      [path.join(runs, '2026-08-30-2.json')]: JSON.stringify({ status: 'failure', todo: 'こわれた' }),
    },
    task: null,
  });
  const result = await main([], io);
  assert.equal(result.cause, 'manifest-missing');
  assert.equal(result.verdict, 'partial');
  assert.equal(result.actual, 2);
  assert.ok(!result.notice.includes('1件も起動していません'), result.notice);
  assert.equal(calls.register, 0);
  assert.ok(store.has(path.join(verify, '2026-08-30.json')));
});
