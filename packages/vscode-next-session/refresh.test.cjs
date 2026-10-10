const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideRefresh, REFRESH_MIN_AGE_MS } = require('./mobile-pool');
const { parseRefreshHours, inRefreshHours, readRefreshConfig, readLastRefreshAt } = require('./mobile-state.cjs');
const { decideAction } = require('./route');

const MIN = 60000;
const NOW = 1_000_000_000_000;
const tab = (ageMin, extra = {}) => ({ label: 'Claude Code', appearedAt: NOW - ageMin * MIN, isActive: false, ...extra });
const base = { now: NOW, minutes: 60, hoursOk: true, lastRefreshAt: null, target: 1 };

test('時間帯: 06-24 は終了排他、22-06 は日跨ぎ、不正値は null', () => {
  assert.deepEqual(parseRefreshHours('06-24'), { start: 6, end: 24 });
  assert.equal(parseRefreshHours('6-25'), null);
  assert.equal(parseRefreshHours('abc'), null);
  assert.equal(inRefreshHours(new Date(2026, 0, 1, 5, 59), '06-24'), false);
  assert.equal(inRefreshHours(new Date(2026, 0, 1, 6, 0), '06-24'), true);
  assert.equal(inRefreshHours(new Date(2026, 0, 1, 23, 59), '06-24'), true);
  assert.equal(inRefreshHours(new Date(2026, 0, 1, 23, 0), '08-23'), false);
  assert.equal(inRefreshHours(new Date(2026, 0, 1, 23, 0), '22-06'), true);
  assert.equal(inRefreshHours(new Date(2026, 0, 1, 12, 0), '22-06'), false);
});

test('設定の決定順: env -> json -> VS Code 設定 -> 既定', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-cfg-'));
  assert.deepEqual(readRefreshConfig(home, {}, {}), { minutes: 60, hours: '06-24' });
  assert.deepEqual(readRefreshConfig(home, {}, { minutes: 30, hours: '08-20' }), { minutes: 30, hours: '08-20' });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), JSON.stringify({ refreshMinutes: 15, refreshHours: '09-18' }));
  assert.deepEqual(readRefreshConfig(home, {}, { minutes: 30, hours: '08-20' }), { minutes: 15, hours: '09-18' });
  assert.deepEqual(readRefreshConfig(home, { CLAUDE_MOBILE_REFRESH_MINUTES: '0', CLAUDE_MOBILE_REFRESH_HOURS: '00-24' }, {}), { minutes: 0, hours: '00-24' });
  assert.deepEqual(readRefreshConfig(home, { CLAUDE_MOBILE_REFRESH_HOURS: 'bad' }, {}), { minutes: 15, hours: '06-24' });
  assert.throws(() => readRefreshConfig(home, { CLAUDE_MOBILE_REFRESH_MINUTES: '-1' }, {}));
});

test('lastRefreshAt は状態ファイルから読み、無ければ null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-last-'));
  assert.equal(readLastRefreshAt(home), null);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), JSON.stringify({ waiting: 1, lastRefreshAt: 123 }));
  assert.equal(readLastRefreshAt(home), 123);
});

test('条件が揃えば最古の待機タブを選ぶ', () => {
  const tabs = [tab(30, { id: 'b' }), tab(200, { id: 'a' }), tab(90, { id: 'c' }), { label: '作業中', appearedAt: NOW - 999 * MIN, isActive: false }];
  const result = decideRefresh({ ...base, target: 1, tabs });
  assert.equal(result.refresh, true);
  assert.equal(result.tab.id, 'a');
  assert.equal(result.ageMinutes, 200);
  assert.equal(result.waiting, 3);
});

test('無効(0)・時間帯外・間隔未満は no。force は無視する', () => {
  const tabs = [tab(100)];
  assert.equal(decideRefresh({ ...base, minutes: 0, tabs }).reason, 'disabled');
  assert.equal(decideRefresh({ ...base, hoursOk: false, tabs }).reason, 'outside-hours');
  assert.equal(decideRefresh({ ...base, lastRefreshAt: NOW - 59 * MIN, tabs }).reason, 'interval');
  assert.equal(decideRefresh({ ...base, lastRefreshAt: NOW - 60 * MIN, tabs }).refresh, true);
  assert.equal(decideRefresh({ ...base, minutes: 0, hoursOk: false, lastRefreshAt: NOW, tabs, force: true }).refresh, true);
});

test('待機が target 未満（不足中）はリフレッシュしない。force でも同様', () => {
  const tabs = [tab(100)];
  assert.equal(decideRefresh({ ...base, target: 2, tabs }).reason, 'shortage');
  assert.equal(decideRefresh({ ...base, target: 2, tabs, force: true }).reason, 'shortage');
  assert.equal(decideRefresh({ ...base, tabs: [] }).reason, 'shortage');
});

test('出現から 10 分未満は対象外、ちょうど 10 分は対象', () => {
  assert.equal(REFRESH_MIN_AGE_MS, 10 * MIN);
  assert.equal(decideRefresh({ ...base, tabs: [tab(9.9)] }).reason, 'no-candidate');
  assert.equal(decideRefresh({ ...base, tabs: [tab(10)] }).refresh, true);
  assert.equal(decideRefresh({ ...base, tabs: [tab(5, { id: 'new' }), tab(20, { id: 'old' })] }).tab.id, 'old');
});

test('isActive のタブは対象外（最古でも次点を選ぶ）', () => {
  const tabs = [tab(300, { id: 'active', isActive: true }), tab(120, { id: 'second' })];
  assert.equal(decideRefresh({ ...base, tabs }).tab.id, 'second');
  assert.equal(decideRefresh({ ...base, tabs: [tab(300, { isActive: true })] }).reason, 'no-candidate');
});

test('/mobile?refresh=1 は refresh フラグ付き、無指定は従来どおり', () => {
  assert.deepEqual(decideAction({ path: '/mobile', query: 'count=2&refresh=1' }), { kind: 'mobile', count: 2, name: 'スマホ用セッション', refresh: true });
  assert.deepEqual(decideAction({ path: '/mobile', query: 'count=2&refresh=0' }), { kind: 'mobile', count: 2, name: 'スマホ用セッション' });
});
