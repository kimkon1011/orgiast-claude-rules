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
  assert.deepEqual(timeoutAttempts({ provider: 'codex', secs: 540.621 }), [{ backend: 'codex', secs: 540.621 }]);
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
