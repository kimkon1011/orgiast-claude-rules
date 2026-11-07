import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUSY_POLICY,
  backoffDelay,
  chargeBusyBudget,
  formatBusyExhausted,
  isBusyBody,
  isBusyResponse,
  postFleetSheet,
  readBusyBudget,
} from './fleet-sheet-post.mjs';

const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

// GAS の tryLock(20000) と同じく、busy を返すまで 20 秒かかる前提で時計を進める。
function clock(start = Date.parse('2026-11-03T05:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('busy 判定は本文の error を見る（HTTP 200 でも busy は busy）', () => {
  assert.equal(isBusyBody({ ok: false, error: 'busy' }), true);
  assert.equal(isBusyBody({ ok: false, error: 'fleet sheet busy' }), true);
  assert.equal(isBusyBody({ ok: false, error: 'unauthorized' }), false);
  assert.equal(isBusyBody({ ok: true }), false);
  assert.equal(isBusyBody(null), false);
  assert.equal(isBusyResponse({ ok: true, status: 200 }, { ok: false, error: 'busy' }), true);
  assert.equal(isBusyResponse({ ok: false, status: 503 }, { ok: false, error: 'busy' }), true);
  // 403 は恒久的な拒否なので再送しない。
  assert.equal(isBusyResponse({ ok: false, status: 403 }, { ok: false, error: 'busy' }), false);
});

test('バックオフは指数で伸び、ジッタは ±25% に収まり、上限 60 秒で頭打ちになる', () => {
  assert.equal(backoffDelay(1, { random: () => 0.5 }), 5_000);
  assert.equal(backoffDelay(2, { random: () => 0.5 }), 10_000);
  assert.equal(backoffDelay(3, { random: () => 0.5 }), 20_000);
  assert.equal(backoffDelay(4, { random: () => 0.5 }), 40_000);
  assert.equal(backoffDelay(1, { random: () => 0 }), 3_750);
  assert.equal(backoffDelay(1, { random: () => 1 }), 6_250);
  // 上限はジッタ適用後にも掛かる（60 秒の 1.25 倍 = 75 秒にしない）。
  assert.equal(backoffDelay(10, { random: () => 0.5 }), 60_000);
  assert.equal(backoffDelay(10, { random: () => 1 }), 60_000);
});

test('busy→busy→ok は指数バックオフで再送し、3 回目で成功する', async () => {
  const c = clock();
  const waits = [];
  let calls = 0;
  const result = await postFleetSheet('https://example.invalid/sheet', { token: 't' }, {
    fetchImpl: async () => {
      calls += 1;
      c.advance(20_000);
      return calls < 3 ? response({ ok: false, error: 'busy' }) : response({ ok: true, updated: 1 });
    },
    sleepImpl: async (ms) => { waits.push(ms); c.advance(ms); },
    random: () => 0.5,
    now: c.now,
    budgetPath: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.body, { ok: true, updated: 1 });
  assert.deepEqual(waits, [5_000, 10_000]);
});

test('busy が続くと 5 試行で打ち切り busy_exhausted を返し、警告ログを残す', async () => {
  const c = clock();
  const waits = [];
  const logFile = path.join(tempDir('fleet-busy-'), 'report.log');
  let calls = 0;
  const result = await postFleetSheet('u', {}, {
    fetchImpl: async () => { calls += 1; c.advance(20_000); return response({ ok: false, error: 'busy' }); },
    sleepImpl: async (ms) => { waits.push(ms); c.advance(ms); },
    random: () => 0.5,
    now: c.now,
    budgetPath: null,
    logFile,
    kind: 'webhooks',
  });
  assert.equal(result.ok, false);
  assert.equal(result.busyExhausted, true);
  assert.equal(result.attempts, 5);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000]);
  // 20 秒 × 5 回 + 待ち 75 秒 = 175 秒。3 分の予算内に収まる。
  assert.ok(result.waitedMs <= BUSY_POLICY.totalBudgetMs, `waitedMs=${result.waitedMs}`);
  assert.match(fs.readFileSync(logFile, 'utf8'), /kind=webhooks attempts=5 result=busy_exhausted/);
  assert.match(formatBusyExhausted(result, 'webhooks'), /^busy_exhausted kind=webhooks attempts=5 waitedMs=\d+$/);
});

test('再送予算はファイルで共有され、使い切ると次のジョブは 1 回で諦める', async () => {
  const budgetPath = path.join(tempDir('fleet-budget-'), 'budget.json');
  const c = clock();
  const first = await postFleetSheet('u', {}, {
    fetchImpl: async () => { c.advance(20_000); return response({ ok: false, error: 'busy' }); },
    sleepImpl: async (ms) => c.advance(ms),
    random: () => 0.5,
    now: c.now,
    budgetPath,
  });
  assert.equal(first.busyExhausted, true);
  assert.ok(readBusyBudget(budgetPath, c.now()).spentMs >= 170_000);

  let calls = 0;
  const second = await postFleetSheet('u', {}, {
    fetchImpl: async () => { calls += 1; c.advance(20_000); return response({ ok: false, error: 'busy' }); },
    sleepImpl: async () => assert.fail('予算切れでは待たない'),
    random: () => 0.5,
    now: c.now,
    budgetPath,
  });
  assert.equal(second.busyExhausted, true);
  assert.equal(calls, 1);
});

test('予算ファイルは日付が変わると 0 に戻り、30 分放置でも作り直す', () => {
  const file = path.join(tempDir('fleet-budget-reset-'), 'b.json');
  const day1 = Date.parse('2026-11-03T05:00:00Z');
  chargeBusyBudget(file, day1, 120_000);
  assert.equal(readBusyBudget(file, day1 + 1_000).spentMs, 120_000);
  assert.equal(readBusyBudget(file, day1 + 24 * 60 * 60 * 1_000).spentMs, 0);
  assert.equal(readBusyBudget(file, day1 + BUSY_POLICY.budgetResetAfterMs + 1).spentMs, 0);
});

test('busy 以外の失敗は再送しない', async (t) => {
  for (const [name, makeResponse, pattern] of [
    ['恒久拒否', () => response({ ok: false, error: 'unauthorized' }), /rejected request: unauthorized/],
    ['HTTP 403 + busy', () => response({ ok: false, error: 'busy' }, 403), /HTTP 403/],
    ['不正 JSON', () => ({ ok: true, status: 200, text: async () => '<html>' }), /invalid JSON/],
    ['通信断', () => { throw new Error('network unavailable'); }, /network unavailable/],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(postFleetSheet('u', {}, {
        fetchImpl: async () => { calls += 1; return makeResponse(); },
        sleepImpl: async () => assert.fail('must not wait'),
        budgetPath: null,
      }), pattern);
      assert.equal(calls, 1);
    });
  }
});

test('HTTP 200 で本文が busy を示す応答も再送する（webhook-inventory の実例）', async () => {
  let calls = 0;
  const result = await postFleetSheet('u', {}, {
    fetchImpl: async () => response(++calls === 1 ? { ok: false, error: 'busy' } : { ok: true }),
    sleepImpl: async () => {},
    budgetPath: null,
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('拒否理由に含まれる秘密は伏せる', async () => {
  const url = `https://discord.com/api/webhooks/1508767136301191329/${'a'.repeat(40)}`;
  await assert.rejects(postFleetSheet('u', {}, {
    fetchImpl: async () => response({ ok: false, error: url }),
    budgetPath: null,
  }), (error) => !error.message.includes('a'.repeat(40)) && error.message.includes('[REDACTED]'));
});
