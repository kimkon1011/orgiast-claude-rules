import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKpi, aggregateMaster } from '../tools/eig-kpi-watch.mjs';

test('11/24 時点の未達数を判定する', () => {
  const result = evaluateKpi({ positive:1, registrations:7 }, '2026-11-24');
  assert.equal(result.status, '遅れ');
  assert.deepEqual(result.missing, ['企業の前向き返信 1件（必要2、現在1）', '申込 3件（必要10、現在7）']);
});

test('将来の目標は期日前に判定しない', () => {
  assert.equal(evaluateKpi({ positive:1, registrations:0 }, '2026-11-20').status, '順調');
});

test('マスタの見出しと状態から集計する', () => {
  const got = aggregateMaster([['会社','送信日','返信','状態'], ['A','11/17','あり','前向き検討'], ['B','11/17','', '参加確定']]);
  assert.deepEqual(got, { sent:2, replies:1, positive:2, confirmed:1, materials:0, speakers:0 });
});
