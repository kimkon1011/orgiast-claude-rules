import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const upsert = fs.readFileSync(new URL('../gas/fleet-status-sheet/UpsertLogic.gs', import.meta.url), 'utf8');
const liveness = fs.readFileSync(new URL('../gas/fleet-status-sheet/LivenessLogic.gs', import.meta.url), 'utf8');
const context = {}; vm.createContext(context); vm.runInContext(`${upsert}\n${liveness}`.replace(/\bconst\s+/g, 'var '), context);
const base = Object.values(context.FLEET_HEADERS_);
function row(headers, values = {}) { return headers.map((header) => values[header] ?? ''); }
function payload(names = ['LABEL']) { return { checkedAt: '2026-08-28 12:34', items: [{ names, state: '停止', reason: '停止理由' }] }; }

test('列順に関係なく許可3列だけを書きA〜EとO列には書かない', () => {
  const headers = [...base].reverse();
  const rows = [row(headers, { [context.FLEET_HEADERS_.hostname]: 'LABEL', [context.FLEET_HEADERS_.consistency]: 'kim手書き' })];
  const plan = context.fleetPlanLiveness(headers, rows, payload());
  const written = Object.keys(plan.updates[0].values).map(Number).map((index) => headers[index]);
  assert.deepEqual(new Set(written), new Set(['稼働状態', '状態の理由', '状態確認日(JST)']));
  for (const forbidden of base.slice(0, 5).concat('整合性(自己申告↔検知)')) assert(!written.includes(forbidden), `${forbidden} was written`);
});

test('F列の完全一致を優先して更新する', () => {
  const rows = [row(base, { [context.FLEET_HEADERS_.selfPc]: '別名', [context.FLEET_HEADERS_.hostname]: 'LABEL' })];
  const plan = context.fleetPlanLiveness(base, rows, payload(['LABEL', '別名']));
  assert.equal(plan.updates[0].rowIndex, 0); assert.equal(plan.unmatched.length, 0);
});

test('D列一致でもF列に別ラベルがある行は触らない', () => {
  const rows = [row(base, { [context.FLEET_HEADERS_.selfPc]: 'PC-A', [context.FLEET_HEADERS_.hostname]: 'OTHER' })];
  const plan = context.fleetPlanLiveness(base, rows, payload(['PC-A']));
  assert.equal(plan.updates.length, 0); assert.deepEqual([...plan.unmatched], ['PC-A']);
});

test('突合不能は行を増やさずunmatchedへ返す', () => {
  const rows = [row(base, { [context.FLEET_HEADERS_.selfPc]: 'KNOWN' })];
  const plan = context.fleetPlanLiveness(base, rows, payload(['UNKNOWN']));
  assert.equal(plan.updates.length, 0); assert.equal(rows.length, 1); assert.deepEqual([...plan.unmatched], ['UNKNOWN']);
});
