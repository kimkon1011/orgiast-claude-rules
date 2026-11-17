import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKpi, jstDay, alertKey, masterRows, isHumanExternal, deterministicClass } from '../tools/lib/eig-kpi-logic.mjs';
import { parseTickets } from '../tools/lib/eig-peatix.mjs';

const good = { positiveCompanies: 2, confirmedCompanies: 3, cafe212: 1, registrations: 30, submissions: 5, presenters: 10 };
test('JST rollover, first deadline inclusive, later targets retained', () => {
  assert.equal(jstDay('2026-11-19T15:00:00Z'), '2026-11-20');
  assert.equal(evaluateKpi('2026-11-19', {}).status, '期限前');
  assert.equal(evaluateKpi('2026-11-20', { positiveCompanies: 0 }).deficits[0].missing, 1);
  assert.equal(evaluateKpi('2026-11-21', { positiveCompanies: 1, registrations: 5 }).status, '順調');
  assert.deepEqual(evaluateKpi('2026-11-24', { ...good, registrations: 9 }).deficits.map(x => x.missing), [1]);
  assert.equal(evaluateKpi('2026-12-07', good).status, '順調');
});
test('all milestone boundaries and previous-day targets', () => {
  for (const [day, key, target] of [['2026-11-20','positiveCompanies',1],['2026-11-21','registrations',5],['2026-11-24','registrations',10],['2026-11-26','confirmedCompanies',3],['2026-11-27','registrations',15],['2026-12-01','registrations',20],['2026-12-04','registrations',25],['2026-12-07','registrations',30]]) {
    assert.equal(evaluateKpi(day, good).targets[key].target, target);
    const previous = new Date(new Date(day+'T00:00:00Z').getTime()-86400000).toISOString().slice(0,10);
    assert.ok((evaluateKpi(previous, good).targets[key]?.target || 0) < target);
  }
});
test('confirmed includes Cafe 212, submissions and presenters are independent gates', () => {
  assert.equal(evaluateKpi('2026-11-26', { ...good, cafe212: 0 }).deficits[0].key, 'cafe212');
  assert.equal(evaluateKpi('2026-12-04', { ...good, submissions: 4 }).deficits[0].key, 'submissions');
  assert.equal(evaluateKpi('2026-12-07', { ...good, presenters: 9 }).deficits[0].key, 'presenters');
});
test('unknown values never become zero or a healthy report', () => {
  for (const v of [undefined, null, NaN, -1, '30']) assert.equal(evaluateKpi('2026-12-07', { ...good, registrations: v }).status, '要確認');
  assert.equal(evaluateKpi('2026-11-17', {}, ['Peatix failure']).status, '要確認');
  assert.equal(evaluateKpi('2026-12-07', { ...good, registrations: 0, submissions: null }).status, '遅れ');
});
test('notification identity is one delay per JST date even as deficits change', () => {
  assert.equal(alertKey(jstDay('2026-11-20T00:00:00Z')), alertKey(jstDay('2026-11-20T08:30:00Z')));
  assert.notEqual(alertKey('2026-11-20'), alertKey('2026-11-21'));
  assert.notEqual(alertKey('2026-11-20'), alertKey('2026-11-20', 'source-error'));
});
test('count sent dates, not approval checkboxes; do not count explicit no reply', () => {
  const m = masterRows([['会社名','送る(kim印)','送信日','返信','状態'], ['A',true,'','','未打診'], ['B',false,'2026-11-17','未返信','返信待ち'], ['C',false,'2026-11-17','前向き','前向き']], 'company');
  assert.equal(m.sent, 2); assert.equal(m.replies, 1); assert.equal(m.total, 3);
  assert.throws(() => masterRows([['会社名']], 'company'));
  assert.equal(deterministicClass('未確定'), null);
  assert.equal(deterministicClass('辞退'), 'declined');
});
test('exclude notifications and internal senders from external replies', () => {
  for (const from of ['comments-noreply@docs.google.com','peatix@peatix.com','kim@orgiast.jp','noreply@example.com']) assert.equal(isHumanExternal({ from }), false);
  assert.equal(isHumanExternal({ from: 'Customer <owner@example.com>' }), true);
  assert.equal(isHumanExternal({ from: 'owner@example.com', autoSubmitted: 'auto-replied' }), false);
});
test('Peatix sales rows, not public prose; real zero and mismatched totals', () => {
  const rows = [['0 / 10','登壇参加','¥0','¥0'],['0 / 10','観覧参加','¥0','¥0'],['合計','¥0']];
  assert.equal(parseTickets(rows,'0 / 20 申し込み数').registrations, 0);
  assert.throws(() => parseTickets([], '課題の概要（第1弾）Cafe 212'));
  assert.throws(() => parseTickets(rows, '1 / 20 申し込み数'));
  assert.deepEqual(parseTickets([['3 / 10','登壇参加','¥0','¥0'],['5 / 20','観覧参加','¥0','¥0']], '8 / 30 申し込み数').presenters, 3);
});
