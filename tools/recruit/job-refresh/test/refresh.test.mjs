import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_URL,
  buildDm,
  createProposal,
  parseJobList,
  parseLastUpdated,
  reconcileState,
  selectJob,
  markExpiredRequests,
} from '../refresh.mjs';

const NOW = new Date('2026-11-05T10:15:00+09:00');

test('固定HTMLからwork_ID・職種名と最終更新日をパースする', () => {
  const listHtml = `
    <a class="linkKoma" href="/orgiast/work_12345/?via_recruit_page=1">
      <h2 class="catch">フルリモート &amp; 事務スタッフ</h2>
    </a>
    <a href='/orgiast/work_67890/'><h2 class='catch'>イベント運営</h2></a>`;
  assert.deepEqual(parseJobList(listHtml), [
    { id: '12345', title: 'フルリモート & 事務スタッフ', url: 'https://en-gage.net/orgiast/work_12345/' },
    { id: '67890', title: 'イベント運営', url: 'https://en-gage.net/orgiast/work_67890/' },
  ]);
  assert.equal(parseLastUpdated('<div class="date">最終更新日：2026/10/2<br></div>'), '2026-10-02');
  assert.equal(parseLastUpdated('<p>更新日の表示なし</p>'), null);
});

function jobs() {
  return [
    { id: '1', title: '新しい', url: 'https://en-gage.net/orgiast/work_1/', lastUpdated: '2026-10-01' },
    { id: '2', title: '最古', url: 'https://en-gage.net/orgiast/work_2/', lastUpdated: '2025-01-01' },
    { id: '3', title: '取得不能', url: 'https://en-gage.net/orgiast/work_3/', lastUpdated: null },
  ];
}

test('選択は最古の最大1件で、取得不可をスキップする', () => {
  const state = reconcileState(jobs(), { version: 1, jobs: {} }, NOW);
  assert.equal(selectJob(jobs(), state, { now: NOW, intervalDays: 14 })?.id, '2');
});

test('依頼から3日以内は待つ', () => {
  const state = reconcileState(jobs(), { version: 1, jobs: {
    2: { lastUpdated: '2025-01-01', lastRequestedAt: '2026-11-03T10:15:00+09:00', retryCount: 0 },
  } }, NOW);
  assert.equal(selectJob(jobs(), state, { now: NOW, intervalDays: 14 })?.id, '1');
});

test('3日後に最大2回再依頼し、その後は要確認にする', () => {
  for (const retryCount of [0, 1]) {
    const state = reconcileState(jobs(), { version: 1, jobs: {
      2: { lastUpdated: '2025-01-01', lastRequestedAt: '2026-11-01T10:15:00+09:00', retryCount },
    } }, NOW);
    assert.equal(selectJob(jobs(), state, { now: NOW, intervalDays: 14 })?.id, '2');
  }
  const state = reconcileState(jobs(), { version: 1, jobs: {
    2: { lastUpdated: '2025-01-01', lastRequestedAt: '2026-11-01T10:15:00+09:00', retryCount: 2 },
  } }, NOW);
  markExpiredRequests(jobs(), state, NOW);
  assert.equal(state.jobs['2'].needsReview, true);
  assert.notEqual(selectJob(jobs(), state, { now: NOW, intervalDays: 14 })?.id, '2');
});

test('公開更新日が変われば依頼履歴を完了扱いに戻す', () => {
  const state = reconcileState(jobs(), { version: 1, jobs: {
    2: { lastUpdated: '2024-01-01', lastRequestedAt: '2026-11-01T10:15:00+09:00', retryCount: 2, needsReview: true },
  } }, NOW);
  assert.equal(state.jobs['2'].lastRequestedAt, null);
  assert.equal(state.jobs['2'].needsReview, false);
  assert.ok(state.jobs['2'].completedAt);
});

test('DM本文に公開URL・ログインURL・貼り付け文が揃う', () => {
  const job = jobs()[0];
  const proposal = { field: '仕事内容', location: '冒頭（1行目）に追記', text: '11月スタート歓迎。' };
  const body = buildDm(job, proposal);
  assert.match(body, new RegExp(job.url.replaceAll('/', '\\/')));
  assert.ok(body.includes(LOGIN_URL));
  assert.ok(body.includes('11月スタート歓迎。'));
  assert.ok(body.includes('saiyo@orgiast.jp'));
  assert.ok(body.includes('最終更新日'));
});

test('変更案は日本時間の月を重複なく含み、前回と同じ文面を避ける', () => {
  const first = createProposal(jobs()[0], {}, NOW);
  const second = createProposal(jobs()[0], { requestedText: first.text }, NOW);
  assert.match(first.text, /11月/);
  assert.doesNotMatch(first.text, /11月月/);
  assert.notEqual(second.text, first.text);
});

