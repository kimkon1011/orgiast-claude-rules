import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_CALENDAR, isAcademicGroup, isInternalEmail, isKimMeeting, loadStaffAddresses, routeCalendar, sanitizeAttendees, withCaseLabel } from './lib/calendar-shared.mjs';

test('isInternalEmail: staffAddresses も社内扱い', () => {
  const staff = ['personal@gmail.com'];
  assert.equal(isInternalEmail('tanaka@orgiast.jp', staff), true);
  assert.equal(isInternalEmail('personal@gmail.com', staff), true);
  assert.equal(isInternalEmail('external@partner.co.jp', staff), false);
  assert.equal(isInternalEmail('client@example.com', staff), false);
  assert.equal(isInternalEmail('', staff), false);
  assert.equal(isInternalEmail('KIM@ORGIAST.JP', staff), true);
  assert.equal(isInternalEmail('Personal@Gmail.com', ['personal@gmail.com']), true);
});

test('isInternalEmail: staffAddresses が空なら従来通りの動作', () => {
  assert.equal(isInternalEmail('tanaka@orgiast.jp'), true);
  assert.equal(isInternalEmail('personal@gmail.com'), false);
  assert.equal(isInternalEmail('personal@gmail.com', []), false);
  assert.equal(isInternalEmail('personal@gmail.com', undefined), false);
});

test('sanitizeAttendees: 社外アドレスを除外しログに出す', () => {
  const logs = [];
  const result = sanitizeAttendees([{ email: 'kim@orgiast.jp' }, { email: 'tanaka@orgiast.jp' }, { email: 'client@example.com' }, { email: 'supplier@other.co.jp' }], { log: msg => logs.push(msg) });
  assert.deepEqual(result, [{ email: 'kim@orgiast.jp' }, { email: 'tanaka@orgiast.jp' }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /client@example\.com/);
  assert.match(logs[0], /supplier@other\.co\.jp/);
});

test('sanitizeAttendees: staffAddresses を isInternalEmail に伝搬する', () => {
  assert.deepEqual(sanitizeAttendees([{ email: 'staff-personal@gmail.com' }, { email: 'client@example.com' }], { staffAddresses: ['staff-personal@gmail.com'] }), [{ email: 'staff-personal@gmail.com' }]);
});

test('sanitizeAttendees: 空・無効な入力は空配列', () => {
  assert.deepEqual(sanitizeAttendees([]), []);
  assert.deepEqual(sanitizeAttendees(null), []);
  assert.deepEqual(sanitizeAttendees(undefined), []);
  assert.deepEqual(sanitizeAttendees([{ noEmail: true }]), []);
});

test('sanitizeAttendees: staff-addresses にあるアドレスは社内扱いで保持', () => {
  assert.deepEqual(sanitizeAttendees([{ email: 'external@partner.co.jp' }, { email: 'client@example.com' }], { staffAddresses: ['external@partner.co.jp'] }), [{ email: 'external@partner.co.jp' }]);
});

test('isAcademicGroup: nxa / 学会 を含むグループ名を検出', () => {
  for (const name of ['1121福岡nxa日本早産学会', '1204愛知nxa救急医学会', '0906大阪学会', '日本医学会春季大会', 'nxa', 'NXA']) assert.equal(isAcademicGroup(name), true);
  for (const name of ['ラハイナ PJ', '', null, undefined]) assert.equal(isAcademicGroup(name), false);
});

test('isAcademicGroup: 判定は大文字小文字を区別しない', () => {
  assert.equal(isAcademicGroup('NXA'), true);
  assert.equal(isAcademicGroup('学会'), true);
  assert.equal(isAcademicGroup('nXa'), true);
});

test('正本の社員 Gmail を既定で社内扱いする', () => {
  assert.ok(loadStaffAddresses().includes('matsumoto.y.work@gmail.com'));
  assert.equal(isInternalEmail('MATSumoto.y.work@gmail.com'), true);
  assert.equal(isInternalEmail('waki.toho@gmail.com'), true);
  assert.deepEqual(sanitizeAttendees([{ email: 'waki.toho@gmail.com' }, { email: 'client@gmail.com' }], { log: () => {} }), [{ email: 'waki.toho@gmail.com' }]);
});

test('AI・求人・学会の予定をタスクカレンダーへ振り分ける', () => {
  assert.equal(routeCalendar({ summary: '【自動】確認' }, { origin: 'sync' }), AI_CALENDAR);
  assert.equal(routeCalendar({ summary: '急募 アルバイト応募' }, { origin: 'sync' }), AI_CALENDAR);
  assert.equal(routeCalendar({ summary: '学術集会 申込期限' }, { origin: 'sync' }), AI_CALENDAR);
  assert.equal(routeCalendar({ summary: '普通の作業' }, { origin: 'ai' }), AI_CALENDAR);
});

test('金さん本人の打合せは primary を優先する', () => {
  const cases = [
    { summary: 'M: 学会の打合せ' },
    { summary: '中途面談' },
    { summary: '求人の確認', description: 'https://meet.google.com/abc-defg-hij' },
    { summary: '協賛ナビ', attendees: [{ email: 'guest@example.com' }] },
  ];
  for (const ev of cases) {
    assert.equal(isKimMeeting(ev), true);
    assert.equal(routeCalendar(ev, { origin: 'ai' }), 'primary');
  }
});

test('案件名があれば件名と説明に入れ、二重化しない', () => {
  const once = withCaseLabel({ summary: '会議', description: '資料確認' }, '株式会社ABC', 'test');
  assert.equal(once.summary, '【株式会社ABC】会議');
  assert.match(once.description, /^案件: 株式会社ABC\n/);
  assert.deepEqual(withCaseLabel(once, '株式会社ABC', 'test'), once);
});

test('案件名不明は推測せず未特定と登録元を入れる', () => {
  const labeled = withCaseLabel({ summary: '作業', description: '' }, '', 'deadline-watch');
  assert.equal(labeled.summary, '【案件未特定】作業');
  assert.equal(labeled.description, '案件: 未特定（登録元: deadline-watch）');
});
