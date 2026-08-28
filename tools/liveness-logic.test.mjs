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
  assert.equal(plan.updates.length, 0); assert.equal(plan.appended.length, 0); assert.equal(rows.length, 1); assert.deepEqual([...plan.unmatched], ['UNKNOWN']);
});

test('実データ同様の別表記が複数行あるとき一致行をすべて更新する', () => {
  const rows = [
    row(base, { [context.FLEET_HEADERS_.hostname]: 'kim-PC' }),
    row(base, { [context.FLEET_HEADERS_.hostname]: 'kim-PC(開発機/kim)' }),
    row(base, { [context.FLEET_HEADERS_.hostname]: 'DESKTOP-2D0R4LI' }),
    row(base, { [context.FLEET_HEADERS_.hostname]: 'kimko-PC' }),
    row(base, { [context.FLEET_HEADERS_.hostname]: '作業用011(=DESKTOP-PPD5V8I)' }),
    row(base, { [context.FLEET_HEADERS_.selfPc]: '作業用011' }),
  ];
  const plan = context.fleetPlanLiveness(base, rows, {
    checkedAt: '2026-08-28 12:34',
    items: [
      { names: ['kim-PC', 'kim-PC(開発機/kim)', 'DESKTOP-2D0R4LI'], state: '生存', reason: '報告あり' },
      { names: ['kimko-PC', '作業用011(=DESKTOP-PPD5V8I)', '作業用011'], state: '生存', reason: '報告あり' },
    ],
  });
  assert.deepEqual([...plan.updates.map((update) => update.rowIndex)], [0, 1, 2, 3, 4, 5]);
  assert.equal(plan.unmatched.length, 0);
});

test('appendUnmatched:true はF列と稼働3列だけを持つ行を末尾へ計画する', () => {
  const headers = [base[2], ...base.slice(3), ...base.slice(0, 2)];
  const rows = [row(headers, { [context.FLEET_HEADERS_.selfPc]: 'KNOWN' })];
  const plan = context.fleetPlanLiveness(headers, rows, { ...payload(['百瀬-PC']), appendUnmatched: true });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unmatched.length, 0);
  assert.equal(plan.appended.length, 1);
  assert.equal(plan.appended[0].rowIndex, 1);
  assert.equal(plan.appended[0].label, '百瀬-PC');
  const appendedRow = headers.map((_, index) => plan.appended[0].values[index] ?? '');
  const nonEmpty = appendedRow.map((value, index) => value !== '' ? headers[index] : null).filter(Boolean);
  assert.deepEqual(new Set(nonEmpty), new Set([context.FLEET_HEADERS_.hostname, '稼働状態', '状態の理由', '状態確認日(JST)']));
  for (const forbidden of base.slice(0, 5).concat('整合性(自己申告↔検知)')) assert.equal(appendedRow[headers.indexOf(forbidden)], '');
});
