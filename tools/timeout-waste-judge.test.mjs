import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimeoutRow, timeoutAttempts, judgeTimeoutRows, TIMEOUT_FIX_MERGED_AT, TIMEOUT_KILL_FIX_MERGED_AT } from './timeout-waste-judge.mjs';

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

test('#773 のマージ時刻は引き続き公開定数として固定', () => {
  assert.equal(TIMEOUT_FIX_MERGED_AT, SINCE);
});

// 2026-10-28T09:31Z の gemini-cli 1044秒/予算600秒は孫プロセス対策(13005ed 2026-10-28T19:08:39Z)の前の行。
const PRE_FIX_ROW = {
  t: '2026-10-28T09:31:24.679Z', provider: 'fallback', status: 'timeout', secs: 1091.46,
  chain: [{ backend: 'gemini-cli', model: 'gemini-3.7-flash', outcome: 'timeout', secs: 1044.395, budgetSecs: 600 }],
};

test('既定の基準は孫プロセス対策の配備日で、配備前の超過行は回帰として数えない', () => {
  assert.equal(TIMEOUT_KILL_FIX_MERGED_AT, '2026-10-28T19:08:39Z');
  const report = judgeTimeoutRows([PRE_FIX_ROW]);
  assert.equal(report.verdict, 'unverified-no-recurrence');
  assert.equal(report.totalTimeoutRows, 1);
  assert.equal(report.overCapRows, 0);
});

test('既定の基準でも、配備後に予算を超えた試行は waste-exceeds-cap のまま', () => {
  const report = judgeTimeoutRows([
    PRE_FIX_ROW,
    { ...PRE_FIX_ROW, t: '2026-10-29T10:00:00Z' },
  ]);
  assert.equal(report.verdict, 'waste-exceeds-cap');
  assert.equal(report.overCapRows, 1);
});

test('既定の基準でも、配備後の予算内 timeout は waste-within-cap', () => {
  const report = judgeTimeoutRows([
    PRE_FIX_ROW,
    { t: '2026-10-29T09:04:37.108Z', provider: 'fallback', status: 'timeout', secs: 601.958,
      chain: [{ backend: 'deepseek', outcome: 'timeout', secs: 601.958, budgetSecs: 600 }] },
  ]);
  assert.equal(report.verdict, 'waste-within-cap');
  assert.equal(report.postDeployTimeoutRows, 1);
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

test('主経路の新形式は execSecs で強制打ち切りの超過を判定する', () => {
  const report = judgeTimeoutRows([{
    t: '2026-11-01T16:18:49Z', provider: 'codex', status: 'timeout', timeoutSecs: 210,
    secs: 226.786, execSecs: 211, preSpawnSecs: 15.786,
  }], { since: SINCE });
  assert.equal(report.verdict, 'waste-within-cap');
  assert.equal(report.wasteSecs, 226.786);
  assert.equal(report.events[0].attempts[0].execSecs, 211);
  assert.equal(report.events[0].attempts[0].preSpawnSecs, 15.786);
});

test('主経路の旧形式は従来どおり secs と許容 5 秒で超過になる', () => {
  const report = judgeTimeoutRows([{
    t: '2026-11-01T16:18:49Z', provider: 'codex', status: 'timeout', timeoutSecs: 210,
    secs: 226.786, preSpawnSecs: 15.786,
  }], { since: SINCE });
  assert.equal(report.verdict, 'waste-exceeds-cap');
});

test('主経路の execSecs 自体が予算と kill 猶予を超えれば超過のまま', () => {
  const report = judgeTimeoutRows([{
    t: '2026-11-01T16:18:49Z', provider: 'codex', status: 'timeout', timeoutSecs: 210,
    secs: 255.786, execSecs: 240, preSpawnSecs: 15.786,
  }], { since: SINCE });
  assert.equal(report.verdict, 'waste-exceeds-cap');
  assert.equal(report.overCapAttempts[0].execSecs, 240);
  assert.equal(report.overCapAttempts[0].preSpawnSecs, 15.786);
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
