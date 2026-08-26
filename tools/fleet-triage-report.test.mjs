import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from './fleet-triage-report.mjs';

const now = new Date('2026-08-26T03:00:00.000Z'); // 2026-08-26 12:00 JST

test('報告日時を fresh / stale / silent に分類する', () => {
  const rows = [
    { pcName: 'fresh-pc', label: 'FRESH', reportedAt: '2026-08-26 11:00' },
    { pcName: 'stale-pc', label: 'STALE', reportedAt: '2026-08-25 00:00' },
    { pcName: 'old-pc', label: 'OLD', reportedAt: '2026-08-22 12:00' },
    { pcName: 'empty-pc', label: 'EMPTY', reportedAt: '' },
  ];
  const digest = buildDigest(rows, now);
  assert.deepEqual(digest.fresh, [rows[0]]);
  assert.deepEqual(digest.stale, [rows[1]]);
  assert.deepEqual(digest.silent, [rows[2], rows[3]]);
});

test('本文に分類件数とPC名を含め、0台の分類は出さない', () => {
  const digest = buildDigest([{ pcName: '作業用011', label: 'DESKTOP-PPD5V8I', reportedAt: '2026-08-26' }], now);
  assert.match(digest.text, /✅ 24h以内に報告: 1台/);
  assert.match(digest.text, /作業用011\(DESKTOP-PPD5V8I\)/);
  assert.doesNotMatch(digest.text, /⚠️ 24〜72h/);
  assert.doesNotMatch(digest.text, /🚨 72h超\/未報告/);
});

test('pcName が空なら label で表示する', () => {
  const digest = buildDigest([{ pcName: '', label: 'LABEL-ONLY', reportedAt: '' }], now);
  assert.match(digest.text, /LABEL-ONLY/);
});

test('壊れた reportedAt は throw せず silent に分類する', () => {
  const row = { pcName: 'broken', label: '', reportedAt: '-' };
  assert.deepEqual(buildDigest([row], now).silent, [row]);
});
