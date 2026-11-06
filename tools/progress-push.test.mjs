import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pushDailyProgress, checkOutput } from './lib/auto-progress-daily.mjs';
import { displayPcNames } from './lib/pc-display.mjs';
import { addItem, listItems, selectContext, markSeen } from './kim-inbox.mjs';
import { checkPromise, executeCheck } from './auto-progress-check.mjs';
import { clearedReason, filterClearedDrafts, notifyClearedDrafts, deleteClearedDrafts, clearedRecords, nonHumanRecipient, draftFingerprint } from './lib/drafts-auto-cleared.mjs';
import { analyzeDraft, notifyText } from './external-waiting.mjs';

const now = Date.parse('2026-11-06T00:05:00Z');
const hour = 3600000;
function homeFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-push-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ 'kim-PC': { account: 'kim@orgiast.jp' } }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const rowFixture = () => ({ sessionId: 'session-a', ts: new Date(now - 48 * hour).toISOString(), status: 'open', label: 'まとめ確認', promise: 'まとめ確認', nextClaude: '再確認する', lastCheckOutput: '未達A\n未達B' });
test('毎朝9時台に1件、同じ日の再判定は無通知、翌日は同じIDを更新する', async t => {
  const home = homeFixture(t), row = rowFixture(), patch = (_key, changes) => Object.assign(row, changes);
  assert.equal(await pushDailyProgress(home, row, { now: now - hour, patch }), null);
  const first = await pushDailyProgress(home, row, { now, patch });
  assert.ok(first.id);
  assert.equal(await pushDailyProgress(home, row, { now: now + 60000, patch }), null);
  markSeen(home, first.id);
  const next = await pushDailyProgress(home, row, { now: now + 24 * hour, patch });
  assert.equal(next.id, first.id); assert.equal(next.status, 'open'); assert.equal(listItems(home).length, 1);
});
test('変化時は時間外でも更新し、消えた未達項目と次の自動処理を示す', async t => {
  const home = homeFixture(t), row = rowFixture(), patch = (_key, changes) => Object.assign(row, changes);
  await pushDailyProgress(home, row, { now, patch });
  row.lastCheckOutput = '未達B';
  const updated = await pushDailyProgress(home, row, { now: now + 5 * hour, patch });
  assert.match(updated.text, /解消した項目）:\n未達A/); assert.match(updated.text, /次に自動でやること: 再確認する/);
  assert.equal(listItems(home).length, 1);
});
test('通知失敗は配達済みにせず次回再試行、出力は2000字まで', async () => {
  const row = rowFixture(), patch = (_key, changes) => Object.assign(row, changes);
  await assert.rejects(pushDailyProgress('unused', row, { now, patch, io: { addKimInboxItem: async () => ({ id: 'x', forwardError: 'offline' }) } }), /offline/);
  assert.equal(row.progressDay, undefined);
  let calls = 0;
  await pushDailyProgress('unused', row, { now, patch, io: { addKimInboxItem: async () => { calls++; return { id: 'x' }; } } });
  assert.equal(calls, 1); assert.equal(Array.from(checkOutput('あ'.repeat(2100))).length, 2000);
});
test('既表示でも毎朝の各セッション最初に先頭表示し同日の二度目は抑制', async t => {
  const home = homeFixture(t), row = rowFixture();
  const item = await pushDailyProgress(home, row, { now, patch: () => true });
  item.shownCount = 99; item.shownSessions = ['same'];
  const ask = { ...item, id: 'ask', kind: 'ask', dailyProgress: false, text: '判断依頼' };
  const first = selectContext([ask, item], { now, sessionId: 'same', home });
  assert.ok(first.indexOf('【進捗・毎朝】') < first.indexOf('判断依頼'));
  assert.match(first, /未達A/);
  assert.doesNotMatch(selectContext([item], { now: now + 1000, sessionId: 'same', home }), /【進捗・毎朝】/);
  assert.match(selectContext([item], { now, sessionId: 'other', home }), /未達A/);
  assert.match(selectContext([item], { now: now + 24 * hour, sessionId: 'same', home }), /未達A/);
});
test('check stdout を lastCheckOutput に保存する', async t => {
  const home = homeFixture(t), row = { ...rowFixture(), check: 'test-check', deadlineAt: new Date(now + hour).toISOString() };
  const changes = {};
  await checkPromise(row, { home, now, patch: (_key, value) => Object.assign(changes, value), suppressNotices: true,
    io: { executeCheck: async () => ({ code: 1, text: '未達A', stdout: 'あ'.repeat(2500) }) } });
  assert.equal(changes.lastCheckOutput.length, 2000);
  const result = executeCheck(row, { home, shellPath: null, spawnImpl: () => ({ status: 1, stdout: '一覧', stderr: '' }) });
  assert.equal(result.stdout, '一覧');
});
test('PC map の確定番号を表示し未登録・部分一致は維持する', () => {
  const pcMap = { 'w018-PC': { remoteName: '作業用018', hostname: 'DESKTOP-X' }, 'cafe015-PC': { sheetName: '作業用015' }, _unverified: { remoteName: '作業用777' } };
  assert.equal(displayPcNames('w018-PC と cafe015-PC と DESKTOP-X と unknown-PC', { pcMap }), '作業用018 と 作業用015 と 作業用018 と unknown-PC');
  assert.equal(displayPcNames('xw018-PC', { pcMap }), 'xw018-PC');
});
const mailbox = 'kim@orgiast.jp', otherMailbox = 'seisaku-team@orgiast.jp';
const msg = ({ id = 'm', to = 'person@example.com', subject = '相談', body = '本文'.repeat(100), at = now - 48 * hour, threadId = 'thread-a', labels = ['DRAFT'] } = {}) => ({ id, threadId, internalDate: String(at), labelIds: labels,
  payload: { mimeType: 'text/plain', headers: [{ name: 'To', value: to }, { name: 'Subject', value: subject }], body: { data: Buffer.from(body).toString('base64url') } } });
const sent = options => msg({ id: 'sent', at: now - hour, labels: ['SENT'], threadId: 'thread-b', ...options });
test('同じ宛先と正規化件名、または本文冒頭一致の送信済みを照合', () => {
  const draft = msg();
  assert.equal(clearedReason(draft, sent({ subject: 'Re: Fwd: 相談', body: '別本文' }), false), '送信済み');
  assert.equal(clearedReason(draft, sent({ subject: '別件名' }), false), '送信済み');
  assert.equal(clearedReason(draft, sent({ to: 'other@example.com' }), false), null);
  assert.equal(clearedReason(draft, sent({ at: now - 50 * hour }), false), null);
  assert.equal(clearedReason(msg({ subject: '', body: '' }), sent({ subject: '', body: '' }), false), null);
});
test('同一メールボックスの同じスレッドで後に送信済みなら不要', () => {
  assert.equal(clearedReason(msg(), sent({ threadId: 'thread-a', subject: '別件', body: '別の返信', to: 'other@example.com' }), true), '不要（後で別の返信を送信済み）');
  assert.equal(clearedReason(msg(), sent({ threadId: 'thread-a', subject: '別件', body: '別の返信' }), false), null);
});
test('下書き表示にメールボックスと空件名時の本文20字、機械宛ては除外', () => {
  const draft = { id: 'd', message: msg({ subject: '', body: 'あ'.repeat(30) }) };
  const item = analyzeDraft(draft, { mailbox, now });
  assert.equal(item.subject, 'あ'.repeat(20));
  assert.match(notifyText([item], now), /kim@.*の下書き/);
  assert.match(notifyText([{ ...item, mailbox: otherMailbox }], now), /seisaku-team@.*の下書き/);
  assert.equal(analyzeDraft({ id: 'd', message: msg({ to: 'receipt@mail-receiver.freee.co.jp' }) }, { mailbox, now }), null);
  assert.equal(nonHumanRecipient('person@example.com'), false);
});
function fakeClient({ draft = { id: 'd', message: msg() }, cross = sent(), fail = false, onDelete = () => {} } = {}) {
  return { getToken: async ({ impersonate, scope }) => `${impersonate}|${scope}`, fetchImpl: async (url, options) => {
    const box = options.headers.Authorization.split(' ')[1].split('|')[0];
    const ok = value => ({ ok: true, status: 200, json: async () => value });
    if (fail) return { ok: false, status: 503 };
    if (options.method === 'DELETE') { onDelete(); return { ok: true, status: 204 }; }
    if (url.includes('/drafts/')) return ok(draft);
    if (url.includes('/threads/')) return ok({ messages: [] });
    if (url.includes('/messages?')) return ok({ messages: box === otherMailbox ? [{ id: 'sent' }] : [] });
    if (url.includes('/messages/sent')) return ok(cross);
    throw new Error(url);
  } };
}
test('両メールボックスで照合し理由を1回だけ記録、失敗時は一覧を維持', async t => {
  const home = homeFixture(t), item = analyzeDraft({ id: 'd', message: msg() }, { mailbox, now });
  const stats = {};
  assert.equal((await filterClearedDrafts([item], { home, now, deps: fakeClient(), stats })).length, 0);
  await filterClearedDrafts([item], { home, now, deps: fakeClient(), stats });
  assert.equal(clearedRecords(home).length, 1);
  assert.equal(stats.draftsChecked, stats.draftsCleared + stats.draftsKept);
  assert.equal((await filterClearedDrafts([item], { home, now, deps: fakeClient({ fail: true }), stats })).length, 1);
});
test('整理結果は日次1件のinfoと1件の承認askに集約する', async t => {
  const home = homeFixture(t), item = analyzeDraft({ id: 'd', message: msg() }, { mailbox, now });
  await filterClearedDrafts([item], { home, now, deps: fakeClient(), stats: {} });
  await notifyClearedDrafts(home, { now }); await notifyClearedDrafts(home, { now });
  assert.equal(listItems(home).filter(i => i.kind === 'info').length, 1);
  assert.equal(listItems(home).filter(i => i.kind === 'ask').length, 1);
});
test('削除は承認必須、本文を先に退避、更新済み下書きは保護、再実行で二重削除しない', async t => {
  const home = homeFixture(t), draft = { id: 'd', message: msg() }, item = analyzeDraft(draft, { mailbox, now });
  await filterClearedDrafts([item], { home, now, deps: fakeClient(), stats: {} });
  await assert.rejects(deleteClearedDrafts({ home, deps: fakeClient() }), /承認/);
  let deletes = 0;
  const deps = fakeClient({ onDelete: () => {
    const backup = JSON.parse(fs.readFileSync(path.join(home, '.claude/state/drafts-deleted-backup.jsonl'), 'utf8').trim());
    assert.deepEqual(backup.draft, draft); deletes++;
  } });
  const changed = await deleteClearedDrafts({ home, approvedBy: 'kim', deps: fakeClient({ draft: { ...draft, message: msg({ body: '更新' }) } }) });
  assert.equal(changed.changed, 1);
  const result = await deleteClearedDrafts({ home, approvedBy: 'kim', deps });
  assert.equal(result.deleted, 1); assert.equal(result.total, result.deleted + result.missing + result.changed + result.failed);
  await deleteClearedDrafts({ home, approvedBy: 'kim', deps }); assert.equal(deletes, 1);
});

test('9時台の通知失敗は10時にも再試行し、8時の変化は9時の定時報告を妨げない', async t => {
  const home = homeFixture(t), row = rowFixture(), patch = (_key, values) => Object.assign(row, values);
  await pushDailyProgress(home, row, { now: now - hour, patch });
  row.lastCheckOutput = '未達B';
  await pushDailyProgress(home, row, { now: now - hour + 1000, patch });
  assert.equal(row.progressDay, '');
  await assert.rejects(pushDailyProgress(home, row, { now, patch, io: { addKimInboxItem: async () => { throw new Error('offline'); } } }), /offline/);
  const item = await pushDailyProgress(home, row, { now: now + hour, patch });
  assert.ok(item.id); assert.equal(row.progressPending, false);
  assert.equal(row.progressDay, '2026-11-06');
});
test('完了した台帳の毎朝通知は翌朝の表示に復活しない', async t => {
  const home = homeFixture(t), row = rowFixture();
  const item = await pushDailyProgress(home, row, { now, patch: () => true });
  fs.writeFileSync(path.join(home, '.claude/auto-progress-ledger.jsonl'), JSON.stringify({ ...row, status: 'done' }) + '\n');
  assert.doesNotMatch(selectContext([item], { now: now + 24 * hour, sessionId: 'new', home }), /進捗・毎朝/);
});
test('台帳のフッター更新でも出力・比較履歴・再試行予定を引き継ぐ', async () => {
  const { applyPromise } = await import('./auto-progress-ledger.mjs');
  const row = { ...rowFixture(), check: 'exit 1', progressDay: '2026-11-06', progressPending: true, progressOutput: '前回', progressFingerprint: 'fp' };
  const next = applyPromise([row], { sessionId: row.sessionId, status: 'open', ts: new Date(now).toISOString(), promise: '続行' }).at(-1);
  for (const key of ['lastCheckOutput', 'progressDay', 'progressPending', 'progressOutput', 'progressFingerprint']) assert.equal(next[key], row[key]);
});
test('送信日時が欠損・不正なら送信済みと判定しない', () => {
  assert.equal(clearedReason(msg(), { ...sent(), internalDate: undefined }, true), null);
  assert.equal(clearedReason({ ...msg(), internalDate: 'invalid' }, sent(), false), null);
});
test('下書きページを最後まで取得し、循環トークンはエラーにする', async () => {
  const { allPages } = await import('./lib/drafts-auto-cleared.mjs');
  const routes = [];
  const drafts = await allPages(async route => { routes.push(route); return routes.length === 1 ? { drafts: [{ id: 'a' }], nextPageToken: 'next' } : { drafts: [{ id: 'b' }] }; }, '/drafts?maxResults=100', 'drafts');
  assert.deepEqual(drafts.map(i => i.id), ['a', 'b']); assert.match(routes[1], /pageToken=next/);
  await assert.rejects(allPages(async () => ({ nextPageToken: 'same' }), '/drafts?maxResults=100', 'drafts'), /循環/);
});
test('日次整理通知の失敗は記録を進めず、再試行で重複を作らない', async t => {
  const home = homeFixture(t), item = analyzeDraft({ id: 'd', message: msg() }, { mailbox, now });
  await filterClearedDrafts([item], { home, now, deps: fakeClient(), stats: {} });
  await assert.rejects(notifyClearedDrafts(home, { now, add: async () => ({ id: 'x', forwardError: 'offline' }) }), /offline/);
  assert.equal(clearedRecords(home).some(row => row.event === 'summary'), false);
  await notifyClearedDrafts(home, { now }); await notifyClearedDrafts(home, { now });
  assert.equal(listItems(home).filter(i => i.kind === 'info').length, 1);
});
test('実際のUserPromptSubmit CLIが既表示の毎朝通知を別セッションにも提示する', async t => {
  const { spawnSync } = await import('node:child_process');
  const home = homeFixture(t), row = rowFixture();
  const item = await pushDailyProgress(home, row, { now, patch: () => true });
  markSeen(home, item.id);
  const hook = session => {
    const run = spawnSync(process.execPath, [new URL('./kim-inbox.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--context'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session }), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home }, timeout: 30000,
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.additionalContext : '';
  };
  assert.match(hook('session-one'), /進捗・毎朝/);
  assert.doesNotMatch(hook('session-one'), /進捗・毎朝/);
  assert.match(hook('session-two'), /進捗・毎朝/);
});

test('機械宛ての下書きはAPI照合なしで除外し、理由を記録する', async t => {
  const home = homeFixture(t), draft = { id: 'freee', message: msg({ to: 'receipt@mail-receiver.freee.co.jp' }) };
  const item = analyzeDraft(draft, { mailbox, now, includeNonHuman: true });
  const stats = {};
  const items = await filterClearedDrafts([item], { home, now, stats, deps: { getToken: () => assert.fail('no API for machine recipient') } });
  assert.equal(items.length, 0);
  assert.equal(clearedRecords(home)[0].reason, '人でない宛先');
  assert.equal(stats.draftsChecked, stats.draftsCleared + stats.draftsKept);
});

test('整理対象が同件数で入れ替わっても承認askを更新し、前の返答を流用しない', async t => {
  const { answerItem } = await import('./kim-inbox.mjs');
  const home = homeFixture(t), first = analyzeDraft({ id: 'd1', message: msg() }, { mailbox, now });
  await filterClearedDrafts([first], { home, now, deps: fakeClient(), stats: {} });
  await notifyClearedDrafts(home, { now });
  const ask = listItems(home).find(item => item.kind === 'ask');
  answerItem(home, ask.id, '今回は削除しない');
  await notifyClearedDrafts(home, { now });
  assert.equal(listItems(home).find(item => item.id === ask.id).status, 'answered');
  const old = clearedRecords(home).find(row => row.event === 'cleared');
  fs.appendFileSync(path.join(home, '.claude/state/drafts-auto-cleared.jsonl'), JSON.stringify({ event: 'deleted', key: old.key }) + '\n');
  const next = analyzeDraft({ id: 'd2', message: msg({ id: 'm2' }) }, { mailbox, now });
  await filterClearedDrafts([next], { home, now, deps: fakeClient(), stats: {} });
  await notifyClearedDrafts(home, { now });
  const updated = listItems(home).find(item => item.id === ask.id);
  assert.equal(updated.text, ask.text); assert.equal(updated.status, 'open');
  assert.equal(updated.answer, null); assert.notEqual(updated.revision, ask.revision);
  assert.equal(listItems(home).filter(item => item.kind === 'ask').length, 1);
});
