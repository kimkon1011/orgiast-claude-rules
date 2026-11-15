import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHousekeepingOnly, completionActions } from './auto-progress-artifact.mjs';

test('isHousekeepingOnly: タブを ✕ で閉じる → true', () => {
  assert.equal(isHousekeepingOnly('このタブを ✕ で閉じる'), true);
});

test('isHousekeepingOnly: 新しいタブで Enter を1回押す → true', () => {
  assert.equal(isHousekeepingOnly('新しいタブで Enter を1回押す'), true);
});

test('isHousekeepingOnly: セッションを閉じる → true', () => {
  assert.equal(isHousekeepingOnly('セッションを閉じる'), true);
});

test('isHousekeepingOnly: 不要。draft は… → true', () => {
  assert.equal(isHousekeepingOnly('不要。draft は自分で保管'), true);
});

test('isHousekeepingOnly: 不要、確認済み → true', () => {
  assert.equal(isHousekeepingOnly('不要、確認済み'), true);
});

test('isHousekeepingOnly: 不要 → true', () => {
  assert.equal(isHousekeepingOnly('不要'), true);
});

test('isHousekeepingOnly: なし → true', () => {
  assert.equal(isHousekeepingOnly('なし'), true);
});

test('isHousekeepingOnly: 特になし → true', () => {
  assert.equal(isHousekeepingOnly('特になし'), true);
});

test('isHousekeepingOnly: Gmail 下書きを確認して送信可否を返答 → false', () => {
  assert.equal(isHousekeepingOnly('Gmail 下書きを確認して送信可否を返答'), false);
});

test('isHousekeepingOnly: 承認してください → false', () => {
  assert.equal(isHousekeepingOnly('承認してください'), false);
});

test('isHousekeepingOnly: null/空 → false', () => {
  assert.equal(isHousekeepingOnly(null), false);
  assert.equal(isHousekeepingOnly(''), false);
  assert.equal(isHousekeepingOnly('   '), false);
});

test('completionActions: nextKim が housekeeping なら kind=info', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  fs.mkdirSync(path.join(h, '.claude/logs'), { recursive: true });
  const row = { sessionId: 'test', nextKim: 'このタブを ✕ で閉じる' };
  assert.equal(completionActions(row, { home: h }).kind, 'info');
  fs.rmSync(h, { recursive: true, force: true });
});

test('completionActions: nextKim が ask なら kind=ask', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  fs.mkdirSync(path.join(h, '.claude/logs'), { recursive: true });
  const row = { sessionId: 'test', nextKim: 'Gmail 下書きを確認して送信可否を返答' };
  assert.equal(completionActions(row, { home: h }).kind, 'ask');
  fs.rmSync(h, { recursive: true, force: true });
});