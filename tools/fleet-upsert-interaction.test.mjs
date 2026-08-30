import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/UpsertLogic.gs', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);

function payload() {
  return {
    label: 'PC-A', reportedAt: '2026-08-31 03:00', claudeUsd: 0, mainModel: '', delegRatio: '0.0%',
    cheapAiUse: 'なし', codexLogin: '済', fable5: '未検出', disciplineAlert: '判定不能',
    interactionLoop: '適用済(abc1234) / 最終実行 2026-08-31 03:00', interactionSelftest: 'PASS 21/21',
  };
}

test('対話ループ列が無くてもupsertできる', () => {
  const headers = Object.entries(context.FLEET_HEADERS_)
    .filter(([key]) => !context.FLEET_OPTIONAL_HEADERS_.includes(key))
    .map(([, header]) => header);
  assert.doesNotThrow(() => context.fleetPlanUpsert(headers, [], payload()));
});

test('対話ループ列があれば両方へ値を入れる', () => {
  const headers = Object.values(context.FLEET_HEADERS_);
  const plan = context.fleetPlanUpsert(headers, [], payload());
  assert.equal(plan.values[headers.indexOf(context.FLEET_HEADERS_.interactionLoop)], payload().interactionLoop);
  assert.equal(plan.values[headers.indexOf(context.FLEET_HEADERS_.interactionSelftest)], payload().interactionSelftest);
});
