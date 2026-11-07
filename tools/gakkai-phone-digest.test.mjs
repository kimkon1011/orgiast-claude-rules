// gakkai-phone-digest のテスト（判定・整形は lib の純関数を直接検証）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_PHONES,
  parsePhoneMessage,
  formatJST,
  classifyPhone,
  isMondayJST,
  buildDigest,
} from './gakkai-phone-digest-lib.mjs';

// 2026-11-07 09:07 JST（土曜日）を基準に
const NOW = new Date('2026-11-07T09:07:00+09:00');
const H = 60 * 60 * 1000;
const D = 24 * H;

function signal(deltaMs, overrides = {}) {
  return { phone: 'S003', lat: 35.12, lng: 135.12, accuracy: 10, battery: 85, timestamp: new Date(NOW.getTime() - deltaMs), ...overrides };
}

describe('parsePhoneMessage', () => {
  it('parses valid message', () => {
    const result = parsePhoneMessage('PHONE S003 | 35.123456,135.123456 | 12m | 85% | 2026-11-07T10:00:00.000Z');
    assert(result);
    assert.equal(result.phone, 'S003');
    assert.equal(result.lat, 35.123456);
    assert.equal(result.lng, 135.123456);
    assert.equal(result.accuracy, 12);
    assert.equal(result.battery, 85);
    assert.equal(result.timestamp.toISOString(), '2026-11-07T10:00:00.000Z');
  });

  it('parses message without m suffix on accuracy', () => {
    const result = parsePhoneMessage('PHONE S005 | 34.5,133.2 | 10 | 50% | 2026-11-01T00:00:00.000Z');
    assert(result);
    assert.equal(result.phone, 'S005');
    assert.equal(result.accuracy, 10);
    assert.equal(result.battery, 50);
  });

  it('parses message with S008', () => {
    const result = parsePhoneMessage('PHONE S008 | 34.9876,135.4321 | 8m | 92% | 2026-11-05T15:30:00.000Z');
    assert(result);
    assert.equal(result.phone, 'S008');
    assert.equal(result.lat, 34.9876);
    assert.equal(result.timestamp.getTime(), new Date('2026-11-05T15:30:00.000Z').getTime());
  });

  it('rejects non-PHONE messages', () => {
    assert.equal(parsePhoneMessage('Hello world'), null);
  });

  it('rejects empty content', () => {
    assert.equal(parsePhoneMessage(''), null);
  });

  it('rejects malformed PHONE message', () => {
    assert.equal(parsePhoneMessage('PHONE S003 missing pipes'), null);
  });

  it('rejects PHONE with wrong prefix', () => {
    assert.equal(parsePhoneMessage('PHONE X999 | 1,2 | 3m | 4% | 2026-01-01T00:00:00Z'), null);
  });

  it('rejects missing fields', () => {
    assert.equal(parsePhoneMessage('PHONE S002 | 1,2 | 3m'), null);
  });
});

describe('classifyPhone', () => {
  it('信号なし → 保管中', () => {
    assert.equal(classifyPhone(NOW, null), 'storage');
  });

  it('2時間前の信号 → 稼働中', () => {
    assert.equal(classifyPhone(NOW, signal(2 * H)), 'operating');
  });

  it('ちょうど24時間前でも稼働中', () => {
    assert.equal(classifyPhone(NOW, signal(24 * H)), 'operating');
  });

  it('36時間前（24時間超〜2日未満）→ 警告なしの recent', () => {
    assert.equal(classifyPhone(NOW, signal(36 * H)), 'recent');
  });

  it('3日前 → 要確認', () => {
    assert.equal(classifyPhone(NOW, signal(3 * D)), 'needs-confirmation');
  });

  it('14日前ちょうど → 要確認（境界）', () => {
    assert.equal(classifyPhone(NOW, signal(14 * D)), 'needs-confirmation');
  });

  it('15日前 → 一覧のみ（警告なし）', () => {
    assert.equal(classifyPhone(NOW, signal(15 * D)), 'gap14to30');
  });

  it('30日前ちょうど → 一覧のみ（境界）', () => {
    assert.equal(classifyPhone(NOW, signal(30 * D)), 'gap14to30');
  });

  it('31日前 → 保管中', () => {
    assert.equal(classifyPhone(NOW, signal(31 * D)), 'storage');
  });
});

describe('formatJST', () => {
  it('JST 入力はそのまま', () => {
    assert.equal(formatJST(new Date('2026-11-07T09:07:00+09:00')), '2026-11-07 09:07');
  });

  it('UTC を JST に変換', () => {
    assert.equal(formatJST(new Date('2026-11-06T16:00:00Z')), '2026-11-07 01:00');
  });

  it('日付が変わる境界（JST 深夜0時）', () => {
    assert.equal(formatJST(new Date('2026-11-07T15:30:00Z')), '2026-11-08 00:30');
  });

  it('ゼロ埋め', () => {
    assert.equal(formatJST(new Date('2026-01-05T01:02:00+09:00')), '2026-01-05 01:02');
  });
});

describe('投稿条件', () => {
  it('全端末保管中・月曜以外 → 投稿しない', () => {
    const { shouldPost, reason } = buildDigest({ now: NOW, signals: {}, locations: {} });
    assert.equal(shouldPost, false);
    assert.match(reason, /投稿しない/);
  });

  it('全端末保管中でも月曜日 → 投稿する', () => {
    const monday = new Date('2026-11-02T09:07:00+09:00');
    assert.equal(isMondayJST(monday), true);
    const { shouldPost, reason } = buildDigest({ now: monday, signals: {}, locations: {} });
    assert.equal(shouldPost, true);
    assert.match(reason, /月曜日/);
  });

  it('要確認がある → 投稿する', () => {
    const signals = { S003: signal(3 * D) };
    const { shouldPost, reason } = buildDigest({ now: NOW, signals, locations: {} });
    assert.equal(shouldPost, true);
    assert.match(reason, /要確認 1台/);
  });

  it('稼働中がある → 投稿する', () => {
    const signals = { S002: signal(5 * H, { phone: 'S002' }) };
    const { shouldPost, reason } = buildDigest({ now: NOW, signals, locations: {} });
    assert.equal(shouldPost, true);
    assert.match(reason, /稼働中 1台/);
  });
});

describe('buildDigest 表示', () => {
  it('全端末保管中は「保管中」1行だけ（警告なし）', () => {
    const { shouldPost, text } = buildDigest({ now: NOW, signals: {}, locations: {} });
    assert.equal(shouldPost, false);
    assert.ok(!text.includes('要確認'), '要確認セクションを出さない');
    assert.ok(text.includes('保管中: S002 S003 S004 S005 S006 S007 S008'));
  });

  it('要確認・稼働中・一覧・保管中がそれぞれ整形される', () => {
    const signals = {
      S002: signal(5 * H, { phone: 'S002' }),            // 稼働中
      S003: signal(3 * D, { phone: 'S003' }),            // 要確認
      S005: signal(18 * D, { phone: 'S005', battery: 50 }), // 一覧（最終信号から18日）
      S004: signal(31 * D, { phone: 'S004' }),       // 保管中（30日超）
    };
    const locations = {
      S002: { location: '学A①' },
      S003: { location: '学A②' },
      S005: { location: '学A④狭' },
    };
    const { shouldPost, text } = buildDigest({ now: NOW, signals, locations });

    assert.equal(shouldPost, true);
    // ヘッダーは JST
    assert.ok(text.includes('# 学会スマホ所在確認（2026-11-07 09:07）'));
    // 要確認: 場所・日時・地図リンク・確認文言
    assert.ok(text.includes('## 🔴 要確認'));
    assert.ok(text.includes('・S003（学A②）最終 2026-11-04 09:07／電池 85%／https://www.google.com/maps?q=35.12,135.12'));
    assert.ok(text.includes('→ 最後の場所に置き忘れていないか／倉庫の戻り報告にこの番号があるか確認'));
    // 稼働中
    assert.ok(text.includes('## 稼働中'));
    assert.ok(text.includes('・S002（学A①）最終 2026-11-07 04:07／電池 85%／'));
    // 一覧: 14日超は「最終信号から◯日」
    assert.ok(text.includes('## 一覧'));
    assert.ok(text.includes('・S005（学A④狭）最終信号から18日／電池 50%／'));
    // 保管中 1行
    assert.ok(text.includes('保管中: S004 S006 S007 S008'));
  });

  it('要確認行の日時は JST 表示', () => {
    // UTC 16:00 = JST 翌日 01:00
    const sig = signal(0, { timestamp: new Date('2026-11-06T16:00:00Z') });
    const signals = { S003: { ...sig, phone: 'S003' } };
    const { text } = buildDigest({ now: NOW, signals, locations: { S003: { location: '学A②' } } });
    assert.ok(text.includes('最終 2026-11-07 01:00'));
  });
});