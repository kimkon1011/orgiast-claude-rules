import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackOutcomeToRecord, effectiveBackendTimeoutSecs, backendSpecificTimeoutSecs } from './codex-do.mjs';

test('冷却中の短縮予算で timeout したときは記録しない（冷却の自己延長を防ぐ）', () => {
  const normalSecs = backendSpecificTimeoutSecs('deepseek', {}, { kind: 'implement' });
  const bt = effectiveBackendTimeoutSecs('deepseek', { chainBudget: 1200, cooling: true, env: {}, isLastBackend: false, kind: 'implement' });
  assert.equal(bt, 120);
  assert.equal(fallbackOutcomeToRecord('timeout', { cooling: true, budgetSecs: bt, normalSecs }), null);
});

test('通常予算での timeout は従来どおり記録する', () => {
  assert.equal(fallbackOutcomeToRecord('timeout', { cooling: false, budgetSecs: 1200, normalSecs: 1200 }), 'timeout');
  assert.equal(fallbackOutcomeToRecord('timeout', { cooling: true, budgetSecs: 1200, normalSecs: 1200 }), 'timeout');
});

test('ok / blocked / cli_missing は冷却中でも記録し、それ以外は記録しない', () => {
  for (const o of ['ok', 'blocked', 'cli_missing']) assert.equal(fallbackOutcomeToRecord(o, { cooling: true, budgetSecs: 120, normalSecs: 1200 }), o);
  assert.equal(fallbackOutcomeToRecord('exhausted', { cooling: true, budgetSecs: 120, normalSecs: 1200 }), null);
  assert.equal(fallbackOutcomeToRecord('no_changes'), null);
});
