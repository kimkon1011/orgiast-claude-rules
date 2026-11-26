import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStalledNoticeKind } from './lib/stalled-notice-kind.mjs';

test('承認ワードが reason にある → ask', () => {
  assert.equal(decideStalledNoticeKind({ reason: 'kim の承認が必要です' }), 'ask');
});

test('第三者からの返信待ち → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '辻さんからフリガナの返信を待ち、確認後に企業登録を実行する' }),
    'info',
  );
});

test('他セッションが着手中 → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '他の2並行セッションが着手しているため待機' }),
    'info',
  );
});

test('未知の理由（天候） → ask（安全側）', () => {
  assert.equal(decideStalledNoticeKind({ reason: '天候により会場の下見ができない' }), 'ask');
});

test('承認語と info パターンが両方ある → ask（承認語優先）', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '佐藤さんから回答待ち。入金の承認も要る' }),
    'ask',
  );
});

test('nextStep に判断ワード → ask', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '自動進行の完了', nextStep: '削除してよいか確認が必要' }),
    'ask',
  );
});

test('reason に作業途中 → info', () => {
  assert.equal(decideStalledNoticeKind({ reason: '作業が途中で時間切れになった' }), 'info');
});

test('reason に期限超過 → info', () => {
  assert.equal(decideStalledNoticeKind({ reason: '期限を超過したため続きから再開' }), 'info');
});

test('先方からの回答待ち → info', () => {
  assert.equal(
    decideStalledNoticeKind({ reason: '先方から回答待ちの状態' }),
    'info',
  );
});

test('契約の承認 → ask', () => {
  assert.equal(decideStalledNoticeKind({ reason: '契約の承認が必要です' }), 'ask');
});

test('nextStep に決裁 → ask', () => {
  assert.equal(decideStalledNoticeKind({ nextStep: '決裁が必要です' }), 'ask');
});