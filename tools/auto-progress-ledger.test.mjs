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

test('check なし行の追加は check 付き行を superseded にしない', () => {
  const first = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:00.000Z');
  const footer = { sessionId: 'session-1', status: 'open', promise: '次に進捗を報告する', ts: '2026-10-29T10:00:02.000Z' };
  const rows = applyPromise([first], footer);
  assert.deepEqual(rows.map(row => row.status), ['open', 'open']);
  assert.equal(rows[1].check, undefined);
  assert.deepEqual(latestOpenPromises(rows), rows);
});

test('check 付き行は同一セッションの古いフッター行を従来どおり置換する', () => {
  const footer = { sessionId: 'session-1', status: 'open', promise: '次に進捗を報告する', ts: '2026-10-29T10:00:00.000Z' };
  const row = checked('NVIDIAドライバー582.78更新', '2026-10-29T10:00:02.000Z');
  assert.deepEqual(applyPromise([footer], row).map(item => item.status), ['superseded', 'open']);
});
