import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueBody,
  chainBoothFeedbackIntake,
  buildIssueTitle,
  isIssueCandidate,
  parseDismissId,
  parseHostMap,
  parseRepoMap,
  resolveRepo,
  resolveRepoForItem,
  resolveRepoFromUrl,
  selectCandidates,
} from './feedback-to-issues.mjs';

test('--dismiss の message_id を解析する', () => {
  assert.equal(parseDismissId(['--dismiss', 'abc123']), 'abc123');
});

test('--dismiss が無ければ null を返す', () => {
  assert.equal(parseDismissId(['--dry']), null);
});

test('--dismiss に値が無ければ空文字を返す', () => {
  assert.equal(parseDismissId(['--dismiss']), '');
});

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

test('FEEDBACK_HOST_MAP を解析し、不正なホスト・リポジトリ・空要素を無視する', () => {
  assert.deepEqual(parseHostMap('Kobai.OrgIast.jp=owner/repo,foo.example=o/r'), {
    'kobai.orgiast.jp': 'owner/repo',
    'foo.example': 'o/r',
  });
  assert.deepEqual(parseHostMap('bad host=o/r,bad.example=owner/repo$name,empty.example=,,'), {});
});

test('提出元URLの先頭ラベルから許可済みリポジトリを自動導出する', () => {
  assert.equal(
    resolveRepoFromUrl('https://purchasing-management-app.vercel.app/'),
    'kimkon1011/purchasing-management-app',
  );
  assert.equal(resolveRepoFromUrl('https://unknown-app.vercel.app/'), null);
});

test('明示ホスト表で独自ドメインを解決し、自動導出より優先する', () => {
  assert.equal(
    resolveRepoFromUrl('https://kobai.orgiast.jp/', '', 'kobai.orgiast.jp=custom/kobai'),
    'custom/kobai',
  );
  assert.equal(
    resolveRepoFromUrl(
      'https://purchasing-management-app.vercel.app:3000/',
      '',
      'purchasing-management-app.vercel.app=override/repo',
    ),
    'override/repo',
  );
});

test('空または不正な提出元URLは例外を投げず未解決になる', () => {
  assert.equal(resolveRepoFromUrl(''), null);
  assert.equal(resolveRepoFromUrl('not a url'), null);
});

test('実測の文字化けアプリ名でも健全な提出元URLがあれば候補になる', () => {
  const brokenAppName = String.fromCodePoint(
    0xfffd, 0x77, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0xfffd, 0x01d7,
    0xfffd, 0xfffd, 0x41, 0xfffd, 0x76, 0xfffd, 0xfffd,
  );
  const base = { parse_ok: true, app_name: brokenAppName, kind: 'bug', title: '障害' };
  assert.equal(isIssueCandidate({ ...base, source_url: 'https://purchasing-management-app.vercel.app/' }), true);
  assert.equal(isIssueCandidate(base), false);
});

test('正常なアプリ名の従来解決を保ち、ホスト表よりアプリ名を優先する', () => {
  const item = {
    parse_ok: true,
    app_name: '購買部管理アプリ',
    source_url: 'https://purchasing-management-app.vercel.app/',
    kind: 'bug',
    title: '障害',
  };
  assert.equal(isIssueCandidate(item), true);
  assert.equal(resolveRepoForItem(item), 'kimkon1011/purchasing-management-app');
  assert.equal(
    resolveRepoForItem(item, '', 'purchasing-management-app.vercel.app=other/repo'),
    'kimkon1011/purchasing-management-app',
  );
});

test('booth-feedback-intake を 10分タスクから相乗り起動する', async () => {
  const calls = [];
  const fakeSpawn = (...args) => { calls.push(args); return { unref() {} }; };
  assert.equal(await chainBoothFeedbackIntake({ argv: [], spawnImpl: fakeSpawn }), 'spawned');
  assert.equal(calls.length, 1);
  assert.match(calls[0][1][0], /booth-feedback-intake\.mjs$/);
  assert.equal(calls[0][2].detached, true);
});

test('--dry-run と --no-chain では相乗り起動しない', async () => {
  const calls = [];
  const fakeSpawn = (...args) => { calls.push(args); return { unref() {} }; };
  assert.equal(await chainBoothFeedbackIntake({ argv: ['--dry-run'], spawnImpl: fakeSpawn }), 'skipped');
  assert.equal(await chainBoothFeedbackIntake({ argv: ['--no-chain'], spawnImpl: fakeSpawn }), 'skipped');
  assert.equal(calls.length, 0);
});

test('相乗り起動の失敗はこのタスクを落とさない', async () => {
  const boom = () => { throw new Error('spawn boom'); };
  assert.equal(await chainBoothFeedbackIntake({ argv: [], spawnImpl: boom }), 'failed');
});
