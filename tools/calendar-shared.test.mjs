import test from 'node:test';
import assert from 'node:assert/strict';

import { isInternalEmail, sanitizeAttendees, isAcademicGroup } from './lib/calendar-shared.mjs';

test('isInternalEmail: @orgiast.jp のみ社内', () => {
  const staff = ['personal@gmail.com', 'external@partner.co.jp'];
  assert.equal(isInternalEmail('tanaka@orgiast.jp', staff), true, 'orgiast.jp は社内');
  assert.equal(isInternalEmail('personal@gmail.com', staff), false);
  assert.equal(isInternalEmail('external@partner.co.jp', staff), false);
  assert.equal(isInternalEmail('client@example.com', staff), false, '社外メールは false');
  assert.equal(isInternalEmail('', staff), false, '空文字は false');
  assert.equal(isInternalEmail('KIM@ORGIAST.JP', staff), true, '大文字小文字を区別しない');
});

test('sanitizeAttendees: 社外アドレスを除外しログに出す', () => {
  const attendees = [
    { email: 'kim@orgiast.jp' },
    { email: 'tanaka@orgiast.jp' },
    { email: 'client@example.com' },
    { email: 'supplier@other.co.jp' },
  ];
  const logs = [];
  const result = sanitizeAttendees(attendees, { log: msg => logs.push(msg) });

  assert.equal(result.length, 2, '社内2件だけ残る');
  assert.deepEqual(result, [{ email: 'kim@orgiast.jp' }, { email: 'tanaka@orgiast.jp' }]);
  assert.equal(logs.length, 1, '除外ログが1件出る');
  assert.match(logs[0], /client@example\.com/);
  assert.match(logs[0], /supplier@other\.co\.jp/);
});

test('sanitizeAttendees: 空・無効な入力は空配列', () => {
  assert.deepEqual(sanitizeAttendees([]), []);
  assert.deepEqual(sanitizeAttendees(null), []);
  assert.deepEqual(sanitizeAttendees(undefined), []);
  assert.deepEqual(sanitizeAttendees([{ noEmail: true }]), []);
});

test('sanitizeAttendees: staff-addresses の社外アドレスも除外', () => {
  const attendees = [
    { email: 'external@partner.co.jp' },
    { email: 'client@example.com' },
  ];
  const staff = ['external@partner.co.jp'];
  const result = sanitizeAttendees(attendees, { staffAddresses: staff });
  assert.deepEqual(result, []);
});

test('isAcademicGroup: nxa / 学会 を含むグループ名を検出', () => {
  assert.equal(isAcademicGroup('1121福岡nxa日本早産学会'), true, 'nxa を含む');
  assert.equal(isAcademicGroup('1204愛知nxa救急医学会'), true, 'nxa + 学会を含む');
  assert.equal(isAcademicGroup('0906大阪学会'), true, '学会を含む');
  assert.equal(isAcademicGroup('日本医学会春季大会'), true, '学会のみ');
  assert.equal(isAcademicGroup('ラハイナ PJ'), false, '通常のPJ');
  assert.equal(isAcademicGroup(''), false, '空文字');
  assert.equal(isAcademicGroup(null), false, 'null');
  assert.equal(isAcademicGroup(undefined), false, 'undefined');
  assert.equal(isAcademicGroup('nxa'), true, 'nxa のみ');
  assert.equal(isAcademicGroup('NXA'), true, '大文字 NXA');
});

test('isAcademicGroup: 判定は大文字小文字を区別しない', () => {
  assert.equal(isAcademicGroup('NXA'), true);
  assert.equal(isAcademicGroup('学会'), true);
  assert.equal(isAcademicGroup('nXa'), true);
});