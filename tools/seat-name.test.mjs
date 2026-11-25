import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSeat, selfSeat, seatContext } from './seat-name.mjs';
const map = { desk: { hostname: 'DELL', remoteName: '作業用014', sheetName: '制作PC', aliases: ['old'] }, sheet: { sheetName: '作業用015' }, key: {} };
for (const name of ['DELL', 'dell', 'desk', 'old', '制作PC']) test(`resolve ${name}`, () => {
  assert.deepEqual(resolveSeat(name, map), { hostname: name, seat: '作業用014', registered: true });
});
test('fallbacks and unknown', () => {
  assert.equal(resolveSeat('sheet', map).seat, '作業用015');
  assert.equal(resolveSeat('key', map).seat, 'key');
  assert.deepEqual(resolveSeat('unknown', map), { hostname: 'unknown', seat: '番号未登録の席（hostname: unknown）', registered: false });
});
test('self and SessionStart use injected hostname', () => {
  assert.equal(selfSeat(map, 'DELL').seat, '作業用014');
  assert.equal(seatContext(map, 'DELL'), 'この席は 作業用014（hostname: DELL）。人向けの文では 作業用014 と呼ぶ（§1.5.0.2）。');
});
