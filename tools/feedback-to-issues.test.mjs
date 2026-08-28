import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueBody,
  buildIssueTitle,
  isIssueCandidate,
  parseRepoMap,
  resolveRepo,
  selectCandidates,
} from './feedback-to-issues.mjs';

test('FEEDBACK_REPO_MAP を解析し、空要素と不正値を無視する', () => {
  assert.deepEqual(parseRepoMap('A=o/r,B=o/r2'), { A: 'o/r', B: 'o/r2' });
  assert.deepEqual(parseRepoMap(''), {});
  assert.deepEqual(parseRepoMap('bad,NoRepo=x,Empty=,Safe=owner/repo'), { Safe: 'owner/repo' });
});

test('既定・上書き・未マッピングからリポジトリを解決する', () => {
  assert.equal(resolveRepo('購買部管理アプリ'), 'kimkon1011/purchasing-management-app');
  assert.equal(resolveRepo('購買部管理アプリ', '購買部管理アプリ=new/repo'), 'new/repo');
  assert.equal(resolveRepo('未知のアプリ'), null);
});

test('bug と request の Issue タイトルを組み立てる', () => {
  assert.equal(buildIssueTitle({ kind: 'bug', title: '保存できない' }), '[不具合] 保存できない');
  assert.equal(buildIssueTitle({ kind: 'request', title: 'CSV出力' }), '[要望] CSV出力');
});

test('Issue 本文は提出元なしと添付ありを明示する', () => {
  const body = buildIssueBody({
    body: '報告本文', submitter: 'kim', page_path: '/orders', source_url: '',
    discord_url: 'https://discord.example/message', has_attachment: true,
  });
  assert.match(body, /報告本文/);
  assert.match(body, /提出元URL: （記載なし）/);
  assert.match(body, /スクショは Discord の元メッセージを参照/);
});

test('parse_ok false は Issue 対象外になる', () => {
  assert.equal(isIssueCandidate({ parse_ok: false, app_name: '購買部管理アプリ', kind: 'bug', title: '障害' }), false);
});

test('--limit 相当の上限を超えた候補の残件数を計算する', () => {
  const items = Array.from({ length: 7 }, (_, index) => ({
    message_id: String(index), parse_ok: true, app_name: '購買部管理アプリ', kind: 'bug', title: `障害${index}`,
  }));
  const result = selectCandidates(items, 5);
  assert.equal(result.selected.length, 5);
  assert.equal(result.remaining, 2);
});
