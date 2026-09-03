import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCommentTarget, buildReplyComment, hasAlreadyCommented } from './feedback-replies.mjs';
import { parseDismissId } from './feedback-to-issues.mjs';

test('replied_to_urls に Issue/PR URL があれば最優先で採用する', () => {
  const reply = { replied_to_urls: ['https://example.com/foo', 'https://github.com/kimkon1011/purchasing-management-app/issues/42'] };
  assert.deepEqual(pickCommentTarget(reply, [{ repository: 'other/repo', number: 1 }]), {
    repo: 'kimkon1011/purchasing-management-app', number: 42,
  });
});

test('PR の URL も判定できる', () => {
  const reply = { replied_to_urls: ['https://github.com/owner/repo/pull/7'] };
  assert.deepEqual(pickCommentTarget(reply, []), { repo: 'owner/repo', number: 7 });
});

test('URL が無ければマーカー検索が1件のときだけ採用する', () => {
  const reply = { replied_to_urls: [] };
  assert.deepEqual(pickCommentTarget(reply, [{ repository: { nameWithOwner: 'owner/repo' }, number: 5 }]), {
    repo: 'owner/repo', number: 5,
  });
});

test('マーカー検索が0件なら null（推測しない）', () => {
  assert.equal(pickCommentTarget({ replied_to_urls: [] }, []), null);
});

test('マーカー検索が2件以上なら null（推測しない）', () => {
  const results = [
    { repository: 'owner/repo1', number: 1 },
    { repository: 'owner/repo2', number: 2 },
  ];
  assert.equal(pickCommentTarget({ replied_to_urls: [] }, results), null);
});

test('URL・検索結果のどちらも無ければ null', () => {
  assert.equal(pickCommentTarget({}, undefined), null);
});

test('コメント本文は JST 表記とマーカー行を末尾に含む', () => {
  const body = buildReplyComment({
    reply_id: 'r-1',
    content: 'このIssueは優先度を上げて対応して',
    created_at: '2026-09-03T01:00:00.000Z',
  });
  assert.match(body, /^kim からの実行指示（Discord DM 返信 \/ 2026\/09\/03 10:00 JST）/);
  assert.match(body, /このIssueは優先度を上げて対応して/);
  assert.equal(body.trimEnd().split('\n').at(-1), '<!-- feedback-reply:r-1 -->');
});

test('本文が空なら（本文なし）で埋める', () => {
  const body = buildReplyComment({ reply_id: 'r-2', content: '', created_at: '2026-09-03T01:00:00.000Z' });
  assert.match(body, /（本文なし）/);
});

test('日時が不正なら元の文字列をそのまま出す', () => {
  const body = buildReplyComment({ reply_id: 'r-3', content: 'x', created_at: '不正な日付' });
  assert.match(body, /不正な日付/);
});

test('既存コメントにマーカーがあれば二重投稿防止で true を返す', () => {
  const comments = [{ body: 'こんにちは' }, { body: '前回の指示\n<!-- feedback-reply:r-1 -->' }];
  assert.equal(hasAlreadyCommented(comments, 'r-1'), true);
});

test('既存コメントにマーカーが無ければ false', () => {
  const comments = [{ body: 'こんにちは' }];
  assert.equal(hasAlreadyCommented(comments, 'r-1'), false);
});

test('コメントが空配列でも例外にならない', () => {
  assert.equal(hasAlreadyCommented([], 'r-1'), false);
  assert.equal(hasAlreadyCommented(undefined, 'r-1'), false);
});

test('feedback-to-issues.mjs の parseDismissId をそのまま再利用できる', () => {
  assert.equal(parseDismissId(['--dismiss', 'r-9']), 'r-9');
  assert.equal(parseDismissId(['--dry']), null);
});
