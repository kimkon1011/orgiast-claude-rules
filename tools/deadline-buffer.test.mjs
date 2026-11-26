import test from 'node:test'; import assert from 'node:assert/strict';
import { startPlan, evaluate, notificationLine, formatDigest } from './deadline-watch.mjs';
const config = { kimNames: ['kim', '金', ''], sheetId: 'x' };
test('着手期限は所要日数に20%以上のバッファを足して期限日から逆算する', () => {
  const p = startPlan({ title: 'ラハイナ 登記簿謄本の取得', kind: '提出', due: '2026-12-20' }, config);
  assert.equal(p.leadDays, 14); assert.equal(p.totalDays, 17); assert.equal(p.startBy, '2026-12-03');
  assert.match(p.method, /オンライン請求/);
  assert.ok(p.totalDays >= Math.ceil(p.leadDays * 1.2));
  const small = startPlan({ title: '返信', kind: '回答・返信', due: '2026-12-20' }, config);
  assert.ok(small.totalDays > small.leadDays, '短い作業でも最低1日のバッファ');
  assert.equal(startPlan({ title: 'x', kind: 'その他', due: '2026-12-20', notes: '所要日数: 10' }, config).totalDays, 12);
});
test('期限日ではなく着手期限で知らせ、超過は毎日・金さん宛て', () => {
  const row = { id: 'D-1', title: '登記簿謄本の取得', kind: '提出', due: '2026-12-20', status: '未着手', assignee: '経理' };
  const before = evaluate(row, '2026-11-30', config); assert.equal(before.stage, true); assert.equal(before.startDays, 3);
  const quiet = evaluate(row, '2026-11-25', config); assert.equal(quiet.stage, false);
  const late = evaluate(row, '2026-12-05', config); assert.equal(late.stage, true); assert.equal(late.startOverdue, true); assert.equal(late.kim, true);
  assert.match(notificationLine(row, late, config), /着手期限超過 12\/03/);
  assert.match(formatDigest([row], '2026-11-27', config), /着手期限 2026-12-03/);
  const doing = evaluate({ ...row, status: '対応中' }, '2026-12-05', config); assert.equal(doing.startOverdue, false);
});
