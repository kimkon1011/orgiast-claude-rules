import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateGateSkips, evaluateTop3Delivery } from './cron-liveness-check.mjs';

const now = Date.parse('2026-08-21T00:00:00.000Z');
const entry = { label: '日次', repo: 'owner/repo', workflow: 'daily.yml', everyDays: 1 };
const key = 'owner/repo#daily.yml';

function result(value) {
  return evaluate([entry], { [key]: value }, now)[0];
}

test('直近のschedule成功はok', () => {
  const actual = result('2026-08-20T00:00:00.000Z');
  assert.equal(actual.status, 'ok');
  assert.match(actual.line, /^✅/);
});

test('許容期間を超えたschedule成功はstale', () => {
  const actual = result('2026-08-19T00:00:00.000Z');
  assert.equal(actual.status, 'stale');
  assert.match(actual.line, /^🚨/);
});

test('schedule成功履歴なしはnever', () => {
  const actual = result(null);
  assert.equal(actual.status, 'never');
  assert.equal(actual.lastSuccess, null);
});

test('取得失敗はunknown', () => {
  const actual = evaluate([entry], {}, now)[0];
  assert.equal(actual.status, 'unknown');
  assert.match(actual.line, /^⚠️/);
});

test('境界値はok、境界を超えるとstale', () => {
  assert.equal(result('2026-08-19T12:00:00.000Z').status, 'ok');
  assert.equal(result('2026-08-19T11:59:59.999Z').status, 'stale');
});

test('直近7日のgateスキップ3件で警報', () => {
  const records = [1, 2, 3].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  assert.match(evaluateGateSkips(records, now).line, /🚨 gate判定スキップ（要調査）3件/);
});

test('unreadableだけなら10件でもgateスキップ警報を出さない', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString(), reasonCode: 'unreadable' }));
  assert.equal(evaluateGateSkips(records, now), null);
});

test('reasonCodeなしの旧記録はgateスキップ警報に数えない', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString() }));
  assert.equal(evaluateGateSkips(records, now), null);
});

test('unreadable 8件と要調査3件なら要調査分だけ警報に数える', () => {
  const unreadable = Array.from({ length: 8 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString(), reasonCode: 'unreadable' }));
  const investigable = [1, 2, 3].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  assert.match(evaluateGateSkips([...unreadable, ...investigable], now).line, /（要調査）3件/);
});

test('unreadable 8件と要調査2件ならgateスキップ警報を出さない', () => {
  const unreadable = Array.from({ length: 8 }, (_, index) => ({ ts: new Date(now - index * 36e5).toISOString(), reasonCode: 'unreadable' }));
  const investigable = [1, 2].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  assert.equal(evaluateGateSkips([...unreadable, ...investigable], now), null);
});

test('7日より古いgateスキップは要調査件数に数えない', () => {
  const records = [1, 2].map((days) => ({ ts: new Date(now - days * 864e5).toISOString(), reasonCode: 'no-path' }));
  records.push({ ts: new Date(now - 8 * 864e5).toISOString(), reasonCode: 'no-path' });
  assert.equal(evaluateGateSkips(records, now), null);
});

// 日次TOP3 は workflow の成否ではなくローカル着地(asOf)で測る。
// 取りこぼしは top3-catchup が artifact から回収するため、run が赤くても届いていることがある。
const top3Now = Date.parse('2026-09-02T07:00:00.000Z'); // = 2026-09-02 16:00 JST

test('日次TOP3: 当日ぶんが届いていればok', () => {
  const actual = evaluateTop3Delivery('2026-09-02', top3Now);
  assert.equal(actual.status, 'ok');
  assert.match(actual.line, /^✅/);
});

test('日次TOP3: 前日ぶんで止まっていてもまだok（当日の生成前に鳴らさない）', () => {
  assert.equal(evaluateTop3Delivery('2026-09-01', top3Now).status, 'ok');
});

test('日次TOP3: 2日以上遅れたらstale', () => {
  const actual = evaluateTop3Delivery('2026-08-31', top3Now);
  assert.equal(actual.status, 'stale');
  assert.match(actual.line, /^🚨/);
});

test('日次TOP3: 一度も届いていなければnever', () => {
  assert.equal(evaluateTop3Delivery(null, top3Now).status, 'never');
});

test('日次TOP3: asOfが日付として読めなければunknown', () => {
  const actual = evaluateTop3Delivery('not-a-date', top3Now);
  assert.equal(actual.status, 'unknown');
  assert.match(actual.line, /^⚠️/);
});
