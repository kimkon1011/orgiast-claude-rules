import assert from 'node:assert/strict';
import test from 'node:test';

import { CHECKLIST } from '../checklist-data.mjs';
import {
  attachPhoto,
  buildSubmission,
  canSubmit,
  createInitialState,
  toggleItem,
} from '../app.mjs';

test('ルンバの裏側清掃は閉店作業にある写真必須項目', () => {
  const item = CHECKLIST.close.items.find(({ id }) => id === 'roomba-back-clean');
  assert.ok(item);
  assert.equal(item.photoRequired, true);
});

test('写真なしでは写真必須項目をチェックできない', () => {
  const state = createInitialState();
  const result = toggleItem(state, 'roomba-back-clean', true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'photo-required');
  assert.equal(result.state.items['roomba-back-clean'].checked, false);
  assert.equal(state.items['roomba-back-clean'].checked, false);
});

test('写真を添付すると写真必須項目をチェックできる', () => {
  const original = createInitialState();
  const withPhoto = attachPhoto(original, 'roomba-back-clean', 'data:image/jpeg;base64,PHOTO');
  const result = toggleItem(withPhoto, 'roomba-back-clean', true);
  assert.equal(result.ok, true);
  assert.equal(result.state.items['roomba-back-clean'].checked, true);
  assert.equal(original.items['roomba-back-clean'].photo, null);
});

test('全項目のチェック前後で送信可否が変わる', () => {
  const initial = createInitialState();
  assert.equal(canSubmit(initial, 'open'), false);
  const result = toggleItem(initial, 'open-preparation-check', true);
  assert.equal(result.ok, true);
  assert.equal(canSubmit(result.state, 'open'), true);
});

test('送信レコードに写真枚数と指定日時が入る', () => {
  const now = new Date('2026-09-13T03:04:05.000Z');
  const withPhoto = attachPhoto(createInitialState(), 'roomba-back-clean', 'data:image/jpeg;base64,PHOTO');
  const completed = toggleItem(withPhoto, 'roomba-back-clean', true).state;
  const submission = buildSubmission(completed, 'close', now);
  assert.equal(submission.photos, 1);
  assert.equal(submission.at, '2026-09-13T03:04:05.000Z');
  assert.equal(submission.part, 'close');
  assert.equal(submission.items[0].photo, 'data:image/jpeg;base64,PHOTO');
});

test('全項目の id は重複しない', () => {
  const ids = Object.values(CHECKLIST).flatMap((section) => section.items.map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length);
});
