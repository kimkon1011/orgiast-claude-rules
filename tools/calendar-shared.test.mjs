import test from 'node:test';
import assert from 'node:assert/strict';

import { isInternalEmail, sanitizeAttendees, isAcademicGroup, loadStaffAddresses } from './lib/calendar-shared.mjs';

test('isInternalEmail: staffAddresses も社内扱い', () => {
  const staff = ['personal@gmail.com'];
  assert.equal(isInternalEmail('tanaka@orgiast.jp', staff), true, 'orgiast.jp は社内');
  assert.equal(isInternalEmail('personal@gmail.com', staff), true, 'staffAddresses にあれば社内');
  assert.equal(isInternalEmail('external@partner.co.jp', staff), false, 'staffAddresses に無い個人メールは false');
  assert.equal(isInternalEmail('client@example.com', staff), false, '社外メールは false');
  assert.equal(isInternalEmail('', staff), false, '空文字は false');
  assert.equal(isInternalEmail('KIM@ORGIAST.JP', staff), true, '大文字小文字を区別しない');
  assert.equal(isInternalEmail('Personal@Gmail.com', ['personal@gmail.com']), true, 'staffAddresses も大文字小文字を区別しない');
});

test('isInternalEmail: staffAddresses が空なら従来通りの動作', () => {
  assert.equal(isInternalEmail('tanaka@orgiast.jp'), true);
  assert.equal(isInternalEmail('personal@gmail.com'), false);
  assert.equal(isInternalEmail('personal@gmail.com', []), false);
  assert.equal(isInternalEmail('personal@gmail.com', undefined), false);
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

test('sanitizeAttendees: staffAddresses を isInternalEmail に伝搬する', () => {
  const staff = ['staff-personal@gmail.com'];
  const result = sanitizeAttendees([
    { email: 'staff-personal@gmail.com' },
    { email: 'client@example.com' },
  ], { staffAddresses: staff });
  assert.equal(result.length, 1, 'staffAddresses のメールは社内扱いで残る');
  assert.equal(result[0].email, 'staff-personal@gmail.com');
});

test('sanitizeAttendees: 空・無効な入力は空配列', () => {
  assert.deepEqual(sanitizeAttendees([]), []);
  assert.deepEqual(sanitizeAttendees(null), []);
  assert.deepEqual(sanitizeAttendees(undefined), []);
  assert.deepEqual(sanitizeAttendees([{ noEmail: true }]), []);
});

test('sanitizeAttendees: staff-addresses にあるアドレスは社内扱いで保持、無いものだけ除外', () => {
  const attendees = [
    { email: 'external@partner.co.jp' },
    { email: 'client@example.com' },
  ];
  const staff = ['external@partner.co.jp'];
  const result = sanitizeAttendees(attendees, { staffAddresses: staff });
  assert.equal(result.length, 1, 'staff-addresses にある external@partner.co.jp は社内扱いで保持');
  assert.equal(result[0].email, 'external@partner.co.jp');
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
test('正本の社員 Gmail を既定で社内扱いする', () => {
  assert.ok(loadStaffAddresses().includes('matsumoto.y.work@gmail.com'));
  assert.equal(isInternalEmail('MATSumoto.y.work@gmail.com'), true);
  assert.equal(isInternalEmail('waki.toho@gmail.com'), true);
  assert.deepEqual(sanitizeAttendees([{ email: 'waki.toho@gmail.com' }, { email: 'client@gmail.com' }], { log: () => {} }), [{ email: 'waki.toho@gmail.com' }]);
});
