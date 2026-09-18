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
