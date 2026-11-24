import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USAGE, main, findAutocloseCandidates, findAutoCloseCandidatesBySource, runAutoclose, extractShortPullRequestNumbers, findBackfillCandidates, runBackfill } from '../tools/kim-inbox-autoclose.mjs';

const url = number => `https://github.com/acme/widgets/pull/${number}`;
const item = (id, text, extra = {}) => ({ id, text, title: '', kind: 'ask', status: 'open', ...extra });
const fetchWith = states => async pr => {
  const value = states[pr.number];
  if (value instanceof Error) throw value;
  return { number: pr.number, state: value, mergedAt: value === 'MERGED' ? '2026-11-20T00:00:00Z' : null, closedAt: value === 'CLOSED' ? '2026-11-21T00:00:00Z' : null };
};

for (const args of [['--help'], ['-h'], ['--help', '--apply']]) {
  test(`${args.join(' ')} は使い方を表示して副作用なく終了する`, async () => {
    const output = [];
    let ghCalls = 0;
    let readCalls = 0;
    const code = await main(args, {
      stdout: value => output.push(value),
      fetchState: async () => { ghCalls++; throw new Error('gh must not run'); },
      readItems: () => { readCalls++; return []; },
    });
    assert.equal(code, 0);
    assert.deepEqual(output, [USAGE]);
    assert.equal(ghCalls, 0);
    assert.equal(readCalls, 0);
  });
}

test('PR URL が無い ask はスキップされる', async () => {
  const result = await findAutocloseCandidates([item('ki-none', '判断してください')], { fetchState: fetchWith({}) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped[0].reason, 'PR URLなし');
});

test('OPEN の ask は対象外', async () => {
  const result = await findAutocloseCandidates([item('ki-open', url(1))], { fetchState: fetchWith({ 1: 'OPEN' }) });
  assert.equal(result.candidates.length, 0);
});

test('MERGED の ask は対象', async () => {
  const result = await findAutocloseCandidates([item('ki-merged', url(2))], { fetchState: fetchWith({ 2: 'MERGED' }) });
  assert.deepEqual(result.candidates.map(row => row.id), ['ki-merged']);
});

test('着地済み PR の URL を含む承認待ちは対象外', async () => {
  const text = `kim-inbox の「判断不要な完了通知 29件」を自動クローズしてよいか（--apply の実行可否）\n…${url(2661)}`;
  const result = await findAutocloseCandidates([item('ki-approval', text)], { fetchState: fetchWith({ 2661: 'MERGED' }) });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.approvalRequestExcludedCount, 1);
  assert.equal(result.skipped[0].reason, '承認待ち');
});

test('完了通知の定型は承認語を含んでも従来どおり対象', async () => {
  const text = `✅ check 達成: pr-2646-merge\n達成を確認\n承認済み\n${url(2646)}`;
  const result = await findAutocloseCandidates([item('ki-completion', text)], { fetchState: fetchWith({ 2646: 'MERGED' }) });
  assert.deepEqual(result.candidates.map(row => row.id), ['ki-completion']);
  assert.equal(result.approvalRequestExcludedCount, 0);
});

test('承認語を含まない通常の ask は従来どおり対象', async () => {
  const result = await findAutocloseCandidates([item('ki-normal', `PR #2500 の作業が終わりました\n${url(2500)}`)], { fetchState: fetchWith({ 2500: 'MERGED' }) });
  assert.deepEqual(result.candidates.map(row => row.id), ['ki-normal']);
  assert.equal(result.approvalRequestExcludedCount, 0);
});

test('CLOSED の ask も対象', async () => {
  const result = await findAutocloseCandidates([item('ki-closed', url(3))], { fetchState: fetchWith({ 3: 'CLOSED' }) });
  assert.deepEqual(result.candidates.map(row => row.id), ['ki-closed']);
});

test('複数 PR のうち 1 つでも OPEN なら対象外', async () => {
  const result = await findAutocloseCandidates([item('ki-many', `${url(1)}\n${url(2)}`)], { fetchState: fetchWith({ 1: 'MERGED', 2: 'OPEN' }) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped[0].reason, 'OPENのPRあり');
});

test('同一 PR の状態取得は複数エントリでも 1 回', async () => {
  let calls = 0;
  const result = await findAutocloseCandidates([item('ki-a', url(4)), item('ki-b', url(4))], {
    fetchState: async pr => { calls++; return fetchWith({ 4: 'MERGED' })(pr); },
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(calls, 1);
});

test('dry-run は一時台帳を一切書き換えない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-autoclose-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'ki-20261123000000-abcd';
  const file = path.join(dir, `${id}.json`);
  const record = { ...item(id, url(5)), createdAt: '2026-11-20T00:00:00Z', shownSessions: [], shownCount: 0 };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  let answers = 0;
  const result = await runAutoclose({ home, fetchState: fetchWith({ 5: 'MERGED' }), answer: () => { answers++; } });
  assert.equal(result.candidates.length, 1);
  assert.equal(answers, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('gh 取得失敗は対象外になり理由を保持する', async () => {
  const result = await findAutocloseCandidates([item('ki-fail', url(6))], { fetchState: fetchWith({ 6: new Error('gh timeout') }) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /gh timeout/);
});

test('backfill の短縮番号抽出は完全 URL 付き ask を除外する', () => {
  assert.deepEqual(extractShortPullRequestNumbers(item('ki-short', 'PR #2646 の判断')), [2646]);
  assert.deepEqual(extractShortPullRequestNumbers(item('ki-url', `${url(2646)} と #2646`)), []);
});

test('backfill は PR タイトルの共通手がかりがある候補だけを採用する', async () => {
  const rows = await findBackfillCandidates([item('ki-a', 'kim-inbox autoclose の PR #2646 を判断')], {
    fetchPr: async () => ({ title: 'kim-inbox autoclose: PR URL を補完', state: 'MERGED' }),
  });
  assert.equal(rows[0].apply, true);
  assert.match(rows[0].reason, /共通語/);
});

test('backfill は短い一般語ひとつの一致を根拠にしない', async () => {
  const rows = await findBackfillCandidates([item('ki-a', 'lane の PR #877 を判断')], {
    fetchPr: async () => ({ title: 'lane maintenance', state: 'MERGED' }),
  });
  assert.equal(rows[0].apply, false);
});

test('backfill は曖昧・取得失敗を skip し dry-run では更新しない', async () => {
  const items = [item('ki-a', '無関係な判断 PR #12'), item('ki-b', '取得失敗 PR #13')];
  let updates = 0;
  const result = await runBackfill({ readItems: () => items, updateItem: () => { updates++; }, fetchPr: async pr => {
    if (pr.number === 13) throw new Error('not found');
    return { title: '全く別の変更', state: 'OPEN' };
  } });
  assert.equal(result.candidates, 0);
  assert.equal(result.skipped, 2);
  assert.equal(updates, 0);
});

// ── Source-based auto-close (A-type) tests ──

test('source: auto-progress-done は自動クローズ対象になる', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-apsrc', '✅ check 達成: 何かの完了', { source: 'auto-progress-done' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'ki-apsrc');
  assert.match(result[0].reason, /source=auto-progress-done/);
});

test('source: login-health は自動クローズ対象にならない（kimの入金・再ログインが必要）', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-health', '🔑 ログイン切れ検知: ai-lane:gemini | 状態: 停止', { source: 'login-health' }),
  ]);
  assert.equal(result.length, 0, 'login-health は本当は kim の操作が必要な通知であり自動クローズ禁止');
});

test('source: auto-progress-start-expired は自動クローズ対象にならない（kimの承認待ちセッション）', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-expired', 'セッション abc | 対象: リーダー報酬 単価行自動追加の承認待ち', { source: 'auto-progress-start-expired' }),
  ]);
  assert.equal(result.length, 0, 'auto-progress-start-expired は kim の承認待ちであり自動クローズ禁止');
});

test('source: auto-progress-periodic は自動クローズ対象にならない（確認結果: 未達を含む）', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-periodic', '定期進捗報告', { source: 'auto-progress-periodic' }),
  ]);
  assert.equal(result.length, 0, 'auto-progress-periodic は追跡が必要であり自動クローズ禁止');
});

test('source: auto-progress-heartbeat は自動クローズ対象にならない（実データでAと確認できていない）', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-hb', 'heartbeat', { source: 'auto-progress-heartbeat' }),
  ]);
  assert.equal(result.length, 0, 'auto-progress-heartbeat は確認ができていないため自動クローズ禁止');
});

test('text pattern: ✅ check 達成: で始まるテキストは source が allowlist 外でも対象', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-pattern', '✅ check 達成: 何かの確認が完了'),
  ]);
  assert.equal(result.length, 1);
  assert.match(result[0].reason, /text-pattern/);
});

test('text pattern: ✅ 自動進行が完了しました で始まるテキストは source が allowlist 外でも対象', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-done-text', '✅ 自動進行が完了しました', { source: 'some-other-source' }),
  ]);
  assert.equal(result.length, 1);
  assert.match(result[0].reason, /text-pattern/);
});

test('text pattern: 📋 未通知だった自動進行の完了一覧 で始まるテキストは対象', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-notified', '📋 未通知だった自動進行の完了一覧 | 過去に完了していたもの'),
  ]);
  assert.equal(result.length, 1);
});

test('判断を求める C 型は自動クローズ対象にならない', () => {
  const result = findAutoCloseCandidatesBySource([
    item('ki-c1', '【承認依頼】PR #222 をマージしてよいか'),
    item('ki-c2', '【要対応・kimの判断待ち】操作が必要です', { source: 'quota-sweep' }),
    item('ki-c3', 'スタッフ評価・ブラックリスト機能の実装に入ってよいか、返事をください。', { source: '' }),
  ]);
  assert.equal(result.length, 0);
});

test('info アイテムは kind=ask 以外なので自動クローズ対象にならない', () => {
  const result = findAutoCloseCandidatesBySource([
    { id: 'ki-info', text: '✅ check 達成: 完了', kind: 'info', status: 'open', source: 'auto-progress-done' },
  ]);
  assert.equal(result.length, 0);
});

test('既に seen の ask は自動クローズ対象にならない', () => {
  const result = findAutoCloseCandidatesBySource([
    { id: 'ki-seen', text: '✅ check 達成: 完了', kind: 'ask', status: 'seen', source: 'auto-progress-done' },
  ]);
  assert.equal(result.length, 0);
});

test('runAutoclose dry-run は source 候補をファイルに書き込まない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-autoclose-src-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'ki-20261124000000-1234';
  const file = path.join(dir, `${id}.json`);
  const record = { id, text: '✅ check 達成: テスト完了', title: '', kind: 'ask', status: 'open', source: 'auto-progress-done', createdAt: '2026-11-24T00:00:00Z', shownSessions: [], shownCount: 0 };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  let answers = 0;
  const result = await runAutoclose({ home, fetchState: async () => ({ state: 'OPEN', number: 0 }), answer: () => { answers++; } });
  assert.equal(result.sourceCandidates.length, 1);
  assert.equal(answers, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('runAutoclose --apply は source 候補を回答記録する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-autoclose-src2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'ki-20261124000000-5678';
  const file = path.join(dir, `${id}.json`);
  const record = { id, text: '✅ check 達成: 完了', title: '', kind: 'ask', status: 'open', source: 'auto-progress-done', createdAt: '2026-11-24T00:00:00Z', shownSessions: [], shownCount: 0 };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  let answers = [];
  const result = await runAutoclose({
    home, apply: true,
    fetchState: async () => ({ state: 'OPEN', number: 0 }),
    answer: (h, id, msg, sid) => { answers.push({ id, msg, sid }); },
  });
  assert.equal(result.sourceCandidates.length, 1);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].id, id);
  assert.match(answers[0].msg, /自動通知のため自動クローズ/);
  assert.equal(answers[0].sid, 'kim-inbox-autoclose');
});

test('formatResult の出力に自動通知件数が表示される', async () => {
  const { formatResult } = await import('../tools/kim-inbox-autoclose.mjs');
  const result = {
    candidates: [],
    sourceCandidates: [{ id: 'ki-src', source: 'auto-progress-done', reason: 'source=auto-progress-done', text: '✅ check 達成: 完了' }],
    fetchedPrCount: 0, failures: [], skipped: [], apply: false, closed: [],
  };
  const output = formatResult(result);
  assert.match(output, /自動通知.*1件/);
  assert.match(output, /auto-progress-done/);
});
