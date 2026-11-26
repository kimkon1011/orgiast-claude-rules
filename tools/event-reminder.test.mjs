import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { determineReminderType, generateReminderMessage, filterEventsForReminder, main } from './event-reminder.mjs';

// ---------------------------------------------------------------------------
// 機能1: determineReminderType — 全5種別の境界値
// ---------------------------------------------------------------------------

describe('determineReminderType', () => {
  it('past: daysUntil < 0', () => {
    assert.equal(determineReminderType(-1), 'past');
    assert.equal(determineReminderType(-100), 'past');
  });

  it('today: daysUntil === 0', () => {
    assert.equal(determineReminderType(0), 'today');
  });

  it('urgent: daysUntil 1〜3', () => {
    assert.equal(determineReminderType(1), 'urgent');
    assert.equal(determineReminderType(2), 'urgent');
    assert.equal(determineReminderType(3), 'urgent');
  });

  it('soon: daysUntil 4〜7', () => {
    assert.equal(determineReminderType(4), 'soon');
    assert.equal(determineReminderType(5), 'soon');
    assert.equal(determineReminderType(6), 'soon');
    assert.equal(determineReminderType(7), 'soon');
  });

  it('upcoming: daysUntil > 7', () => {
    assert.equal(determineReminderType(8), 'upcoming');
    assert.equal(determineReminderType(30), 'upcoming');
    assert.equal(determineReminderType(365), 'upcoming');
  });

  it('非数値でエラーを投げる', () => {
    assert.throws(() => determineReminderType('abc'), /daysUntil は有限の数値/);
    assert.throws(() => determineReminderType(null), /daysUntil は有限の数値/);
    assert.throws(() => determineReminderType(undefined), /daysUntil は有限の数値/);
    assert.throws(() => determineReminderType(NaN), /daysUntil は有限の数値/);
    assert.throws(() => determineReminderType(Infinity), /daysUntil は有限の数値/);
  });
});

// ---------------------------------------------------------------------------
// 機能2: generateReminderMessage — 全5種別のメッセージ内容
// ---------------------------------------------------------------------------

describe('generateReminderMessage', () => {
  const base = { eventName: '展示会A', eventDate: '2026-12-01', reminderType: 'upcoming' };

  it('urgent: 件名に【緊急】と残日数が含まれる', () => {
    const msg = generateReminderMessage({ ...base, reminderType: 'urgent' });
    assert.match(msg.subject, /【緊急】/);
    assert.match(msg.subject, /展示会A/);
    assert.match(msg.subject, /あと\d+日/);
    assert.match(msg.body, /準備項目をご確認/);
  });

  it('today: 件名に【本日】が含まれる', () => {
    const msg = generateReminderMessage({ ...base, reminderType: 'today' });
    assert.match(msg.subject, /【本日】/);
    assert.match(msg.subject, /展示会A/);
    assert.match(msg.subject, /開催日/);
    assert.match(msg.body, /当日の確認事項/);
  });

  it('soon: 件名に【間近】と残日数が含まれる', () => {
    const msg = generateReminderMessage({ ...base, reminderType: 'soon' });
    assert.match(msg.subject, /【間近】/);
    assert.match(msg.subject, /展示会A/);
    assert.match(msg.subject, /あと\d+日/);
    assert.match(msg.body, /準備状況をご確認/);
  });

  it('upcoming: 件名に【予定】が含まれる', () => {
    const msg = generateReminderMessage(base);
    assert.match(msg.subject, /【予定】/);
    assert.match(msg.subject, /展示会A/);
    assert.match(msg.subject, /ご案内/);
    assert.match(msg.body, /開催予定/);
  });

  it('past: 件名に【終了】が含まれる', () => {
    const msg = generateReminderMessage({ ...base, reminderType: 'past' });
    assert.match(msg.subject, /【終了】/);
    assert.match(msg.subject, /展示会A/);
    assert.match(msg.subject, /開催済み/);
    assert.match(msg.body, /振り返り/);
  });

  it('不足パラメータでエラーを投げる', () => {
    assert.throws(() => generateReminderMessage({}), /eventName, eventDate, reminderType は必須/);
    assert.throws(() => generateReminderMessage({ eventName: 'x' }), /eventName, eventDate, reminderType は必須/);
  });

  it('未知のreminderTypeでエラーを投げる', () => {
    assert.throws(
      () => generateReminderMessage({ eventName: 'x', eventDate: '2026-12-01', reminderType: 'invalid' }),
      /未知の reminderType/,
    );
  });
});

// ---------------------------------------------------------------------------
// 機能3: filterEventsForReminder
// ---------------------------------------------------------------------------

describe('filterEventsForReminder', () => {
  it('空配列を返す', () => {
    const result = filterEventsForReminder([]);
    assert.deepEqual(result, []);
  });

  it('複数イベントを処理する', () => {
    const events = [
      { name: '展示会A', date: '2099-01-01' },
      { name: '展示会B', date: '2099-01-10' },
      { name: '展示会C', date: '2099-01-20' },
    ];
    const results = filterEventsForReminder(events, new Date('2098-12-30'));
    assert.equal(results.length, 3);
    // 2099-01-01 は基準日から2日後 → urgent
    assert.equal(results[0].reminderType, 'urgent');
    assert.equal(results[0].daysUntil, 2);
    // 2099-01-10 は11日後 → upcoming
    assert.equal(results[1].reminderType, 'upcoming');
    assert.equal(results[1].daysUntil, 11);
  });

  it('過去イベントを含むケース', () => {
    const events = [
      { name: '過去のイベント', date: '2020-01-01' },
      { name: '未来のイベント', date: '2099-01-01' },
    ];
    const results = filterEventsForReminder(events, new Date('2025-01-01'));
    assert.equal(results.length, 2);
    assert.equal(results[0].reminderType, 'past');
    assert.equal(results[0].daysUntil, -1827); // 2020-01-01 から 2025-01-01
    assert.notEqual(results[1].reminderType, 'past');
  });

  it('各結果に event / reminderType / daysUntil / message がある', () => {
    const events = [{ name: 'テスト', date: '2099-06-15' }];
    const results = filterEventsForReminder(events, new Date('2099-06-10'));
    assert.equal(results.length, 1);
    const r = results[0];
    assert.ok(r.event);
    assert.equal(r.event.name, 'テスト');
    assert.equal(typeof r.reminderType, 'string');
    assert.equal(typeof r.daysUntil, 'number');
    assert.ok(r.message);
    assert.equal(typeof r.message.subject, 'string');
    assert.equal(typeof r.message.body, 'string');
  });

  it('配列以外でエラーを投げる', () => {
    assert.throws(() => filterEventsForReminder(null), /events は配列/);
    assert.throws(() => filterEventsForReminder('abc'), /events は配列/);
  });

  it('不完全なイベントオブジェクトでエラーを投げる', () => {
    assert.throws(() => filterEventsForReminder([{ name: 'x' }], new Date('2025-01-01')), /name と date が必要/);
    assert.throws(() => filterEventsForReminder([{ date: '2025-01-01' }], new Date('2025-01-01')), /name と date が必要/);
  });
});

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

describe('main (CLI)', () => {
  it('--help がヘルプを表示する', () => {
    const output = main(['node', 'event-reminder.mjs', '--help']);
    assert.match(output, /使い方/);
    assert.match(output, /--check/);
    assert.match(output, /--filter/);
  });

  it('引数なしで --help 相当を表示する', () => {
    const output = main(['node', 'event-reminder.mjs']);
    assert.match(output, /使い方/);
  });

  it('--check で判定結果を表示する', () => {
    const output = main(['node', 'event-reminder.mjs', '--check', '2099-01-01', '--name', '新年会']);
    assert.match(output, /新年会/);
    assert.match(output, /2099-01-01/);
    assert.match(output, /件名/);
  });

  it('--filter でJSON処理結果を表示する', () => {
    const input = JSON.stringify([{ name: '展示会', date: '2099-01-01' }]);
    const output = main(['node', 'event-reminder.mjs', '--filter', input]);
    const parsed = JSON.parse(output);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].event.name, '展示会');
  });

  it('不正なJSONでエラーメッセージを表示する', () => {
    const output = main(['node', 'event-reminder.mjs', '--filter', 'not-json']);
    assert.match(output, /エラー/);
  });
});