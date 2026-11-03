import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolveProvider } from './cheap-code.mjs';
import { dayBounds, isMeeting, excludeCalendar, matchCase, routeCase, chooseTransport, eventKey, planJobs,
  createGoogle, loadEvents, loadCases, parseCases, loadMailUpdates, loadMeetEvents, inspectFleet, ensureCalendar, upsertPreparation, workspaceUrl, validateWrite, applySheetWrite, applyResult, parseAnswer, collectAnswers, dispatchJobs, renderPrompt,
  chooseExecution, collectRun, saveRunReport, runHeadless, localWorkerArgs, localWorkerEnv, loadLocalContext, LOCAL_JOB_TIMEOUT_MS } from './meeting-prep-dispatch.mjs';
const config = JSON.parse(fs.readFileSync(new URL('../config/meeting-prep-routing.json', import.meta.url)));
const date = '2026-11-03';
const event = (extra = {}) => ({ id: 'event1', iCalUID: 'ical1', calendarId: 'primary', summary: 'C1234 打合せ', start: { dateTime: `${date}T10:00:00+09:00` }, end: { dateTime: `${date}T11:00:00+09:00` }, ...extra });
const c = { id: 'C1234', name: '展示会準備', client: '顧客株式会社', email: 'a@client.example', phase: '制作中', planId: 'plan', folderId: 'folder' };
const map = { 'pc008': { hostname: 'DESKTOP-BDOAK99', remoteName: '作業用008' } };
const plan = (extra = {}) => planJobs({ events: [event()], cases: [c], date, config, pcMap: map, ...extra });
const receiver = { observedAt: new Date().toISOString(), accept: ['prompt', 'claude-resume'], hub: 'kim-PC', cwd: 'C:\\Users\\user\\.claude\\nightly-repo', mailAvailable: true, directiveAvailable: true };

test('JST日付境界・終日・辞退・移動・休暇・focusを除外', () => {
  assert.equal(dayBounds(date).timeMin, '2026-11-02T15:00:00.000Z');
  assert.throws(() => dayBounds('2026-02-30'));
  for (const e of [event({ start: { date } }), event({ status: 'cancelled' }), event({ summary: '移動' }), event({ summary: '有給休暇' }), event({ summary: '作業ブロック' }), event({ eventType: 'focusTime' }), event({ attendees: [{ self: true, responseStatus: 'declined' }] }), event({ attendees: [{ email: 'kim@orgiast.jp', responseStatus: 'declined' }] }), event({ start: { dateTime: '2026-11-02T14:59:59Z' } }), event({ start: { dateTime: '2026-11-03T15:00:00Z' } })]) assert.equal(isMeeting(e, date), false);
  assert.equal(isMeeting(event({ start: { dateTime: '2026-11-02T15:00:00Z' } }), date), true);
});
test('準備・祝日・Meet・提案枠カレンダー除外', () => {
  for (const summary of ['日本の祝日', 'Japan Holidays', '🎥 案件専用Meet', 'My proposed times', config.prepCalendarName]) assert.ok(excludeCalendar({ id: summary, summary }, config));
  assert.ok(excludeCalendar({ id: 'c_d8115960abc', summary: 'renamed' }, config));
  assert.ok(excludeCalendar({ id: 'prep', summary: 'renamed' }, config, { calendarId: 'prep' }));
  assert.equal(excludeCalendar({ id: 'primary', summary: 'kim' }, config), false);
});
test('案件照合はeventId→案件ID→案件名→顧客名・メール。曖昧一致は書き込まない', () => {
  assert.equal(matchCase(event(), [c]).case.id, c.id);
  assert.equal(matchCase(event({ summary: c.name }), [c]).reason, '案件名');
  assert.equal(matchCase(event({ summary: c.client }), [c]).reason, 'クライアント名');
  assert.equal(matchCase(event({ summary: '相談', attendees: [{ email: 'b@client.example' }] }), [c]).case.id, c.id);
  assert.equal(matchCase(event(), [c, { ...c, id: 'C9999', eventId: 'event1' }]).case.id, 'C9999');
  assert.equal(matchCase(event({ summary: '相談', attendees: [{ email: 'x@gmail.com' }] }), [{ ...c, email: 'y@gmail.com' }]).case, null);
  assert.equal(matchCase(event({ summary: c.client }), [c, { ...c, id: 'C9999' }]).case, null);
  assert.equal(matchCase(event({ summary: 'C12345 別案件' }), [c]).case, null);
});
test('seisaku主催/参加だけを014へ、未解決時008へ代行', () => {
  const booth = event({ organizer: { email: config.teamEmail } });
  const fallback = routeCase(booth, c, config, map);
  assert.equal(fallback.pc.label, 'pc008'); assert.equal(fallback.note, '014未解決のため008で代行');
  assert.equal(routeCase(booth, c, config, { ...map, pc014: { remoteName: '作業用014', hostname: 'host014' } }).pc.label, 'pc014');
  assert.equal(routeCase(booth, c, config, map, [{ label: '作業用014', hostname: 'host014' }]).pc.label, '作業用014');
  assert.equal(routeCase(event({ attendees: [{ email: config.teamEmail }] }), c, config, map).booth, true);
  assert.equal(routeCase(booth, null, config, map).booth, false);
  assert.equal(routeCase(event(), c, config, map).requested, '作業用008');
});
test('実コードのclaude-resume承諾とhub/cwdを満たすmail優先、promptのみはdirective', () => {
  assert.equal(chooseTransport(receiver).method, 'fleet-mail');
  assert.equal(chooseTransport({ ...receiver, accept: ['prompt'] }).method, 'fleet-directive');
  assert.equal(chooseTransport({ ...receiver, accept: ['prompt'], directiveAvailable: false }).method, null);
  assert.equal(chooseTransport({ ...receiver, observedAt: 'invalid' }).method, null);
  assert.equal(chooseTransport({ ...receiver, observedAt: '2020-01-01' }).method, 'fleet-mail');
  assert.equal(chooseTransport().method, null);
});
test('全カレンダーに複製された予定と同日再実行は重複しない。繰返し別回は区別', () => {
  const e = event(); const key = eventKey(e);
  assert.equal(plan({ events: [e, event({ calendarId: 'shared', id: 'other' })] }).length, 1);
  assert.equal(plan({ state: { sent: { [`${date}:${key}`]: 'batch' } } }).length, 0);
  assert.notEqual(eventKey(event({ start: { dateTime: '2026-11-04T10:00:00+09:00' } })), key);
});
test('日次レビューは進行中かつGmail更新あり、翌日打合せありは送信済みでも除外', () => {
  const updates = { C1234: { docId: 'doc', modifiedTime: '2026-11-02T02:00:00Z' } };
  assert.equal(plan({ events: [], updates })[0].kind, 'review');
  assert.equal(plan({ events: [], updates, state: { reviewed: { C1234: updates.C1234.modifiedTime } } }).length, 0);
  assert.equal(plan({ events: [], updates, cases: [{ ...c, phase: '完了' }] }).length, 0);
  assert.equal(plan({ events: [], updates, cases: [{ ...c, phase: '失注' }] }).length, 0);
  assert.equal(plan({ updates, state: { sent: { [`${date}:${eventKey(event())}`]: 'batch' } } }).length, 0);
  assert.equal(plan({ events: [], updates: {} }).length, 0);
});
test('APIページングとdry-runの書込禁止をAPI層で検証', async () => {
  let calls = 0;
  const google = createGoogle({ dryRun: true, token: async () => 'fake', fetchImpl: async url => ({ ok: true, status: 200, json: async () => ++calls === 1 ? { items: [1], nextPageToken: 'next' } : (assert.match(url, /pageToken=next/), { items: [2] }) }) });
  assert.deepEqual(await google.pages('calendar.events', 'https://example.test/list'), [1, 2]);
  await assert.rejects(google.request('calendar.events', 'https://example.test/list', 'POST', {}), /write blocked/);
  assert.equal(calls, 2);
});
test('calendarListの全対象を読み、取得失敗を空予定として隠さない', async () => {
  const calls = [];
  const g = { pages: async (_, url) => { calls.push(url); if (url.includes('calendarList')) return [{ id: 'one', summary: 'one' }, { id: 'two', summary: 'two' }, { id: 'holiday', summary: '祝日' }]; if (url.includes('/two/')) throw Error('403'); return [event()]; } };
  const data = await loadEvents(g, config, {}, date);
  assert.equal(data.events.length, 1); assert.equal(data.errors.length, 1); assert.equal(calls.length, 3);
});
function calendarMock() {
  const events = new Map(), calls = [];
  return { events, calls, pages: async () => [],
    request: async (scope, url, method = 'GET', body) => {
      assert.equal(scope, 'calendar.events');
      calls.push({ url, method, body });
      assert.match(url, /\/calendars\/(primary|prep)\/events/);
      assert.ok(!url.endsWith('/event1'), '元予定にはアクセスしない');
      const id = method === 'POST' ? body.id : url.split('/').at(-1);
      if (method === 'GET') { if (!events.has(id)) throw Object.assign(Error('404'), { status: 404 }); return events.get(id); }
      const result = { ...events.get(id), ...body }; events.set(id, result); return result;
    } };
}
test('準備予定を同じIDで更新し元予定を変更しない・read-back不一致検出', async () => {
  const g = calendarMock(), job = plan()[0];
  await upsertPreparation(g, 'primary', job, { summary: '初回' });
  await upsertPreparation(g, 'primary', job, { summary: '更新' });
  assert.equal(g.events.size, 1); assert.equal(g.calls.filter(c => c.method === 'POST').length, 1);
  assert.match([...g.events.values()][0].description, /更新/);
  assert.equal([...g.events.values()][0].extendedProperties.private.sourceEventId, 'event1');
  const prep = [...g.events.values()][0];
  assert.equal(prep.visibility, 'private'); assert.deepEqual(prep.attendees, []);
  assert.equal(prep.colorId, '8'); assert.equal(prep.transparency, 'transparent');
  assert.deepEqual(prep.reminders, { useDefault: false, overrides: [] });
  assert.equal(prep.summary, `📋 準備: ${job.event.summary}`);
  assert.deepEqual(prep.start, job.event.start); assert.deepEqual(prep.end, job.event.end);
  assert.equal(prep.extendedProperties.private.meetingPrepSourceId, job.event.id);
  assert.ok(g.calls.every(call => call.url.includes('/calendars/primary/events')));
  assert.equal(isMeeting(prep, date), false);
  await upsertPreparation(g, 'primary', { ...job, key: 'changed-case-or-time' });
  assert.equal(g.events.size, 1);
  await assert.rejects(upsertPreparation({ request: async () => ({ extendedProperties: { private: { meetingPrepSourceId: job.event.id, sourceCalendarId: job.event.calendarId } } }) }, 'prep', job), /read-back/);
});
test('送信前checkpoint・PCごと1通・再実行時二重送信なし', async () => {
  const state = {}, g = calendarMock(); let sends = 0, checkpoints = 0;
  const jobs = plan({ events: [event(), event({ id: 'event2', iCalUID: 'ical2', start: { dateTime: `${date}T14:00:00+09:00` }, end: { dateTime: `${date}T15:00:00+09:00` } })] });
  const args = { jobs, state, config, receivers: { pc008: receiver }, template: '{{PAYLOAD}}', google: g, checkpoint: () => checkpoints++, send: async batch => {
    assert.equal(state.batches[batch.id].status, 'sending'); assert.equal(Object.keys(state.sent).length, 2); sends++; return { id: 'mail-test' };
  } };
  await dispatchJobs(args); await dispatchJobs({ ...args, jobs: plan({ state, events: jobs.map(j => j.event) }) });
  assert.equal(sends, 1); assert.equal(g.events.size, 2); assert.ok(checkpoints >= 3);
});
test('送信応答消失でも対象を再送しない', async () => {
  const state = {};
  const g = calendarMock();
  const errors = await dispatchJobs({ jobs: plan(), state, config, receivers: { pc008: receiver }, template: '{{PAYLOAD}}', google: g, checkpoint() {}, send: async () => { throw Error('timeout'); } });
  assert.match(errors[0].error, /timeout/);
  assert.match([...g.events.values()][0].description, /状態: 失敗: timeout/);
  assert.equal(plan({ state }).length, 0);
  assert.equal(Object.values(state.batches)[0].status, 'sending');
});
test('過大本文でも準備予定へ失敗理由を残す', async () => {
  const g = calendarMock();
  const errors = await dispatchJobs({ jobs: plan(), state: {}, config, receivers: { pc008: receiver }, template: 'x'.repeat(20000), google: g, checkpoint() {}, send() { assert.fail(); } });
  assert.match(errors[0].error, /上限/);
  assert.match([...g.events.values()][0].description, /状態: 失敗/);
  assert.throws(() => renderPrompt('x'.repeat(20000), { id: 'b', pc: 'pc', jobs: [] }), /上限/);
});
test('Workspaceリンクにgid必須、外部サイト禁止', () => {
  assert.equal(workspaceUrl('https://docs.google.com/spreadsheets/d/x/edit#gid=3'), 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/x/edit#gid=3');
  assert.throws(() => workspaceUrl('https://docs.google.com/spreadsheets/d/x/edit'), /gid/);
  assert.throws(() => workspaceUrl('https://evil.test/x'), /Workspace/);
});
const write = (extra = {}) => ({ target: 'plan', tab: 'Claude_次回MTGアジェンダ', range: 'B2:B2', before: [['old']], values: [['new']], ...extra });
test('applierは範囲allowlistと寸法を検証しアイテムリスト/顧客回答を拒否', () => {
  assert.equal(validateWrite(write()).height, 1);
  for (const w of [write({ tab: 'アイテムリスト' }), write({ target: 'other' }), write({ range: "'アイテムリスト'!A1" }), write({ values: [] }), write({ target: 'confirmation', tab: '確認事項', range: 'E2:E2' })]) assert.throws(() => validateWrite(w));
});
test('applierは競合停止・書込後読戻し・同じ値の再適用は書込ゼロ', async () => {
  let values = [['old']], puts = 0;
  const g = { request: async (_, url, method = 'GET', body) => {
    if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 22 } }] };
    if (method === 'PUT') { values = body.values; puts++; return {}; } return { values };
  } };
  const link = await applySheetWrite(g, 'plan', write()); assert.match(link.url, /gid=22/);
  await applySheetWrite(g, 'plan', write()); assert.equal(puts, 1);
  values = [['human edit']]; await assert.rejects(applySheetWrite(g, 'plan', write()), /競合/); assert.equal(puts, 1);
});
test('新規デザインタブ作成後の障害からヘッダーを読み戻して再開', async () => {
  let sheet, headers, values; let created = 0;
  const g = { request: async (_, url, method = 'GET', body) => {
    if (url.includes('fields=sheets')) return { sheets: sheet ? [{ properties: sheet }] : [] };
    if (url.endsWith(':batchUpdate')) { sheet = { title: '制作物デザイン', sheetId: 7 }; created++; return {}; }
    const header = decodeURIComponent(url).includes('A1:F1');
    if (method === 'PUT') { if (header) headers = body.values; else values = body.values; return {}; }
    return { values: header ? headers : values };
  } };
  const w = write({ tab: '制作物デザイン', range: 'A2:A2', before: [['']], create: true });
  await applySheetWrite(g, 'plan', w); await applySheetWrite(g, 'plan', w);
  assert.equal(created, 1); assert.equal(headers[0][0], '制作物');
});
test('結果回収は差出人・replyTo・batchId・対象keyを照合し二度適用しない', async () => {
  const job = plan()[0], batch = { id: 'b', pc: 'pc008', method: 'fleet-mail', mailId: 'mail1', jobs: [job], completed: {} };
  const state = { calendarId: 'prep', batches: { b: batch } }, g = calendarMock();
  const answer = { version: 1, batchId: 'b', results: [{ key: job.key, status: 'ready', verified: true, summary: '議題', links: [{ label: 'agenda', url: 'https://docs.google.com/spreadsheets/d/plan/edit#gid=1' }] }] };
  const envelope = { from: 'pc008', replyTo: 'mail1', body: JSON.stringify(answer) };
  assert.deepEqual(await collectAnswers({ state, answers: [{ ...envelope, from: 'other' }], google: g, checkpoint() {} }), []); assert.equal(g.events.size, 0);
  await collectAnswers({ state, answers: [envelope, envelope], google: g, checkpoint() {} });
  assert.equal(batch.status, 'complete'); assert.equal(g.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(parseAnswer('```json\n' + envelope.body + '\n```').batchId, 'b');
});
test('未確認の結果は完了・日次レビューcursorを進めない', async () => {
  const job = plan({ events: [], updates: { C1234: { modifiedTime: '2026-11-02T00:00:00Z' } } })[0];
  const batch = { pc: 'pc008', method: 'fleet-directive', jobs: [job] }, state = { batches: { b: batch } };
  const body = JSON.stringify({ version: 1, batchId: 'b', results: [{ key: job.key, status: 'needsReview', summary: '未確認' }] });
  await collectAnswers({ state, answers: [{ from: 'pc008', body }], google: {}, checkpoint() {} });
  assert.equal(state.reviewed, undefined); assert.equal(batch.completed[job.key], undefined);
});
test('convergeは両タスクを登録・PowerShellはkim-PC限定/07:00/:40/非表示', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url), 'utf8'));
  for (const id of ['task:meeting-prep', 'task:meeting-prep-collect']) assert.deepEqual(manifest.items.find(x => x.id === id).repair, ['register-meeting-prep.mjs']);
  const ps = fs.readFileSync(new URL('./register-meeting-prep.ps1', import.meta.url), 'utf8');
  for (const re of [/COMPUTERNAME/, /kim-PC/, /-Daily -At '07:00'/, /AddMinutes\(40\)/, /-RepetitionInterval \(New-TimeSpan -Hours 1\)/, /New-HiddenScheduledTaskAction/, /read-back failed/]) assert.match(ps, re);
});
test('案件列を見出しで読み、ID・案件名がない表は拒否', async () => {
  const rows = [['案件ID', 'クライアント名', '案件名', '', '', '', '現在フェーズ', '', 'Drive フォルダID', '', '実施計画書ID', 'プロジェクトフォルダID', '顧客メール', '打合せイベントID'], ['C1234', 'Client', 'Case', '', '', '', '制作中', '', 'folder', '', 'plan', 'project', 'a@client.test', 'event1']];
  const result = await loadCases({ request: async () => ({ values: rows }) }, config);
  assert.equal(result[0].eventId, 'event1'); assert.equal(result[0].planId, 'plan');
  await assert.rejects(loadCases({ request: async () => ({ values: [['', '予算項目', '顧客名']] }) }, config), /ヘッダー不一致/);
});
test('追加APIなしでprimaryを選択し、旧カレンダーstateを置き換える', async () => {
  const state = { calendarId: 'legacy' }; let checkpoints = 0;
  const g = { pages() { assert.fail('calendar list/ACL不要'); }, request() { assert.fail('calendar作成不要'); } };
  assert.equal(await ensureCalendar(g, state, {}, () => checkpoints++), 'primary');
  assert.equal(state.calendarId, 'primary'); assert.equal(checkpoints, 1);
  assert.equal(excludeCalendar({ id: 'primary', summary: 'kim' }, config, state), false);
  assert.equal(excludeCalendar({ id: 'kim@orgiast.jp', primary: true, summary: 'kim' }, config, { calendarId: 'kim@orgiast.jp' }), false);
  assert.equal(await ensureCalendar(g, state, { prepCalendarId: 'custom' }, () => {}), 'custom');
});
test('DWD applierは返信の任意IDを使わず案件正本のplanIdへ書き込む', async () => {
  let values = [['old']]; const destinations = [];
  const g = { pages: async () => [], request: async (_, url, method = 'GET', body) => {
    destinations.push(url); if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 4 } }] };
    if (method === 'PUT') { values = body.values; return {}; } return { values };
  } };
  const result = await applyResult(g, plan()[0], { status: 'apply', summary: 'test', writes: [write({ spreadsheetId: 'evil' })] });
  assert.equal(result.status, 'ready'); assert.ok(destinations.every(u => u.includes('/plan')));
  await assert.rejects(applyResult(g, plan()[0], { writes: [write(), write()] }), /重複/);
});
test('案件未特定・保育園・名称非公開はskippedだけに残り配送しない', async () => {
  for (const extra of [{ summary: '保育園' }, { summary: '経営会議' }, { summary: undefined, description: 'C1234' }, { summary: '名称非公開', description: 'C1234' }]) {
    const skipped = [], jobs = plan({ events: [event(extra)], skipped });
    assert.equal(jobs.length, 0); assert.equal(skipped.length, 1); assert.equal(skipped[0].send, false); assert.equal(skipped[0].pc, null);
    let sends = 0;
    await dispatchJobs({ jobs, state: {}, config, receivers: { pc008: receiver }, template: '{{PAYLOAD}}', google: {}, checkpoint() {}, send() { sends++; } });
    assert.equal(sends, 0);
  }
});

test('列順・見出し前の行・営業一覧の別名を解決しエラーコードを除外', () => {
  const rows = [['タイトル'], ['案件名', 'Mail', '予算項目', 'ｺｰﾄﾞ', '実施計画URL', 'クライアント名'],
    ['展示会', 'a@example.test', '確定', '261102ABC', 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/plan-id/edit', '顧客'],
    ['未入力', '', '確定', '#REF!']];
  const [actual] = parseCases(rows);
  assert.equal(parseCases(rows).length, 1);
  assert.equal(actual.id, '261102ABC'); assert.equal(actual.planId, 'plan-id'); assert.equal(actual.phase, '確定');
  assert.equal(actual.email, 'a@example.test');
});
test('指定一覧を正本に、実施計画ID一致だけで制作側のイベントIDを補完', async () => {
  const g = { request: async (_, url) => ({ values: url.includes('/primary/')
    ? [['ｺｰﾄﾞ', '案件名', '予算項目', '実施計画URL'], ['261102ABC', '本案件', '確定', 'https://docs.google.com/spreadsheets/d/plan/edit'], ['261102DEF', '別案件', '確定', 'other']]
    : [['案件ID', '案件名', '実施計画書ID', '打合せイベントID'], ['C1234', '本案件', 'plan', 'meet-event']] }) };
  const rows = await loadCases(g, { caseSheetId: 'primary', caseDetailsSheetId: 'details' });
  assert.equal(rows.length, 2); assert.deepEqual(rows[0].aliasIds, ['C1234']); assert.equal(rows[0].eventId, 'meet-event'); assert.equal(rows[1].eventId, '');
});
test('専用MeetのURLを説明・場所・conferenceDataと結び、曖昧一致は送らない', () => {
  const meetEvents = [event({ description: 'C1234', hangoutLink: 'https://meet.google.com/abc-defg-hij' })];
  for (const extra of [{ description: '<a href="https://meet.google.com/abc-defg-hij?authuser=0">参加</a>' }, { location: 'https://meet.google.com/abc-defg-hij' }]) {
    const matched = matchCase(event({ summary: '相談', ...extra }), [c], meetEvents);
    assert.equal(matched.case.id, c.id); assert.equal(matched.reason, '案件専用Meet URL');
  }
  const other = { ...c, id: 'C9999' };
  assert.equal(matchCase(event({ summary: '相談', location: 'https://meet.google.com/abc-defg-hij' }), [c, other], [...meetEvents, event({ summary: '専用Meet', description: 'C9999', hangoutLink: 'https://meet.google.com/abc-defg-hij' })]).case, null);
  assert.equal(matchCase(event({ summary: '相談', location: 'C1234' }), [c]).case.id, c.id);
});
test('専用Meetカレンダーは時間範囲外の恒久URLも読み配送候補からは除外', async () => {
  const calls = [];
  const rows = await loadMeetEvents({ pages: async (_, url) => { calls.push(url); return [event()]; } }, config);
  assert.equal(rows.length, 1); assert.ok(calls[0].includes(encodeURIComponent(config.meetCalendarId))); assert.ok(!calls[0].includes('timeMin'));
});
test('日次レビューは更新順10案件まで、再実行も当日累計10件・超過は繰越', () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({ ...c, id: `C${2000 + i}` }));
  const updates = Object.fromEntries(cases.map((c, i) => [c.id, { modifiedTime: `2026-11-02T${String(i).padStart(2, '0')}:00:00Z` }]));
  const skipped = [], jobs = plan({ events: [], cases, updates, skipped });
  assert.equal(jobs.length, 10); assert.equal(jobs[0].case.id, 'C2011'); assert.equal(skipped.length, 2);
  const state = { batches: { first: { jobs, status: 'complete' } }, reviewed: Object.fromEntries(jobs.map(j => [j.case.id, j.update.modifiedTime])) };
  assert.equal(plan({ events: [], cases, updates, state }).length, 0);
  assert.equal(plan({ events: [], cases, updates, state, date: '2026-11-04' }).length, 2);
  assert.equal(plan({ events: [], hub: updates }).length, 0, 'ハブだけではレビューを起こさない');
});
test('Gmailは更新スレッドの過去本文も読み、同一スレッドは一度だけ取得', async () => {
  const now = Date.parse('2026-11-02T12:00:00Z'); let reads = 0;
  const google = {
    pages: async (scope, url, field) => { assert.equal(scope, 'gmail.readonly'); assert.equal(field, 'threads'); assert.match(url, /threads\?/); return [{ id: 'thread' }, { id: 'thread' }]; },
    request: async (scope, url) => {
      reads++; assert.equal(scope, 'gmail.readonly'); assert.match(url, /threads\/thread\?format=full/);
      return { messages: [
        { internalDate: String(now - 2 * 86400000), payload: { mimeType: 'text/plain', body: { data: Buffer.from('C1234 の古い本文').toString('base64url') } } },
        { internalDate: String(now - 1000), payload: { mimeType: 'text/plain', body: { data: Buffer.from('了解です').toString('base64url') } } }
      ] };
    }
  };
  const result = await loadMailUpdates({ cases: [c], config, until: now, google });
  assert.equal(reads, 1); assert.equal(result.updates.C1234.modifiedTime, new Date(now - 1000).toISOString());
  assert.equal(plan({ events: [], updates: result.updates, hub: {} }).length, 1);
});
test('Gmailカーソル後だけを見る・超過分を保持・API失敗を隠さない', async () => {
  const now = Date.parse('2026-11-02T12:00:00Z'), since = new Date(now - 60000).toISOString();
  const state = { lastReviewScan: since, reviewUpdates: { C1234: { modifiedTime: since } } };
  const google = { pages: async (_, url) => {
    assert.match(new URL(url).searchParams.get('q'), new RegExp(`after:${Math.floor(Date.parse(since) / 1000) - 1}`));
    return [{ id: 'old' }];
  }, request: async () => ({ messages: [{ internalDate: Date.parse(since), payload: { headers: [{ name: 'Subject', value: 'C1234' }] } }] }) };
  const result = await loadMailUpdates({ cases: [c], state, config, until: now, google });
  assert.deepEqual(result.updates, state.reviewUpdates);
  await assert.rejects(loadMailUpdates({ cases: [c], config, until: now, google: { pages: async () => { throw Error('403'); } } }), /403/);
});
test('GmailのDWDはseisaku-teamを代行し、threadsの全ページを読む', async () => {
  const auth = []; let pages = 0;
  const google = createGoogle({ dryRun: true, user: config.teamEmail, token: async args => { auth.push(args); return 'fake'; }, fetchImpl: async url => ({ ok: true, status: 200, json: async () => {
    if (url.includes('/threads?')) return ++pages === 1 ? { threads: [{ id: 'one' }], nextPageToken: 'next' } : (assert.match(url, /pageToken=next/), { threads: [{ id: 'two' }] });
    return { messages: [{ internalDate: Date.parse('2026-11-02T11:59:00Z'), payload: { headers: [{ name: 'Subject', value: 'C1234' }] } }] };
  } }) });
  const result = await loadMailUpdates({ cases: [c], config, until: Date.parse('2026-11-02T12:00:00Z'), google });
  assert.equal(result.threads, 2); assert.equal(auth.length, 1); assert.equal(auth[0].impersonate, config.teamEmail); assert.match(auth[0].scope, /gmail.readonly$/);
});
test('レビュー完了時だけGmail更新cursorを確定する', async () => {
  const job = plan({ events: [], updates: { C1234: { modifiedTime: '2026-11-02T00:00:00Z' } } })[0];
  const state = { batches: { b: { pc: 'pc008', method: 'fleet-directive', jobs: [job] } } };
  const body = JSON.stringify({ version: 1, batchId: 'b', results: [{ key: job.key, status: 'ready', verified: true, summary: '更新', links: [{ label: 'agenda', url: 'https://docs.google.com/spreadsheets/d/plan/edit#gid=1' }] }] });
  assert.deepEqual(await collectAnswers({ state, answers: [{ from: 'pc008', body }], google: {}, checkpoint() {} }), []);
  assert.equal(state.reviewed.C1234, job.update.modifiedTime);
});
test('opt-inは3状態、beaconだけを承諾と見なさずhomeを渡す', async () => {
  assert.equal(chooseTransport().optIn, '不明');
  assert.equal(chooseTransport({ ...receiver, accept: [] }).optIn, '未承諾');
  assert.equal(chooseTransport(receiver).optIn, 'opt-in 済み');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-prep-'));
  try {
    const fleet = await inspectFleet(home, { receivers: {} }, { fetchBeacons: async args => { assert.equal(args.home, home); return { ok: true, beacons: [{ label: 'pc008', steps: [{ id: 'task:fleet-agent', status: 'ok' }] }] }; } });
    assert.equal(chooseTransport(fleet.receivers.pc008).optIn, '不明');
    fs.mkdirSync(path.join(home, '.claude', 'fleet-inbox'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-inbox', 'mail-test.json'), JSON.stringify({ from: 'pc008', createdAt: new Date().toISOString(), body: JSON.stringify({ type: 'meeting-prep-receiver', label: 'pc008', accept: [] }) }));
    const denied = await inspectFleet(home, { receivers: { pc008: { ...receiver, observedAt: '2020-01-01' } } }, { fetchBeacons: async () => ({ ok: true, beacons: [] }) });
    assert.equal(chooseTransport(denied.receivers.pc008).optIn, '未承諾');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('配送直前も案件未特定・名称非公開を拒否', async () => {
  for (const job of [{ ...plan()[0], case: null }, { ...plan()[0], event: event({ summary: '名称非公開' }) }]) {
    await assert.rejects(dispatchJobs({ jobs: [job], state: {}, config, receivers: { pc008: receiver }, google: {}, send() { assert.fail(); } }), /配送禁止/);
  }
});

test('opt-in不明・未承諾・PC未解決はkim-PC、確認済みなら既存配送', () => {
  const route = plan()[0].route;
  for (const receivers of [{}, { pc008: { ...receiver, accept: [] } }, { pc008: { ...receiver, mailAvailable: false, directiveAvailable: false } }]) {
    const selected = chooseExecution(route, receivers);
    assert.equal(selected.method, 'local'); assert.match(selected.executedOn, /^kim-PC\(fallback: /);
  }
  assert.equal(chooseExecution({ requested: '作業用014' }).method, 'local');
  assert.equal(chooseExecution(route, { pc008: receiver }).method, 'fleet-mail');
});
test('異なるUIDでも案件と実時刻が同じなら1ジョブ、別時刻・別案件は別ジョブ', () => {
  const events = [event(), event({ id: 'two', iCalUID: 'another', summary: 'C1234', start: { dateTime: `${date}T01:00:00Z` }, organizer: { email: config.teamEmail } })];
  const [job] = plan({ events });
  assert.equal(plan({ events }).length, 1); assert.equal(job.sources.length, 2); assert.equal(job.route.booth, true);
  assert.equal(plan({ events: events.toReversed() })[0].key, job.key);
  assert.equal(plan({ events, state: { sent: { [`${date}:${eventKey(events[1])}`]: 'old' } } }).length, 0);
  assert.equal(plan({ events, state: { sent: { [`${date}:${job.key}`]: 'new' } } }).length, 0);
  assert.equal(plan({ events: [...events, event({ id: 'three', iCalUID: 'three', start: { dateTime: `${date}T11:00:00+09:00` } })] }).length, 2);
  assert.equal(plan({ cases: [c, { ...c, id: 'C9999' }], events: [...events, event({ id: 'four', iCalUID: 'four', summary: 'C9999' })] }).length, 2);
});
test('ローカル失敗でも全打合せに準備予定があり、次ジョブを実行する', async () => {
  const state = {}, g = calendarMock(); let runs = 0;
  const jobs = plan({ events: [event(), event({ id: 'two', start: { dateTime: `${date}T12:00:00+09:00` } })] });
  const errors = await dispatchJobs({ jobs, state, config, receivers: {}, template: '{{PAYLOAD}}', google: g, checkpoint() {},
    send() { assert.fail('remote送信禁止'); }, runLocal: async (batch, body) => {
      assert.equal(g.events.size, 2); runs++;
      assert.match([...g.events.values()][runs - 1].description, /状態: 準備中/);
      assert.equal(JSON.parse(body).batchId, batch.id);
      assert.match(batch.executedOn, /^kim-PC\(fallback: /);
      throw new Error('worker failure');
    } });
  assert.equal(runs, 2); assert.equal(errors.length, 2);
  assert.ok(Object.values(state.batches).every(b => b.status === 'failed'));
  for (const e of g.events.values()) {
    assert.match(e.description, /状態: 失敗: worker failure/);
    for (const label of ['実施計画書', '確認シート', '提出フォーマット', '制作フォルダ', 'アジェンダ', 'kim-PC(fallback:']) assert.ok(e.description.includes(label));
  }
});
test('primaryの準備予定をworker失敗より先に作る', async () => {
  const g = calendarMock();
  await dispatchJobs({ jobs: plan(), state: {}, config, template: '{{PAYLOAD}}', google: g, checkpoint() {}, runLocal() { assert.equal(g.events.size, 1); throw Error('failed'); } });
  assert.equal(g.events.size, 1);
  assert.ok(g.calls.every(call => call.url.includes('/calendars/primary/events')));
});
test('ローカルJSONをDWD applierで適用し、リンク・要約を完了予定に更新', async () => {
  const g = calendarMock(), request = g.request, state = {}; let values = [['old']], puts = 0;
  g.request = async (scope, url, method, body) => {
    if (url.includes('sheets.googleapis.com')) {
      if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 42 } }] };
      if (method === 'PUT') { puts++; values = body.values; }
      return { values };
    }
    return request(scope, url, method, body);
  };
  const errors = await dispatchJobs({ jobs: plan(), state, config, template: '{{PAYLOAD}}', google: g, checkpoint() {},
    runLocal: async batch => JSON.stringify({ result: JSON.stringify({ version: 1, batchId: batch.id, results: [{ key: batch.jobs[0].key, status: 'apply', summary: '新しい議題', writes: [write()] }] }) }) });
  assert.deepEqual(errors, []); assert.equal(puts, 1); assert.equal(Object.values(state.batches)[0].status, 'complete');
  const description = [...g.events.values()][0].description;
  assert.match(description, /状態: 完了/); assert.match(description, /新しい議題/); assert.match(description, /アジェンダ: https:.*#gid=42/);
  const result = await collectRun({ home: os.tmpdir(), state, fleet: { inbox: [] }, google: g, config, checkpoint() {} });
  assert.equal(result.exitCode, 0); assert.equal(puts, 1);
});
test('ローカルready偽装や別batchのJSONは適用しない', async () => {
  for (const invalid of ['ready', 'batch']) {
    const g = calendarMock(), state = {};
    const errors = await dispatchJobs({ jobs: plan(), state, config, template: '{{PAYLOAD}}', google: g, checkpoint() {}, runLocal: async batch => JSON.stringify({ version: 1, batchId: invalid === 'batch' ? 'other' : batch.id,
      results: [{ key: batch.jobs[0].key, status: invalid === 'ready' ? 'ready' : 'apply', summary: 'bad', verified: true, links: [] }] }) });
    assert.match(errors[0].error, /ローカル結果/); assert.equal(Object.values(state.batches)[0].status, 'failed');
  }
});
test('collectは無関係な4000通を黙って無視し、fleet認証なしでもexit 0', async () => {
  const inbox = Array.from({ length: 4000 }, (_, i) => ({ from: 'other', why: '配布通知・判断依頼', body: i % 2 ? 'not JSON' : '{broken', id: `mail-${i}` }));
  inbox.push({ from: 'other', body: '{"version":1,"batchId":"unknown","results":[]}' });
  const result = await collectRun({ home: path.join(os.tmpdir(), 'meeting-prep-no-credentials'), state: {}, fleet: { inbox }, google: {}, config, checkpoint() {} });
  assert.equal(result.exitCode, 0); assert.equal(result.results, 0); assert.deepEqual(result.errors, []);
});
test('collectはwhy/本文マーカー/既知batchだけを解析し、本当の不正結果はexit 1', async () => {
  for (const mail of [{ why: 'meeting-prep result b', body: '{bad' }, { body: '[meeting-prep result]\n{bad' }, { body: '{"batchId":"b", "version":1, "results":null}' }]) {
    const result = await collectRun({ home: os.tmpdir(), state: { batches: { b: { pc: 'pc008', method: 'fleet-directive', jobs: [] } } }, fleet: { inbox: [{ from: 'pc008', ...mail }] }, google: {}, config, checkpoint() {} });
    assert.equal(result.exitCode, 1); assert.equal(result.errors.length, 1);
  }
});
test('collectのmail-get結果が不正でもmeeting-prepエラーとして検出', async () => {
  const state = { batches: { b: { pc: 'pc008', method: 'fleet-mail', mailId: 'mail-b', jobs: [] } } };
  const result = await collectRun({ home: os.tmpdir(), state, fleet: { inbox: [] }, google: {}, config, checkpoint() {}, request: async () => ({ ok: true, mail: { id: 'mail-b', to: 'pc008', status: 'done', resultBody: 'invalid JSON' } }) });
  assert.equal(result.exitCode, 1);
});
test('ローカルはstdin・nightly cwd・非表示・tools/MCPなし、タイムアウトで子を終了', async () => {
  assert.equal(LOCAL_JOB_TIMEOUT_MS, 900000);
  const args = localWorkerArgs('deepseek-model'), controller = new AbortController(); let killed = 0, input = '';
  assert.ok(args.includes('-p')); assert.ok(args.includes('--strict-mcp-config')); assert.equal(args[args.indexOf('--tools') + 1], '');
  const result = runHeadless('claude.exe', args, { cwd: 'nightly-repo', prompt: 'PRIVATE PROMPT', signal: controller.signal,
    spawnImpl: (command, argv, options) => {
      assert.equal(command, 'claude.exe'); assert.ok(!argv.includes('PRIVATE PROMPT')); assert.equal(options.cwd, 'nightly-repo'); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
      child.stdin.on('data', c => { input += c; }); return child;
    }, killTree() { killed++; } });
  controller.abort(new Error('15分上限'));
  await assert.rejects(result, /15分/); assert.equal(killed, 1); assert.equal(input, 'PRIVATE PROMPT');
});
test('ローカル時間上限の後も次ジョブへ進む', async () => {
  let runs = 0;
  const errors = await dispatchJobs({ jobs: plan({ events: [], cases: [c, { ...c, id: 'C9999' }], updates: { C1234: { modifiedTime: '2026-11-02' }, C9999: { modifiedTime: '2026-11-02' } } }), state: {}, config, google: {}, template: '{{PAYLOAD}}', checkpoint() {}, timeoutMs: 5,
    runLocal: (batch, body, { signal }) => { runs++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  assert.equal(runs, 2); assert.equal(errors.length, 2); assert.ok(errors.every(e => /15分/.test(e.error)));
});
test('DWDジョブ中断後は追加書込を行わない', async () => {
  const controller = new AbortController(); let calls = 0;
  const google = createGoogle({ token: async () => 'fake', fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; } }).withSignal(controller.signal);
  controller.abort(new Error('timeout'));
  await assert.rejects(google.request('spreadsheets', 'https://example.test', 'PUT', {}), /timeout/); assert.equal(calls, 0);
});
test('実行ログは要約1行、詳細JSONに全件とexitCodeを保存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-prep-runs-')), output = [];
  try {
    const report = { dryRun: true, targets: [{ executedOn: 'kim-PC(fallback: 不明)' }], errors: [{ error: 'failure\nline2' }] };
    assert.equal(saveRunReport(dir, report, 1, line => output.push(line)), 1);
    assert.equal(output.length, 1); assert.equal(output[0].split('\n').length, 1);
    const summary = JSON.parse(output[0]), detail = JSON.parse(fs.readFileSync(summary.details, 'utf8'));
    assert.equal(summary.errors, 1); assert.deepEqual(detail.targets, report.targets); assert.equal(detail.exitCode, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('GLM/DeepSeekのCLI環境は親のClaude API/modelを引き継がない', () => {
  for (const name of ['glm', 'deepseek']) {
    const provider = resolveProvider(name);
    const env = localWorkerEnv(provider, 'fake-key', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'parent-key', ANTHROPIC_MODEL: 'claude-parent', CLAUDECODE: 'parent' }, 'isolated-worker');
    assert.equal(env.ANTHROPIC_BASE_URL, provider.base); assert.ok(!env.ANTHROPIC_BASE_URL.includes('api.anthropic.com'));
    assert.notEqual(env.ANTHROPIC_API_KEY, 'parent-key'); assert.equal(env.CLAUDE_CONFIG_DIR, 'isolated-worker');
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[key], provider.defaultModel);
  }
});
test('ローカル資料はDWDのGETで読み、既存回答とハブ・連絡本文を渡す', async () => {
  const calls = [], job = { ...plan()[0], hub: { docId: 'hub-doc' } };
  const google = { pages: async () => [{ id: 'confirmation', name: '確認シート', mimeType: 'application/vnd.google-apps.spreadsheet' }, { id: 'contact', name: '外部連絡', mimeType: 'application/vnd.google-apps.document' }],
    request: async (scope, url, method = 'GET') => {
      assert.equal(method, 'GET'); calls.push({ scope, url });
      if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: '確認事項', sheetId: 3 } }] };
      if (url.includes('/values/')) return { values: [['ID', '', '', '確認', '既存回答']] };
      return { body: { content: [{ paragraph: { elements: [{ textRun: { content: '最新連絡' } }] } }] } };
    } };
  const mailGoogle = { pages: async () => [{ id: 'thread' }], request: async () => ({ messages: [{ internalDate: '123', payload: { mimeType: 'text/plain', body: { data: Buffer.from('C1234 最新情報').toString('base64url') } } }] }) };
  const context = await loadLocalContext(google, job, config, { mailGoogle });
  assert.equal(context.sheets.confirmation.tabs['確認事項'].values[0][4], '既存回答');
  assert.equal(context.documents.length, 2); assert.match(context.mail[0].messages[0].body, /最新情報/);
  assert.ok(context.unconfirmed.some(x => /submission/.test(x))); assert.ok(calls.some(c => c.url.endsWith('/hub-doc')));
});
test('CLIのis_errorや不正なresultsを成功として受け取らない', () => {
  assert.throws(() => parseAnswer('{"is_error":true,"result":"{\\"version\\":1,\\"batchId\\":\\"b\\",\\"results\\":[]}"}'), /実行エラー/);
  assert.throws(() => parseAnswer('{"version":1}'), /不正/);
});
test('Docsは承認済みDriveスコープで認証する', async () => {
  const scopes = [];
  const google = createGoogle({ token: async args => { scopes.push(args.scope); return 'fake'; }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await google.request('documents', 'https://docs.googleapis.com/v1/documents/test');
  await google.request('documents', 'https://docs.googleapis.com/v1/documents/test:batchUpdate', 'POST', {});
  assert.deepEqual(scopes, ['https://www.googleapis.com/auth/drive']);
});
test('ACL APIなしで全workerを実行する', async () => {
  const g = calendarMock(); let runs = 0;
  g.pages = async () => { assert.fail('カレンダー/ACL列挙不要'); };
  const jobs = plan({ events: [event(), event({ id: 'two', start: { dateTime: `${date}T12:00:00+09:00` } })] });
  const errors = await dispatchJobs({ jobs, state: {}, config, template: '{{PAYLOAD}}', google: g, checkpoint() {}, runLocal() { runs++; throw Error('worker-failed'); } });
  assert.equal(runs, 2); assert.equal(g.events.size, 2); assert.equal(errors.length, 2);
});
