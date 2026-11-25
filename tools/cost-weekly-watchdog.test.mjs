import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWeeklyHeartbeats } from './cost-improve-watchdog.mjs';

const NOW = '2026-09-07T00:00:00.000Z';
const WEEK = 7 * 24 * 60 * 60 * 1000;

test('週次 heartbeat: OK が 8日+2h 以内にあれば異常なし', () => {
  const rows = [{ pcName: 'kim-PC', label: 'kim-PC', costWeeklyRanAt: new Date(Date.parse(NOW) - WEEK).toISOString(), costWeeklyStatus: 'OK' }];
  assert.deepEqual(inspectWeeklyHeartbeats(rows, new Date(NOW)), []);
});

test('週次 heartbeat: OK でも 8日+2h 超なら実行不足として通知', () => {
  const stale = new Date(Date.parse(NOW) - (8 * 24 + 3) * 60 * 60 * 1000).toISOString();
  const rows = [{ pcName: 'kim-PC', label: 'kim-PC', costWeeklyRanAt: stale, costWeeklyStatus: 'OK' }];
  const items = inspectWeeklyHeartbeats(rows, new Date(NOW));
  assert.equal(items.length, 1);
  assert.match(items[0].reason, /週次コスト改善ループが.*時間以上実行されていません/);
  assert.match(items[0].action, /OrgiastCostWeeklyImprove/);
});

test('週次 heartbeat: 直近 NG は鮮度に関わらず通知する', () => {
  const rows = [{ pcName: 'kim-PC', costWeeklyRanAt: new Date(Date.parse(NOW) - 1000).toISOString(), costWeeklyStatus: 'NG' }];
  const items = inspectWeeklyHeartbeats(rows, new Date(NOW));
  assert.equal(items.length, 1);
  assert.match(items[0].reason, /週次改善ループ実行結果がNG/);
});

test('週次 heartbeat: runner 指定時は該当機の鮮度だけ見る', () => {
  const stale = new Date(Date.parse(NOW) - (8 * 24 + 3) * 60 * 60 * 1000).toISOString();
  const rows = [
    { pcName: 'kim-PC', costWeeklyRanAt: stale, costWeeklyStatus: 'OK' },
    { pcName: 'other-PC', costWeeklyRanAt: new Date().toISOString(), costWeeklyStatus: 'OK' },
  ];
  const items = inspectWeeklyHeartbeats(rows, new Date(NOW), undefined, 'kim-PC');
  assert.equal(items.length, 1);
  assert.equal(items[0].pcName, 'kim-PC');
});
