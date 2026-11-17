import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWeekdays } from './weekday-validator.mjs';

describe('validateWeekdays', () => {
  it('正しい曜日の場合は valid: true を返す', () => {
    const result = validateWeekdays('2026年11月14日（土）14:00〜17:00');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.mismatches.length, 0);
  });

  it('誤った曜日の場合は mismatches に情報を返す', () => {
    const result = validateWeekdays('2026年11月14日（月）14:00〜17:00');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.mismatches.length, 1);
    assert.strictEqual(result.mismatches[0].matched, '2026年11月14日（月）');
    assert.strictEqual(result.mismatches[0].expected, '土');
    assert.strictEqual(result.mismatches[0].actual, '月');
  });

  it('日付表記がない場合は valid: true, mismatches: [] を返す', () => {
    const result = validateWeekdays('本文なし');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.mismatches.length, 0);
  });

  it('複数の日付がある場合、すべて検証する', () => {
    const text = '2026年11月14日（土）と2026年11月15日（月）の予定';
    const result = validateWeekdays(text);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.mismatches.length, 1);
    assert.strictEqual(result.mismatches[0].matched, '2026年11月15日（月）');
    assert.strictEqual(result.mismatches[0].expected, '日');
    assert.strictEqual(result.mismatches[0].actual, '月');
  });

  it('すべて正しい曜日の場合、valid: true を返す', () => {
    const text = '2026年11月14日（土）と2026年11月15日（日）の予定';
    const result = validateWeekdays(text);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.mismatches.length, 0);
  });

  it('境界値の日付（うるう年など）も正しく処理する', () => {
    const text = '2024年2月29日（木）';  // 2024年はうるう年、2月29日は木曜日
    const result = validateWeekdays(text);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.mismatches.length, 0);
  });

  it('誤った曜日の場合は index を正しく返す', () => {
    const text = 'イベントは2026年11月14日（月）に開催';
    const result = validateWeekdays(text);
    assert.strictEqual(result.mismatches.length, 1);
    assert.strictEqual(result.mismatches[0].index, 5);  // '2026年11月14日（月）' の開始位置
  });
});