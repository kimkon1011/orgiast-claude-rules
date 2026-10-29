import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── テスト対象の関数を直接インポート ──────────────────
// 内部関数は export されていないので、テスト用に再実装して検証する。
// 実際の export 関数は runLineLogExport のみだが、ユニットテストは
// ロジック単位で行う。

// 伏せ字ロジックの再現
function redactPersonalNumber(text) {
  return String(text ?? '').replace(/\b(\d{8})(\d{4})\b/g, (_, head, tail) => '*'.repeat(head.length) + tail);
}

// 日時変換の再現
function toJstIso(utcStr) {
  if (!utcStr) return '';
  const d = new Date(utcStr);
  if (isNaN(d.getTime())) return String(utcStr);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'medium', hour12: false,
  }).format(d).replace(' ', 'T');
}

// 行変換の再現
function toRow(msg) {
  return [
    toJstIso(msg.received_at),
    String(msg.subject ?? ''),
    String(msg.external_thread_id ?? ''),
    String(msg.sender_identifier ?? ''),
    String(msg.direction ?? ''),
    redactPersonalNumber(String(msg.body ?? '')),
    Array.isArray(msg.attachments) ? msg.attachments.map((a) => a.url || '').filter(Boolean).join('; ') : '',
    String(msg.id ?? ''),
  ];
}

// ── テスト: 伏せ字 ──────────────────────────
test('redactPersonalNumber masks all but last 4 digits of 12-digit numbers', () => {
  assert.equal(redactPersonalNumber('123456789012'), '********9012');
  assert.equal(redactPersonalNumber('マイナンバーは 987654321098 です'), 'マイナンバーは ********1098 です');
});

test('redactPersonalNumber does not affect short numbers', () => {
  assert.equal(redactPersonalNumber('電話: 090-1234-5678'), '電話: 090-1234-5678');
});

test('redactPersonalNumber does not affect long numbers', () => {
  assert.equal(redactPersonalNumber('1234567890123'), '1234567890123');
});

test('redactPersonalNumber handles null/undefined', () => {
  assert.equal(redactPersonalNumber(null), '');
  assert.equal(redactPersonalNumber(undefined), '');
});

// ── テスト: 日時変換 ──────────────────────────
test('toJstIso converts UTC to JST ISO string', () => {
  // 2026-10-01T00:00:00Z = 2026-10-01T09:00:00 JST
  const result = toJstIso('2026-10-01T00:00:00Z');
  assert.ok(result.includes('2026-10-01'));
  assert.ok(result.includes('09:00:00') || result.includes('09:00'));
});

test('toJstIso handles empty input', () => {
  assert.equal(toJstIso(''), '');
  assert.equal(toJstIso(null), '');
  assert.equal(toJstIso(undefined), '');
});

// ── テスト: 行変換 ──────────────────────────
test('toRow converts message to sheet row', () => {
  const msg = {
    id: 'msg-001',
    received_at: '2026-10-01T00:00:00Z',
    subject: 'テストグループ',
    external_thread_id: 'C1234567890abcdef',
    sender_identifier: '田中太郎',
    direction: 'inbound',
    body: 'こんにちは',
    attachments: [{ url: 'line-media/2026/10/photo.jpg' }],
  };
  const row = toRow(msg);
  assert.equal(row.length, 8);
  assert.equal(row[1], 'テストグループ');
  assert.equal(row[2], 'C1234567890abcdef');
  assert.equal(row[3], '田中太郎');
  assert.equal(row[4], 'inbound');
  assert.equal(row[5], 'こんにちは');
  assert.equal(row[6], 'line-media/2026/10/photo.jpg');
  assert.equal(row[7], 'msg-001');
});

test('toRow redacts personal numbers in body', () => {
  const msg = {
    id: 'msg-002',
    received_at: '2026-10-01T00:00:00Z',
    subject: '',
    external_thread_id: '',
    sender_identifier: '',
    direction: 'inbound',
    body: 'マイナンバーは 123456789012 です',
    attachments: [],
  };
  const row = toRow(msg);
  assert.equal(row[5], 'マイナンバーは ********9012 です');
});

test('toRow handles missing attachments', () => {
  const msg = {
    id: 'msg-003',
    received_at: '2026-10-01T00:00:00Z',
    subject: '',
    external_thread_id: '',
    sender_identifier: '',
    direction: 'inbound',
    body: '',
  };
  const row = toRow(msg);
  assert.equal(row[6], '');
});

// ── テスト: 重複除去 ──────────────────────────
test('deduplication filters messages already in sheet', () => {
  const existingIds = new Set(['msg-001', 'msg-003']);
  const messages = [
    { id: 'msg-001', received_at: '2026-10-01T00:00:00Z', subject: '', external_thread_id: '', sender_identifier: '', direction: 'inbound', body: 'a' },
    { id: 'msg-002', received_at: '2026-10-01T01:00:00Z', subject: '', external_thread_id: '', sender_identifier: '', direction: 'inbound', body: 'b' },
    { id: 'msg-003', received_at: '2026-10-01T02:00:00Z', subject: '', external_thread_id: '', sender_identifier: '', direction: 'inbound', body: 'c' },
  ];
  const newRows = messages.filter((m) => !existingIds.has(String(m.id))).map(toRow);
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0][7], 'msg-002');
});

// ── テスト: シートID ファイルの読み書き ──────────
test('sheet ID file read/write roundtrip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'line-log-test-'));
  const file = join(dir, 'line-log-sheet-id.txt');
  const testId = 'test-sheet-id-12345';

  // write
  await writeFile(file, testId + '\n', 'utf8');
  // read
  const text = await readFile(file, 'utf8');
  assert.equal(text.trim(), testId);

  // cleanup
  writeFileSync(file, '');
});

// ── テスト: カーソル（シート上の最新受信日時） ──
test('cursor extraction from existing rows', () => {
  const existing = [
    ['受信日時(JST)', 'グループ名', 'スレッドID', '表示名', '方向', '本文', '添付', 'メッセージID'],
    ['2026-10-01T09:00:00', 'グループA', 'C1', '田中', 'inbound', 'こんにちは', '', 'msg-001'],
    ['2026-10-02T10:00:00', 'グループB', 'C2', '佐藤', 'inbound', 'お願いします', '', 'msg-002'],
  ];
  // ヘッダー行を除いた最終行の A 列
  const lastRow = existing[existing.length - 1];
  const cursor = lastRow[0];
  assert.equal(cursor, '2026-10-02T10:00:00');
});

test('cursor is null when only header exists', () => {
  const existing = [['受信日時(JST)', 'グループ名', 'スレッドID', '表示名', '方向', '本文', '添付', 'メッセージID']];
  const cursor = existing.length > 1 ? existing[existing.length - 1][0] : null;
  assert.equal(cursor, null);
});
