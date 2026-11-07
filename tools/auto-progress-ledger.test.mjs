import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPromise, latestOpenPromises } from './auto-progress-ledger.mjs';

const checked = (label, ts) => ({ sessionId: 'session-1', status: 'open', label, check: 'exit 0', ts });

test('同一セッションの異なる label の check は両方 open で評価対象になる', () => {
  const first = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:00.000Z');
  const second = checked('HDMIダミープラグ取り付け', '2026-10-29T10:00:02.000Z');
  const rows = applyPromise([first], second);
  assert.deepEqual(rows.map(row => row.status), ['open', 'open']);
  assert.deepEqual(latestOpenPromises(rows), rows);
});

test('同一セッションの同一 label の check は古い行を superseded にする', () => {
  const first = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:00.000Z');
  const second = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:02.000Z');
  const rows = applyPromise([first], second);
  assert.deepEqual(rows.map(row => row.status), ['superseded', 'open']);
  assert.deepEqual(latestOpenPromises(rows), [second]);
});

test('フッター行は最新 check を引き継いで置換し、別 label の check は open のまま残す', () => {
  const first = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:00.000Z');
  const second = checked('HDMIダミープラグ取り付け', '2026-10-29T10:00:01.000Z');
  const footer = { sessionId: 'session-1', status: 'open', promise: '次に進捗を報告する', ts: '2026-10-29T10:00:02.000Z' };
  const rows = applyPromise([first, second], footer);
  assert.deepEqual(rows.map(row => row.status), ['open', 'superseded', 'open']);
  assert.equal(rows[2].check, second.check);
  assert.equal(rows[2].label, second.label);
  assert.deepEqual(latestOpenPromises(rows), [first, rows[2]]);
});

test('check 付き行は同一セッションの古いフッター行を従来どおり置換する', () => {
  const footer = { sessionId: 'session-1', status: 'open', promise: '次に進捗を報告する', ts: '2026-10-29T10:00:00.000Z' };
  const row = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:02.000Z');
  assert.deepEqual(applyPromise([footer], row).map(item => item.status), ['superseded', 'open']);
});
