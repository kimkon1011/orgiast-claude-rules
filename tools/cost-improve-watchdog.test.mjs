import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHeartbeats, main } from './cost-improve-watchdog.mjs';

const NOW = new Date('2026-09-06T12:00:00Z');

test('36時間より古い heartbeat を通知対象にする', () => {
  const items = inspectHeartbeats([{ pcName: 'kim-PC', costLoopRanAt: '2026-09-04T00:00:00Z', costLoopStatus: 'OK' }], NOW);
  assert.equal(items.length, 1); assert.match(items[0].reason, /実行されていません/); assert.match(items[0].action, /Get-ScheduledTask/);
});

test('costLoopStatus NG を通知対象にする', () => {
  const items = inspectHeartbeats([{ pcName: 'kim-PC', costLoopRanAt: NOW.toISOString(), costLoopStatus: 'NG' }], NOW);
  assert.equal(items.length, 1); assert.match(items[0].reason, /NG/);
});

test('doGet 失敗は取得失敗として通知対象になる', async () => {
  let text = '';
  const result = await main([], { fetchRows: async () => { throw new Error('timeout'); }, notify: async value => { text = value; }, now: NOW });
  assert.equal(result.ok, false); assert.equal(result.notified, true); assert.match(text, /見に行けませんでした/); assert.doesNotMatch(text, /異常なし/);
});

test('--dry-run は異常を表示するが通知しない', async () => {
  let notified = false;
  const result = await main(['--dry-run'], { fetchRows: async () => [{ pcName: 'kim-PC', costLoopRanAt: '', costLoopStatus: '' }], notify: async () => { notified = true; }, now: NOW });
  assert.equal(result.ok, false); assert.equal(result.notified, false); assert.equal(notified, false);
});

test('未申告の名簿20行があっても3時間前のOKが1台あれば通知しない', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ pcName: `名簿-${i}`, costLoopRanAt: '', costLoopStatus: '' }));
  rows.push({ pcName: 'runner', costLoopRanAt: '2026-09-06T09:00:00Z', costLoopStatus: 'OK' });
  assert.deepEqual(inspectHeartbeats(rows, NOW), []);
});

test('36時間以内のOKがなければフリート停止を1件だけ通知する', () => {
  const rows = Array.from({ length: 26 }, (_, i) => ({ pcName: `PC-${i}`, costLoopRanAt: '', costLoopStatus: '' }));
  assert.equal(inspectHeartbeats(rows, NOW).length, 1);
  assert.match(inspectHeartbeats(rows, NOW)[0].reason, /フリート全体で36時間以上/);
});

test('新しい heartbeat でも NG は個別通知する', () => {
  const items = inspectHeartbeats([
    { pcName: 'broken', costLoopRanAt: NOW.toISOString(), costLoopStatus: 'NG' },
    { pcName: 'runner', costLoopRanAt: NOW.toISOString(), costLoopStatus: 'OK' }
  ], NOW);
  assert.equal(items.length, 1); assert.equal(items[0].pcName, 'broken');
});

test('COST_IMPROVE_RUNNER 指定時は指定機だけで鮮度判定する', () => {
  const rows = [
    { pcName: 'other', costLoopRanAt: NOW.toISOString(), costLoopStatus: 'OK' },
    { pcName: 'runner', costLoopRanAt: '2026-09-01T00:00:00Z', costLoopStatus: 'OK' }
  ];
  const items = inspectHeartbeats(rows, NOW, 36, 'runner');
  assert.equal(items.length, 1); assert.match(items[0].reason, /指定実行機/);
});
