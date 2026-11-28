import assert from 'node:assert/strict';
import test from 'node:test';
import { anomalyFingerprint, orderAnomaliesForRun } from '../tools/nightly-health-remediate.mjs';

test('台帳に記録が無い異常が、記録済みの異常より前に来る', () => {
  const anomalies = [
    { label: 'known', message: 'a' },
    { label: 'fresh', message: 'b' }
  ];
  const knownFp = anomalyFingerprint(anomalies[0]);
  const prior = [
    { fingerprint: knownFp, label: 'known', outcome: 'escalated', reason: '手動', ranAt: '2026-11-20T00:00:00Z' }
  ];
  const ordered = orderAnomaliesForRun(anomalies, prior, anomalyFingerprint);
  assert.deepEqual(ordered.map((a) => a.label), ['fresh', 'known']);
});

test('直近 outcome が deferred かつ reason に「予算」を含む異常が、ranAt の古い順に並ぶ', () => {
  const older = { label: 'older-budget', message: 'x' };
  const newer = { label: 'newer-budget', message: 'y' };
  const other = { label: 'other', message: 'z' };
  const prior = [
    {
      fingerprint: anomalyFingerprint(newer),
      label: newer.label,
      outcome: 'deferred',
      reason: '45分の全体予算: 残り5分未満',
      ranAt: '2026-11-26T15:00:00Z'
    },
    {
      fingerprint: anomalyFingerprint(older),
      label: older.label,
      outcome: 'deferred',
      reason: '45分の全体予算: 残り5分未満',
      ranAt: '2026-11-25T15:00:00Z'
    },
    {
      fingerprint: anomalyFingerprint(other),
      label: other.label,
      outcome: 'escalated',
      reason: '回帰テスト失敗',
      ranAt: '2026-11-24T15:00:00Z'
    }
  ];
  const ordered = orderAnomaliesForRun([newer, older, other], prior, anomalyFingerprint);
  assert.deepEqual(ordered.map((a) => a.label), ['older-budget', 'newer-budget', 'other']);
});

test('上記いずれにも該当しない異常同士は、入力の順序が保たれる（安定ソート）', () => {
  const anomalies = [
    { label: 'first', message: '1' },
    { label: 'second', message: '2' },
    { label: 'third', message: '3' }
  ];
  const prior = anomalies.map((anomaly, i) => ({
    fingerprint: anomalyFingerprint(anomaly),
    label: anomaly.label,
    outcome: 'escalated',
    reason: '手動',
    ranAt: `2026-11-2${i}T00:00:00Z`
  }));
  const ordered = orderAnomaliesForRun(anomalies, prior, anomalyFingerprint);
  assert.deepEqual(ordered.map((a) => a.label), ['first', 'second', 'third']);
});

test('同じ fingerprint に予算切れ deferred と後続の skipped がある場合でも tier 1 として先頭側に並ぶ', () => {
  const budgetDeferred = { label: 'budget-then-skipped', message: 'held' };
  const escalated = { label: 'escalated-later', message: 'done' };
  const budgetFp = anomalyFingerprint(budgetDeferred);
  const prior = [
    {
      fingerprint: budgetFp,
      label: budgetDeferred.label,
      outcome: 'deferred',
      reason: '45分の全体予算: 残り5分未満',
      ranAt: '2026-11-27T03:04:01.895Z'
    },
    {
      fingerprint: budgetFp,
      label: budgetDeferred.label,
      outcome: 'skipped',
      reason: '同日処理済み',
      ranAt: '2026-11-27T09:42:28.538Z'
    },
    {
      fingerprint: anomalyFingerprint(escalated),
      label: escalated.label,
      outcome: 'escalated',
      reason: '手動',
      ranAt: '2026-11-27T10:00:00.000Z'
    }
  ];
  const ordered = orderAnomaliesForRun([escalated, budgetDeferred], prior, anomalyFingerprint);
  assert.deepEqual(ordered.map((a) => a.label), ['budget-then-skipped', 'escalated-later']);
});
