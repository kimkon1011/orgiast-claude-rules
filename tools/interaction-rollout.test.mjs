import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRollout, buildStallMessage, buildWatchMessage, runInteractionRollout,
  shouldNotify, shouldNotifyStall, shouldRunWatch, STALL_AFTER_MS,
} from './interaction-rollout.mjs';

const NOW = new Date('2026-08-30T12:00:00.000Z');

test('適用済・未適用/旧版・稼働中だが未取込・未導入/電源offの4群に分類する', () => {
  const rows = [
    { pcName: 'a', reportedAt: '2026-08-30 10:00', interactionLoop: '適用済(ab12345) / 最終実行 2026-08-30 03:00' },
    { pcName: 'b', reportedAt: '2026-08-30 09:00', interactionLoop: '旧版(old / main=new)' },
    { pcName: 'c', reportedAt: '2026-08-30 08:00', interactionLoop: '未適用' },
    { pcName: 'd', reportedAt: '2026-08-30 07:00', interactionLoop: '' },
  ];
  const result = buildRollout(rows, NOW);
  assert.deepEqual(result.summary, { applied: 1, outdated: 2, liveNotApplied: 1, unreported: 0 });
  assert.deepEqual(result.rows.map((row) => row.category), ['applied', 'outdated', 'outdated', 'liveNotApplied']);
});

test('適用済の判定は reportedAt の有無より優先する', () => {
  const result = buildRollout([{ pcName: 'silent', reportedAt: '', interactionLoop: '適用済(ab12345)' }], NOW);
  assert.equal(result.rows[0].category, 'applied');
});

test('interactionLoop が空で2日前の報告なら稼働中だが未取込', () => {
  const result = buildRollout([{ reportedAt: '2026-08-28 21:00', interactionLoop: '' }], NOW);
  assert.equal(result.rows[0].category, 'liveNotApplied');
});

test('interactionLoop が空で10日前の報告なら未導入・電源off', () => {
  const result = buildRollout([{ reportedAt: '2026-08-20 21:00', interactionLoop: '' }], NOW);
  assert.equal(result.rows[0].category, 'unreported');
});

test('reportedAt が空なら未導入・電源off', () => {
  const result = buildRollout([{ reportedAt: '', interactionLoop: '' }], NOW);
  assert.equal(result.rows[0].category, 'unreported');
});

test('最終報告の新しい順に並べる', () => {
  const result = buildRollout([
    { pcName: 'old', reportedAt: '2026-08-29 12:00', interactionLoop: '未適用' },
    { pcName: 'new', reportedAt: '2026-08-30 12:00', interactionLoop: '適用済(x)' },
    { pcName: 'empty', reportedAt: '', interactionLoop: '' },
  ], NOW);
  assert.deepEqual(result.rows.map((row) => row.pcName), ['new', 'old', 'empty']);
});

test('doGet が ok:false でも例外終了せず stderr に出して exit 0 相当', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/fleet\nFLEET_SHEET_TOKEN=test\n');
  const output = { stdout: [], stderr: [] };
  await runInteractionRollout({
    env: { ORGIAST_HOME: home },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) }),
    stdout: (line) => output.stdout.push(line),
    stderr: (line) => output.stderr.push(line),
  });
  assert.deepEqual(output.stdout, []);
  assert.equal(output.stderr.length, 1);
  assert.match(output.stderr[0], /doGetエラー: unauthorized/);
});

test('前回と同じ集計なら通知しない', () => {
  const counts = { applied: 3, stale: 2, liveNotApplied: 1, unreported: 1, done: false };
  assert.equal(shouldNotify(counts, counts), false);
});

test('applied が増えたら通知する', () => {
  assert.equal(shouldNotify(
    { applied: 2, stale: 2, liveNotApplied: 1, unreported: 1, done: false },
    { applied: 3, stale: 2, liveNotApplied: 1, unreported: 1, done: false },
  ), true);
});

test('stale/liveNotApplied が 0 なら完了メッセージ', () => {
  assert.equal(buildWatchMessage({ applied: 7, stale: 0, liveNotApplied: 0, unreported: 24, done: true }, []), '✅ 対話ループ: 全7台が適用済');
});

test('done: true の後は変化があっても通知しない', () => {
  assert.equal(shouldNotify(
    { applied: 7, stale: 0, liveNotApplied: 0, unreported: 0, done: true },
    { applied: 6, stale: 1, liveNotApplied: 0, unreported: 0, done: false },
  ), false);
});

test('未適用・旧版の列挙は10台まで', () => {
  const names = Array.from({ length: 11 }, (_, index) => `pc-${index + 1}`);
  const message = buildWatchMessage({ applied: 1, stale: 11, liveNotApplied: 0, unreported: 2, done: false }, names);
  assert.match(message, /pc-10/);
  assert.doesNotMatch(message, /pc-11/);
});

test('マーカーファイルが無ければ watch は実行対象外', () => {
  assert.equal(shouldRunWatch(false), false);
  assert.equal(shouldRunWatch(true), true);
});

test('--watch はマーカー無しなら設定未存在でも完全無音', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-no-marker-'));
  const output = { stdout: [], stderr: [] };
  await runInteractionRollout({
    argv: ['--watch'], env: { ORGIAST_HOME: home },
    stdout: (line) => output.stdout.push(line), stderr: (line) => output.stderr.push(line),
    fetchImpl: async () => { throw new Error('呼ばれてはいけない'); },
  });
  assert.deepEqual(output, { stdout: [], stderr: [] });
});

const stalledCounts = { applied: 3, stale: 2, liveNotApplied: 0, unreported: 1, done: false };

test('firstSeenAt から12時間未満なら停滞通知しない', () => {
  const prev = { ...stalledCounts, firstSeenAt: '2026-08-30T00:00:00.000Z' };
  assert.equal(shouldNotifyStall(prev, stalledCounts, new Date('2026-08-30T11:59:59.999Z')), false);
});

test('12時間以上・未完了・未通知なら停滞通知する', () => {
  const prev = { ...stalledCounts, firstSeenAt: '2026-08-30T00:00:00.000Z' };
  assert.equal(shouldNotifyStall(prev, stalledCounts, new Date('2026-08-30T12:00:00.000Z')), true);
});

test('前回の停滞通知から24時間未満なら再送しない', () => {
  const prev = {
    ...stalledCounts,
    firstSeenAt: '2026-08-28T00:00:00.000Z',
    lastStallNotifiedAt: '2026-08-30T00:00:00.000Z',
  };
  assert.equal(shouldNotifyStall(prev, stalledCounts, new Date('2026-08-30T23:59:59.999Z')), false);
});

test('前回の停滞通知から24時間以上なら再送する', () => {
  const prev = {
    ...stalledCounts,
    firstSeenAt: '2026-08-28T00:00:00.000Z',
    lastStallNotifiedAt: '2026-08-30T00:00:00.000Z',
  };
  assert.equal(shouldNotifyStall(prev, stalledCounts, new Date('2026-08-31T00:00:00.000Z')), true);
});

test('done: true なら12時間以上経っても停滞通知しない', () => {
  const done = { applied: 6, stale: 0, liveNotApplied: 0, unreported: 24, done: true };
  const prev = { ...done, firstSeenAt: '2026-08-28T00:00:00.000Z' };
  assert.equal(shouldNotifyStall(prev, done, new Date('2026-08-31T00:00:00.000Z')), false);
});

test('集計に変化があるときは停滞ではなく通常通知になる', () => {
  const prev = { ...stalledCounts, applied: 2, firstSeenAt: '2026-08-28T00:00:00.000Z' };
  const now = new Date('2026-08-31T00:00:00.000Z');
  assert.equal(shouldNotify(prev, stalledCounts), true);
  assert.equal(shouldNotifyStall(prev, stalledCounts, now), false);
});

test('未導入・電源off だけなら完了し停滞通知しない', () => {
  const curr = { applied: 3, stale: 0, liveNotApplied: 0, unreported: 24, done: true };
  const prev = { ...curr, done: false, firstSeenAt: '2026-08-28T00:00:00.000Z' };
  assert.equal(curr.done, true);
  assert.equal(shouldNotifyStall(prev, curr, NOW), false);
});

test('watch は未導入・電源off が24台あっても done: true を保存する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-done-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'interaction-rollout-watch'), '');
  fs.writeFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/fleet\nFLEET_SHEET_TOKEN=test\n');
  fs.writeFileSync(path.join(claudeDir, 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK=https://example.invalid/webhook\n');
  await runInteractionRollout({
    argv: ['--watch'], env: { ORGIAST_HOME: home }, now: () => NOW,
    stdout: assert.fail, stderr: assert.fail,
    fetchImpl: async (url, options = {}) => options.method === 'POST'
      ? { ok: true }
      : { ok: true, json: async () => ({
        ok: true,
        rows: Array.from({ length: 24 }, (_, index) => ({
          pcName: `off-${index}`, reportedAt: '', interactionLoop: '',
        })),
      }) },
  });
  const state = JSON.parse(fs.readFileSync(path.join(claudeDir, 'interaction-rollout-state.json'), 'utf8'));
  assert.equal(state.unreported, 24);
  assert.equal(state.liveNotApplied, 0);
  assert.equal(state.done, true);
});

test('watch は webhook 未設定でも kim DM が届けば完了状態を保存する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-dm-'));
  const claudeDir = path.join(home, '.claude'); fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'interaction-rollout-watch'), '');
  fs.writeFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/fleet\nFLEET_SHEET_TOKEN=test\n');
  let notification = '';
  await runInteractionRollout({
    argv: ['--watch'], env: { ORGIAST_HOME: home }, now: () => NOW, stdout: assert.fail, stderr: assert.fail,
    notifyKimImpl: async (message) => { notification = message; return { delivered: 'dm' }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, rows: [{ pcName: 'ready', reportedAt: '2026-08-30', interactionLoop: '適用済(x)' }] }) }),
  });
  assert.match(notification, /^✅ 対話ループ/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeDir, 'interaction-rollout-state.json'), 'utf8')).done, true);
});

test('稼働中だが未取込が1台なら12時間後に停滞通知する', () => {
  const curr = { applied: 3, stale: 0, liveNotApplied: 1, unreported: 24, done: false };
  const prev = { ...curr, firstSeenAt: '2026-08-30T00:00:00.000Z' };
  assert.equal(shouldNotifyStall(prev, curr, NOW), true);
});

test('未導入・電源off だけが24台から22台に変わっても通知しない', () => {
  assert.equal(shouldNotify(
    { applied: 3, stale: 0, liveNotApplied: 0, unreported: 24, done: false },
    { applied: 3, stale: 0, liveNotApplied: 0, unreported: 22, done: false },
  ), false);
});

test('停滞文面の時間数は STALL_AFTER_MS に追随する', () => {
  const message = buildStallMessage({ applied: 3, stale: 1, liveNotApplied: 0, unreported: 24, done: false });
  assert.match(message, new RegExp(`^⚠ 対話ループの展開が${STALL_AFTER_MS / 3_600_000}時間進んでいません`));
});

test('停滞文面に未導入・電源off の集計を含めない', () => {
  const message = buildStallMessage({ applied: 3, stale: 1, liveNotApplied: 0, unreported: 24, done: false });
  assert.doesNotMatch(message, /未導入|電源off|未報告/);
});

test('停滞文面の未適用・旧版の列挙は10台まで', () => {
  const names = Array.from({ length: 11 }, (_, index) => `pc-${index + 1}`);
  const message = buildStallMessage({ applied: 1, stale: 11, liveNotApplied: 0, unreported: 0, done: false }, names);
  assert.match(message, /pc-10/);
  assert.doesNotMatch(message, /pc-11/);
});

test('既存stateに firstSeenAt が無ければ同じ集計でも補完して保存する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-migrate-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'interaction-rollout-watch'), '');
  fs.writeFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/fleet\nFLEET_SHEET_TOKEN=test\n');
  fs.writeFileSync(path.join(claudeDir, 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK=https://example.invalid/webhook\n');
  fs.writeFileSync(path.join(claudeDir, 'interaction-rollout-state.json'), `${JSON.stringify(stalledCounts)}\n`);
  const stdout = [];
  await runInteractionRollout({
    argv: ['--watch'], env: { ORGIAST_HOME: home }, now: () => new Date('2026-08-30T00:00:00.000Z'),
    stdout: (line) => stdout.push(line), stderr: assert.fail,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, rows: [
      ...Array.from({ length: 3 }, (_, i) => ({ pcName: `applied-${i}`, reportedAt: '2026-08-30', interactionLoop: '適用済(x)' })),
      ...Array.from({ length: 2 }, (_, i) => ({ pcName: `stale-${i}`, reportedAt: '2026-08-30', interactionLoop: '旧版(x)' })),
      { pcName: 'unreported', reportedAt: '', interactionLoop: '' },
    ] }) }),
  });
  const state = JSON.parse(fs.readFileSync(path.join(claudeDir, 'interaction-rollout-state.json'), 'utf8'));
  assert.equal(state.firstSeenAt, '2026-08-30T00:00:00.000Z');
  assert.deepEqual(stdout, ['skip:前回と差分なし']);
});

test('停滞投稿が成功した時だけ lastStallNotifiedAt を保存する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-stall-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'interaction-rollout-watch'), '');
  fs.writeFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/fleet\nFLEET_SHEET_TOKEN=test\n');
  fs.writeFileSync(path.join(claudeDir, 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK=https://example.invalid/webhook\n');
  fs.writeFileSync(path.join(claudeDir, 'interaction-rollout-state.json'), `${JSON.stringify({
    ...stalledCounts, firstSeenAt: '2026-08-28T00:00:00.000Z', notifiedAt: '2026-08-28T00:00:00.000Z',
  })}\n`);
  let postedContent = '';
  await runInteractionRollout({
    argv: ['--watch'], env: { ORGIAST_HOME: home }, now: () => new Date('2026-08-30T00:00:00.000Z'),
    stdout: assert.fail, stderr: assert.fail,
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') {
        postedContent = JSON.parse(options.body).content;
        return { ok: true };
      }
      return { ok: true, json: async () => ({ ok: true, rows: [
        ...Array.from({ length: 3 }, (_, i) => ({ pcName: `applied-${i}`, reportedAt: '2026-08-30', interactionLoop: '適用済(x)' })),
        ...Array.from({ length: 2 }, (_, i) => ({ pcName: `stale-${i}`, reportedAt: '2026-08-30', interactionLoop: '旧版(x)' })),
        { pcName: 'unreported', reportedAt: '', interactionLoop: '' },
      ] }) };
    },
  });
  const state = JSON.parse(fs.readFileSync(path.join(claudeDir, 'interaction-rollout-state.json'), 'utf8'));
  assert.match(postedContent, /^⚠ 対話ループの展開が12時間進んでいません/);
  assert.equal(state.lastStallNotifiedAt, '2026-08-30T00:00:00.000Z');
  assert.equal(state.notifiedAt, '2026-08-30T00:00:00.000Z');
});
