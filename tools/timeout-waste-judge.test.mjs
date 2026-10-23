import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimeoutRow, timeoutAttempts, judgeTimeoutRows, TIMEOUT_FIX_MERGED_AT } from './timeout-waste-judge.mjs';

const SINCE = '2026-10-16T18:50:03Z';

test('timeout 行は status または timedOut で拾う（chain の有無に依存しない）', () => {
  assert.equal(isTimeoutRow({ status: 'timeout' }), true);
  assert.equal(isTimeoutRow({ timedOut: true }), true);
  assert.equal(isTimeoutRow({ status: 124, timedOut: false }), false);
  assert.equal(isTimeoutRow({ status: 'ok' }), false);
  // 2026-10-15T15:50:25Z の実例: chain を持たない単一バックエンドの timeout 行。
  assert.equal(isTimeoutRow({ provider: 'codex', timedOut: true, secs: 540.621 }), true);
});

test('chain がある行は timeout した試行だけを捨てた秒数として数える', () => {
  const row = {
    t: '2026-10-13T04:29:23.281Z', provider: 'fallback', secs: 6153.749,
    chain: [
      { backend: 'gemini-cli', outcome: 'timeout', secs: 4953.625 },
      { backend: 'cheap-code:deepseek', outcome: 'timeout', secs: 600.027 },
      { backend: 'cheap-code:deepseek', outcome: 'ok', secs: 100 },
    ],
  };
  assert.deepEqual(timeoutAttempts(row).map((a) => a.secs), [4953.625, 600.027]);
});

test('chain が無い timeout 行は行そのものの secs を 1 試行として扱う', () => {
  // 予算は主経路の既定（--timeout 1800 秒）。旧行に timeoutSecs が無いときの後方互換。
  assert.deepEqual(timeoutAttempts({ provider: 'codex', secs: 540.621 }),
    [{ backend: 'codex', model: null, secs: 540.621, budgetSecs: 1800, path: 'primary' }]);
});

test('基準時刻より前しか無ければ「未確認（再発なし）」', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-15T15:50:25.619Z', provider: 'codex', timedOut: true, secs: 540.621 },
  ], { since: SINCE });
  assert.equal(report.verdict, 'unverified-no-recurrence');
  assert.equal(report.totalTimeoutRows, 1);
  assert.equal(report.postDeployTimeoutRows, 0);
});

test('配備後の timeout が上限内なら waste-within-cap', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-17T00:00:00Z', provider: 'codex', status: 'timeout', secs: 900.4 },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-within-cap');
  assert.equal(report.overCapRows, 0);
  assert.equal(report.maxAttemptSecs, 900.4);
  assert.equal(Math.round(report.wasteSecs), 900);
});

test('配備後に上限を超えて捨てたら waste-exceeds-cap', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-17T00:00:00Z', provider: 'fallback', status: 'timeout', secs: 4953.6, chain: [{ backend: 'gemini-cli', outcome: 'timeout', secs: 4953.6 }] },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-exceeds-cap');
  assert.equal(report.overCapRows, 1);
});

test('--since が不正なら例外', () => {
  assert.throws(() => judgeTimeoutRows([], { since: 'not-a-date' }), /--since/);
  assert.throws(() => judgeTimeoutRows([], { capSecs: 0 }), /cap/);
});

test('#773 のマージ時刻を既定の基準にしている', () => {
  assert.equal(TIMEOUT_FIX_MERGED_AT, SINCE);
});

test('2026-10-20 の実例（主経路 codex / 1800.28 秒 / chain 無し）は上限超過ではない', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-20T10:30:41.198Z', provider: 'codex', model: 'codex-cli/gpt-5.6-sol', lane: 'default_sol', timedOut: true, status: 'timeout', exitCode: 124, secs: 1800.28 },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-within-cap');
  assert.equal(report.overCapRows, 0);
  assert.deepEqual(report.overCapAttempts, []);
  assert.equal(report.events[0].attempts[0].budgetSecs, 1800);
  assert.equal(report.events[0].attempts[0].path, 'primary');
});

test('主経路は記録された --timeout を予算に使う', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-21T00:00:00Z', provider: 'codex', timedOut: true, secs: 1800.28, timeoutSecs: 1800 },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-within-cap');
  assert.equal(report.events[0].attempts[0].budgetSecs, 1800);
});

test('主経路でも与えた予算を超えたら上限超過としてバックエンドを残す', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-21T00:00:00Z', provider: 'codex', model: 'codex-cli/gpt-5.6-sol', timedOut: true, secs: 1900, timeoutSecs: 1800 },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-exceeds-cap');
  assert.equal(report.overCapRows, 1);
  assert.deepEqual(report.overCapBackends, ['codex']);
  assert.equal(report.overCapAttempts[0].path, 'primary');
  assert.equal(report.overCapAttempts[0].budgetSecs, 1800);
});

test('チェーン試行は記録された budgetSecs を予算に使う', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-21T00:00:00Z', provider: 'fallback', timedOut: true, secs: 950, chain: [
      { backend: 'gemini-cli', outcome: 'timeout', secs: 950, budgetSecs: 900 },
    ] },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-exceeds-cap');
  assert.deepEqual(report.overCapBackends, ['gemini-cli']);
  assert.equal(report.overCapAttempts[0].path, 'fallback');
});

test('チェーン試行で budgetSecs が無い旧行は既定 900 秒で判定する', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-21T00:00:00Z', provider: 'fallback', timedOut: true, secs: 1000, chain: [
      { backend: 'cheap-code:deepseek', outcome: 'timeout', secs: 1000 },
    ] },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-exceeds-cap');
  assert.equal(report.events[0].attempts[0].budgetSecs, 900);
});

test('チェーン試行は budgetSecs が記録されていれば既定より大きい予算を認める', () => {
  const report = judgeTimeoutRows([
    { t: '2026-10-21T00:00:00Z', provider: 'fallback', timedOut: true, secs: 1100, chain: [
      { backend: 'gemini-cli', outcome: 'timeout', secs: 1100, budgetSecs: 1200 },
    ] },
  ], { since: SINCE });
  assert.equal(report.verdict, 'waste-within-cap');
  assert.equal(report.events[0].attempts[0].budgetSecs, 1200);
});
