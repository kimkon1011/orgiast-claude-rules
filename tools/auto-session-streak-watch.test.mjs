import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutoSessionStreakWatch } from './auto-session-streak-watch.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'streak-watch-'));
  const runsDir = path.join(home, '.claude', 'auto-session', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  return { home, runsDir };
}

function addRun({ runsDir }, date, overrides = {}, suffix = '') {
  const stem = `${date}-feedback-app-13${suffix}`;
  const summaryFile = path.join(runsDir, `${stem}.summary.md`);
  const run = {
    source: 'feedback', issue: { repo: 'kimkon1011/app', number: 13 },
    status: 'failure', exitCode: 1, summaryFile, summary: '',
    startedAt: `${date}T03:00:00.000Z`, stderr: '実際のエラー', ...overrides
  };
  fs.writeFileSync(summaryFile, overrides.summaryFileContent ?? '');
  delete run.summaryFileContent;
  fs.writeFileSync(path.join(runsDir, `${stem}.json`), JSON.stringify(run));
}

test('0 バイト summary は exitCode=0 でも失敗になる', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  addRun(f, '2026-09-17', { status: 'success', exitCode: 0, summary: 'JSON上はあり' });
  addRun(f, '2026-09-18', { status: 'success', exitCode: 0, summary: 'JSON上はあり' });
  const result = await runAutoSessionStreakWatch({ home: f.home, dryRun: true });
  assert.equal(result.detected[0].streak, 2);
});

test('連続失敗 1 日では通知せず、2 日で通知する（notify は注入可能）', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  let calls = 0;
  addRun(f, '2026-09-17');
  let result = await runAutoSessionStreakWatch({ home: f.home, notifyImpl: async () => { calls++; }, now: new Date('2026-09-17T12:00:00Z') });
  assert.equal(result.detected.length, 0);
  addRun(f, '2026-09-18');
  result = await runAutoSessionStreakWatch({ home: f.home, notifyImpl: async () => { calls++; }, now: new Date('2026-09-18T12:00:00Z') });
  assert.equal(result.detected[0].streak, 2);
  assert.equal(calls, 1);
});

test('同日に成功 run が1件でもあれば streak が切れる', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  addRun(f, '2026-09-16'); addRun(f, '2026-09-17'); addRun(f, '2026-09-18');
  addRun(f, '2026-09-17', { status: 'success', exitCode: 0, summary: '完了', summaryFileContent: '完了' }, '-retry');
  const result = await runAutoSessionStreakWatch({ home: f.home, dryRun: true });
  assert.equal(result.detected.length, 0);
});

test('同日の二重通知を抑制し、streak が増えたら同日でも再通知する', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  addRun(f, '2026-09-17'); addRun(f, '2026-09-18');
  let calls = 0;
  const options = { home: f.home, now: new Date('2026-09-19T01:00:00Z'), notifyImpl: async () => { calls++; } };
  await runAutoSessionStreakWatch(options);
  const second = await runAutoSessionStreakWatch(options);
  assert.equal(second.suppressed.length, 1);
  assert.equal(calls, 1);
  addRun(f, '2026-09-19');
  await runAutoSessionStreakWatch(options);
  assert.equal(calls, 2);
});

test('2026-09-14〜18 の実障害 fixture を streak=5 で検出する', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  for (let day = 14; day <= 18; day++) addRun(f, `2026-09-${day}`, { status: 'failure', exitCode: 1, summary: '' });
  const result = await runAutoSessionStreakWatch({ home: f.home, dryRun: true });
  assert.equal(result.detected[0].streak, 5);
  assert.match(result.detected[0].message, /成功記録なし/);
  assert.match(result.detected[0].message, /1\. 原因調査/);
  assert.match(result.detected[0].message, /run JSON:/);
});

test('実行のない日をまたいで連続失敗にせず、過去の成功日は保持する', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  addRun(f, '2026-09-10', { status: 'success', exitCode: 0, summary: '完了', summaryFileContent: '完了' });
  addRun(f, '2026-09-12'); addRun(f, '2026-09-17'); addRun(f, '2026-09-18');
  const { detected: [item] } = await runAutoSessionStreakWatch({ home: f.home, dryRun: true });
  assert.equal(item.streak, 2);
  assert.equal(item.firstFailureDate, '2026-09-17');
  assert.equal(item.lastSuccessDate, '2026-09-10');
  assert.match(item.message, /【auto-session 異常】/);
});

test('manifest と集計配列をジョブとして誤検知しない', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  for (const day of ['17', '18']) {
    for (const suffix of ['', '-2']) fs.writeFileSync(path.join(f.runsDir, `2026-09-${day}-manifest${suffix}.json`), JSON.stringify({ startedAt: `2026-09-${day}T03:00:00Z`, selectedCount: 1 }));
    fs.writeFileSync(path.join(f.runsDir, `2026-09-${day}-results.json`), '[]');
  }
  assert.equal((await runAutoSessionStreakWatch({ home: f.home, dryRun: true })).detected.length, 0);
});

test('summary の欠損・空文字、exitCode の null/欠損、異常 status を失敗にする', async (t) => {
  for (const overrides of [
    { summaryFile: '/missing/streak-watch.summary.md' }, { summary: '' },
    { exitCode: null }, { exitCode: undefined }, { status: 'timeout' }
  ]) {
    const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
    for (const day of ['17', '18']) addRun(f, `2026-09-${day}`, {
      status: 'success', exitCode: 0, summary: '完了', summaryFileContent: '完了', ...overrides
    });
    assert.equal((await runAutoSessionStreakWatch({ home: f.home, dryRun: true })).detected[0].streak, 2);
  }
});

test('存在しない絶対 summary パスを同名 sibling で代用しない', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  for (const day of ['17', '18']) addRun(f, `2026-09-${day}`, {
    status: 'success', exitCode: 0, summary: '完了', summaryFileContent: '別ファイル',
    summaryFile: path.join(f.home, 'missing', `2026-09-${day}-feedback-app-13.summary.md`)
  });
  assert.equal((await runAutoSessionStreakWatch({ home: f.home, dryRun: true })).detected[0].streak, 2);
});

test('非 feedback は stem で集約し startedAt 優先、欠損時は mtime を使う', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  addRun(f, '2000-01-01', { source: 'role', startedAt: '2026-09-17T03:00:00Z' });
  addRun(f, '2000-01-02', { source: 'role', startedAt: undefined });
  const file = path.join(f.runsDir, '2000-01-02-feedback-app-13.json');
  const mtime = new Date('2026-09-18T03:00:00Z'); fs.utimesSync(file, mtime, mtime);
  const { detected: [item] } = await runAutoSessionStreakWatch({ home: f.home, dryRun: true });
  assert.equal(item.jobKey, 'feedback-app-13');
  assert.equal(item.streak, 2);
  assert.equal(item.firstFailureDate, '2026-09-17');
  assert.equal(item.latest.runFile, file);
});

test('日付は現地時間で集約し深夜の run を前日にずらさない', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  // Construct local midnight timestamps so this test also works on UTC hosts.
  addRun(f, '2026-09-17', { startedAt: new Date(2026, 8, 17, 0, 30).toISOString() });
  addRun(f, '2026-09-18', { startedAt: new Date(2026, 8, 18, 23, 30).toISOString() });
  const result = await runAutoSessionStreakWatch({ home: f.home, now: new Date(2026, 8, 19, 0, 1), notifyImpl: async () => {} });
  assert.equal(result.detected[0].streak, 2);
  assert.equal(result.detected[0].firstFailureDate, '2026-09-17');
  const state = JSON.parse(fs.readFileSync(path.join(f.home, '.claude/auto-session/streak-watch-state.json')));
  assert.equal(state['feedback:kimkon1011/app#13'].lastNotifiedDate, '2026-09-19');
});

test('dry-run は DM と state を変更せず、翌日の本実行は再通知する', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  addRun(f, '2026-09-17'); addRun(f, '2026-09-18');
  let calls = 0;
  const opts = { home: f.home, now: new Date('2026-09-19T03:00:00Z'), notifyImpl: async () => { calls++; } };
  const stateFile = path.join(f.home, '.claude/auto-session/streak-watch-state.json');
  await runAutoSessionStreakWatch({ ...opts, dryRun: true });
  assert.equal(calls, 0); assert.equal(fs.existsSync(stateFile), false);
  await runAutoSessionStreakWatch(opts);
  const before = fs.readFileSync(stateFile, 'utf8');
  await runAutoSessionStreakWatch({ ...opts, dryRun: true, now: new Date('2026-09-20T03:00:00Z') });
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  await runAutoSessionStreakWatch({ ...opts, now: new Date('2026-09-20T03:00:00Z') });
  assert.equal(calls, 2);
});

test('DM 失敗は通知済みにせず、他ジョブを通知して後で再試行する', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  for (const day of ['17', '18']) {
    addRun(f, `2026-09-${day}`);
    addRun(f, `2026-09-${day}`, { issue: { repo: 'kimkon1011/app', number: 14 } }, '-other');
  }
  let calls = 0;
  const opts = { home: f.home, now: new Date('2026-09-19T03:00:00Z') };
  const first = await runAutoSessionStreakWatch({ ...opts, notifyImpl: async (_, { item }) => {
    calls++;
    if (item.jobKey.endsWith('#13')) return { delivered: 'none', reason: 'offline' };
    return { delivered: 'dm' };
  } });
  assert.equal(first.detected.length, 2); assert.equal(first.errors.length, 1);
  assert.equal(first.notified.length, 1); assert.equal(calls, 2);
  const second = await runAutoSessionStreakWatch({ ...opts, notifyImpl: async () => { calls++; } });
  assert.equal(second.notified.length, 1); assert.equal(second.suppressed.length, 1);
  assert.equal(calls, 3);
});

test('重大通知に stderr 先頭300文字、選択肢とフルパスを含める', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  for (const day of ['16', '17', '18']) addRun(f, `2026-09-${day}`, { stderr: 'E'.repeat(300) + 'OMIT' });
  const { detected: [item] } = await runAutoSessionStreakWatch({ home: f.home, dryRun: true });
  assert.match(item.message, /【auto-session 重大】/);
  assert.ok(item.message.includes('E'.repeat(300))); assert.ok(!item.message.includes('OMIT'));
  for (const n of [1, 2, 3]) assert.ok(item.message.includes(`\n${n}. `));
  assert.ok(item.message.includes(`run JSON: ${item.latest.runFile}`));
  assert.ok(item.message.includes(`summary: ${item.latest.summaryPath}`));
});
