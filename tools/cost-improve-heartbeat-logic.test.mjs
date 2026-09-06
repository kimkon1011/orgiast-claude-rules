import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const upsert = fs.readFileSync(new URL('../gas/fleet-status-sheet/UpsertLogic.gs', import.meta.url), 'utf8');
const logic = fs.readFileSync(new URL('../gas/fleet-status-sheet/CostImproveHeartbeatLogic.gs', import.meta.url), 'utf8');
const context = {}; vm.createContext(context); vm.runInContext(`${upsert}\n${logic}`.replace(/\bconst\s+/g, 'var '), context);

test('heartbeat は一致したPCの新しい2列だけを更新する', () => {
  const headers = Object.values(context.FLEET_HEADERS_);
  const row = headers.map(() => 'keep');
  row[headers.indexOf(context.FLEET_HEADERS_.hostname)] = 'kim-PC';
  const plan = context.fleetPlanCostImproveHeartbeat(headers, [row], { label: 'kim-PC', ranAt: '2026-09-06T00:00:00Z', status: 'OK' });
  assert.equal(plan.rowIndex, 0);
  assert.deepEqual(Object.keys(plan.values).map(Number).map(i => headers[i]).sort(), ['コスト改善ループ最終実行', 'コスト改善ループ結果'].sort());
});

const HEARTBEAT_COL_KEYS = ['costLoopRanAt', 'costLoopStatus', 'costWeeklyRanAt', 'costWeeklyStatus'];
test('古いシートでも新列は optional で、header plan が右端へ補う', () => {
  const oldHeaders = Object.entries(context.FLEET_HEADERS_).filter(([key]) => !HEARTBEAT_COL_KEYS.includes(key)).map(([, value]) => value);
  assert.doesNotThrow(() => context.fleetResolveColumns(oldHeaders));
  // fleetPlanHeaders と同じ規則: optional の不足列だけを末尾に足す。
  const planned = oldHeaders.slice();
  context.FLEET_OPTIONAL_HEADERS_.forEach(key => { if (context.fleetFindHeaderIndex(planned, context.FLEET_HEADERS_[key]) < 0) planned.push(context.FLEET_HEADERS_[key]); });
  assert.deepEqual(planned.slice(-4), ['コスト改善ループ最終実行', 'コスト改善ループ結果', 'コスト週次改善ループ最終実行', 'コスト週次改善ループ結果']);
});

test('新列が両方無いシートでは、黙って0セル更新にせず失敗する', () => {
  // 1セルも書けないのに ok を返すと、見張り側が「実行されていない」と誤検知する。
  const headers = Object.entries(context.FLEET_HEADERS_)
    .filter(([key]) => !['costLoopRanAt', 'costLoopStatus'].includes(key))
    .map(([, value]) => value);
  const row = headers.map(() => 'keep');
  row[headers.indexOf(context.FLEET_HEADERS_.hostname)] = 'kim-PC';
  assert.throws(
    () => context.fleetPlanCostImproveHeartbeat(headers, [row], { label: 'kim-PC', ranAt: '2026-09-06T00:00:00Z', status: 'OK' }),
    /heartbeat_columns_missing/,
  );
});

test('週次 heartbeat は一致したPCの新しい週次2列だけを更新し、日次の列は触らない', () => {
  const headers = Object.values(context.FLEET_HEADERS_);
  const c = context.fleetResolveColumns(headers);
  const row = headers.map(() => 'keep');
  row[c.hostname] = 'kim-PC';
  const plan = context.fleetPlanCostWeeklyHeartbeat(headers, [row], { label: 'kim-PC', ranAt: '2026-09-07T00:00:00Z', status: 'OK' });
  assert.equal(plan.rowIndex, 0);
  const written = Object.keys(plan.values).map(Number).map(i => headers[i]);
  assert.deepEqual(written.sort(), ['コスト週次改善ループ最終実行', 'コスト週次改善ループ結果'].sort());
  assert.ok(!written.includes('コスト改善ループ最終実行') && !written.includes('コスト改善ループ結果'), JSON.stringify(written));
});

test('週次 heartbeat: 週次2列が無いシートでは失敗し、ラベル不一致は heartbeat_pc_not_found', () => {
  const headers = Object.values(context.FLEET_HEADERS_).filter((h) => h !== 'コスト週次改善ループ最終実行' && h !== 'コスト週次改善ループ結果');
  const c = context.fleetResolveColumns(headers);
  const row = headers.map(() => 'keep');
  row[c.hostname] = 'kim-PC';
  assert.throws(() => context.fleetPlanCostWeeklyHeartbeat(headers, [row], { label: 'kim-PC', ranAt: '2026-09-07T00:00:00Z', status: 'OK' }), /heartbeat_columns_missing/);
  const withCols = Object.values(context.FLEET_HEADERS_);
  const row2 = withCols.map(() => 'keep');
  row2[context.fleetResolveColumns(withCols).hostname] = 'other-PC';
  assert.throws(() => context.fleetPlanCostWeeklyHeartbeat(withCols, [row2], { label: 'kim-PC', ranAt: '2026-09-07T00:00:00Z', status: 'OK' }), /heartbeat_pc_not_found/);
});
