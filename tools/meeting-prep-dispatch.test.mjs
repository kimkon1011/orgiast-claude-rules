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
  chooseExecution, collectRun, saveRunReport, runHeadless, localWorkerArgs, localWorkerEnv, loadLocalContext, loadCaseMail, filterResultUrls, buildLocalInput, dryRunPlanningState, LOCAL_JOB_TIMEOUT_MS } from './meeting-prep-dispatch.mjs';
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
    assert.equal(state.batches[batch.id].status, 'sending'); assert.equal(Object.keys(state.sent).length, 0); sends++; return { id: 'mail-test' };
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
test('専用タブはbefore不要で全置換・読戻し・同じ値の再適用は書込ゼロ', async () => {
  let values = [['old']], puts = 0;
  const g = { request: async (_, url, method = 'GET', body) => {
    if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 22 } }] };
    if (method === 'PUT') { values = body.values; puts++; return {}; } return { values };
  } };
  const link = await applySheetWrite(g, 'plan', write()); assert.match(link.url, /gid=22/);
  await applySheetWrite(g, 'plan', write()); assert.equal(puts, 1);
  values = [['human edit']]; await applySheetWrite(g, 'plan', write()); assert.equal(puts, 2);
  assert.equal(values[1][1], 'new');
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
  assert.equal(created, 1); assert.equal(values[0][0], '制作物');
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
  assert.equal(result.operations[0].readBack.verified, true);
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
  const state = {}; let runs = 0;
  const errors = await dispatchJobs({ jobs: plan({ events: [], cases: [c, { ...c, id: 'C9999' }], updates: { C1234: { modifiedTime: '2026-11-02' }, C9999: { modifiedTime: '2026-11-02' } } }), state, config, google: {}, template: '{{PAYLOAD}}', checkpoint() {}, timeoutMs: 5,
    runLocal: (batch, body, { signal }) => { runs++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  assert.equal(runs, 2); assert.equal(errors.length, 2); assert.ok(errors.every(e => /15分/.test(e.error)));
  assert.deepEqual(state.sent, {}); assert.equal(Object.keys(state.failed).length, 2);
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
test('ローカル資料はDWDのGETで読み、既存回答とハブを取得しフォルダ本文は取得しない', async () => {
  const calls = [], job = { ...plan()[0], hub: { docId: 'hub-doc' } };
  const google = { pages: async () => [{ id: 'confirmation', name: '確認シート', mimeType: 'application/vnd.google-apps.spreadsheet' }, { id: 'contact', name: '外部連絡', mimeType: 'application/vnd.google-apps.document' }],
    request: async (scope, url, method = 'GET') => {
      assert.equal(method, 'GET'); calls.push({ scope, url });
      if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: '確認事項', sheetId: 3 } }] };
      if (url.includes('/values/')) return { values: [['ID', '', '', '確認', '既存回答']] };
      assert.match(url, /files\/hub-doc\/export\?mimeType=text%2Fplain/); return '最新連絡';
    } };
  const mailGoogle = { pages: async () => [{ id: 'thread' }], request: async () => ({ messages: [{ internalDate: '123', payload: { mimeType: 'text/plain', body: { data: Buffer.from('C1234 最新情報').toString('base64url') } } }] }) };
  const context = await loadLocalContext(google, job, config, { mailGoogle });
  assert.equal(context.sheets.confirmation.tabs['確認事項'].values[0][4], '既存回答');
  assert.equal(context.documents.length, 1); assert.deepEqual(context.mail, []); assert.equal(context.documents[0].text, '最新連絡');
  assert.ok(!calls.some(c => c.url.endsWith('/contact')));
  assert.ok(context.truncated.some(x => /資料本文/.test(x)));
  assert.ok(context.unconfirmed.some(x => /submission/.test(x))); assert.ok(calls.some(c => c.url.includes('/hub-doc/export')));
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


test('巨大入力を優先順で予算内に収めて実行し省略を記録する', async () => {
  const state = {}, g = calendarMock();
  const context = { documents: [{ id: 'hub', document: { body: { content: [{ paragraph: { elements: [{ textRun: { content: '最新ハブ情報' } }] } }] } } }],
    sheets: { plan: { id: 'plan', tabs: { Task: { gid: 0, values: Array.from({ length: 200 }, (_, i) => [i, 'x'.repeat(10000)]) } } },
      confirmation: { id: 'confirm', tabs: { 確認事項: { values: [['状態', '内容'], ['未完了', 'LOW_PRIORITY']] } } } }, files: [{ id: 'file', name: '資料', body: 'DO_NOT_INCLUDE' }] };
  let ran = false;
  const errors = await dispatchJobs({ jobs: plan(), state, config, template: '{{PAYLOAD}}', google: g, checkpoint() {},
    runLocal: async (batch, body) => {
      const input = buildLocalInput(batch, body, context, { localInputBudgetChars: 12000 });
      ran = true;
      assert.ok(input.inputChars <= 12000);
      assert.match(input.prompt, /C1234 打合せ/);
      assert.match(input.prompt, /最新ハブ情報/);
      assert.match(input.prompt, /xxxxxxxxxx/);
      assert.ok(input.prompt.indexOf('予定情報') < input.prompt.indexOf('案件情報ハブ'));
      assert.ok(input.prompt.indexOf('案件情報ハブ') < input.prompt.indexOf('plan\/Task'));
      assert.match(input.prompt, /省略: .*plan\/Task/);
      assert.doesNotMatch(input.prompt, /DO_NOT_INCLUDE/);
      return JSON.stringify({ version: 1, batchId: batch.id, results: [{ key: batch.jobs[0].key, status: 'needsReview', summary: '確認待ち' }] });
    } });
  assert.ok(ran); assert.equal(errors.length, 1); assert.equal(errors[0].error, '確認待ち');
  const batch = Object.values(state.batches)[0];
  assert.ok(batch.inputChars <= 12000); assert.ok(batch.truncated.some(x => /plan\/Task/.test(x)));
});
test('ハブ直近30件・空行除外・未完了行の元行番号を維持', () => {
  const entries = Array.from({ length: 40 }, (_, i) => `[hub:${'a'.repeat(64)}:2026-10-${String(i % 30 + 1).padStart(2, '0')}T00:00:00Z]\nentry${i}\n`).join('');
  const batch = { jobs: plan() };
  const input = buildLocalInput(batch, '', { documents: [{ id: 'hub', document: { textRun: { content: entries } } }], sheets: {
    confirmation: { id: 'confirm', tabs: { 確認事項: { values: [['状態', '内容'], ['完了', 'DONE_ROW'], [], ['未完了', 'OPEN_ROW']] } } }
  } });
  assert.equal((input.prompt.match(/\[hub:/g) || []).length, 30);
  assert.doesNotMatch(input.prompt, /DONE_ROW/); assert.match(input.prompt, /"row":4,"values":\["未完了","OPEN_ROW"\]/);
  assert.ok(input.truncated.some(x => /直近30件/.test(x)));
});
test('巨大な予定説明も切り詰め、必須指示だけで超過した場合は項目名付きで失敗', () => {
  const batch = { jobs: [{ ...plan()[0], event: event({ description: 'long'.repeat(100000) }) }] };
  const input = buildLocalInput(batch, 'instructions', {}, { localInputBudgetChars: 2000 });
  assert.ok(input.inputChars <= 2000); assert.match(input.prompt, /C1234 打合せ/);
  assert.ok(input.truncated.some(x => /予定情報/.test(x)));
  assert.throws(() => buildLocalInput(batch, 'instructions', {}, { localInputBudgetChars: 10 }), /省けなかった項目/);
});

test('dry-runは失敗ローカルの入力を再計測し永続claimと成功済み・送信中は維持', () => {
  const state = { sent: { a: 'failed', b: 'sent', c: 'done' }, batches: {
    failed: { id: 'failed', method: 'local', status: 'failed' }, sent: { id: 'sent', method: 'fleet-mail', status: 'sent' }, done: { id: 'done', method: 'local', status: 'complete' }
  } };
  assert.deepEqual(dryRunPlanningState(state).sent, { b: 'sent', c: 'done' });
  assert.equal(state.sent.a, 'failed');
  assert.ok(state.batches.failed); assert.equal(dryRunPlanningState(state).batches.failed, undefined);
});
test('予算超過の省けなかった項目名が準備予定にも残る', async () => {
  const g = calendarMock();
  const errors = await dispatchJobs({ jobs: plan(), state: {}, config, template: '{{PAYLOAD}}', google: g, checkpoint() {},
    runLocal: async (batch, body) => buildLocalInput(batch, body, {}, { localInputBudgetChars: 1 }) });
  assert.match(errors[0].error, /省けなかった項目/);
  assert.match([...g.events.values()][0].description, /省けなかった項目: 実行指示/);
});

test('巨大ハブは最新本文を部分保持し、低優先のシートより先に予算を使う', () => {
  const input = buildLocalInput({ jobs: plan() }, '', {
    documents: [{ id: 'hub', document: { textRun: { content: 'HUB_FIRST' + 'h'.repeat(1000000) } } }],
    sheets: { plan: { id: 'plan', tabs: { Task: { values: [['LOW_PRIORITY_CELL']] } } } }
  }, { localInputBudgetChars: 4000 });
  assert.ok(input.inputChars <= 4000); assert.match(input.prompt, /HUB_FIRST/);
  assert.doesNotMatch(input.prompt, /LOW_PRIORITY_CELL/);
  assert.ok(input.truncated.some(x => /案件情報ハブ: 入力予算/.test(x)));
  assert.ok(input.truncated.some(x => /plan\/Task: 入力予算/.test(x)));
});

test('失敗はsentに入らず30分後に再試行、1日3回で停止する', async () => {
  const state = {}, g = calendarMock(); let runs = 0;
  const run = now => dispatchJobs({ jobs: plan(), state, config, google: g, template: '{{PAYLOAD}}', checkpoint() {}, now,
    runLocal() { runs++; throw Error('retry failure'); } });
  await run('2026-11-03T07:00:00+09:00');
  assert.deepEqual(state.sent, {});
  assert.equal(Object.values(state.failed)[0].attempts, 1);
  assert.equal(Object.values(state.failed)[0].lastError, 'retry failure');
  await run('2026-11-03T07:29:59+09:00'); assert.equal(runs, 1);
  await run('2026-11-03T07:30:00+09:00'); assert.equal(runs, 2);
  assert.match([...g.events.values()][0].description, /状態: 再試行 2\/3/);
  await run('2026-11-03T08:00:00+09:00'); assert.equal(runs, 3);
  await run('2026-11-03T08:30:00+09:00'); assert.equal(runs, 3);
  assert.equal(Object.values(state.failed)[0].attempts, 3);
});
test('開始時刻以降は再試行せず、JST翌日は回数をリセットする', async () => {
  for (const [now, expected] of [['2026-11-03T10:00:00+09:00', 0], ['2026-11-03T10:01:00+09:00', 0], ['2026-11-03T07:00:00+09:00', 1]]) {
    const job = plan()[0], key = `${job.date}:${job.key}`, state = { failed: { [key]: { job, attempts: 3, day: '2026-11-02', lastAttemptAt: '2026-11-02T23:30:00+09:00' } } }; let runs = 0;
    await dispatchJobs({ jobs: [], state, config, google: calendarMock(), template: '{{PAYLOAD}}', checkpoint() {}, now,
      runLocal() { runs++; throw Error('failed'); } });
    assert.equal(runs, expected);
    if (expected) assert.equal(state.failed[key].attempts, 1);
  }
});
test('旧sentの失敗を移行しcollectでも再試行する。成功は維持', async () => {
  const job = plan()[0], key = `${job.date}:${job.key}`, state = { sent: { [key]: 'old', successful: 'success' }, batches: {
    old: { id: 'old', method: 'local', status: 'failed', createdAt: '2026-11-03T07:00:00+09:00', error: 'timeout', jobs: [job] },
    success: { id: 'success', status: 'complete', jobs: [] }
  } }; let runs = 0;
  const run = now => collectRun({ home: os.tmpdir(), state, fleet: { inbox: [] }, google: calendarMock(), config, checkpoint() {}, now,
    template: '{{PAYLOAD}}', runLocal() { runs++; throw Error('again'); } });
  await run('2026-11-03T07:20:00+09:00');
  assert.equal(state.sent[key], undefined); assert.equal(state.sent.successful, 'success');
  assert.equal(state.failed[key].attempts, 1); assert.equal(runs, 0);
  await run('2026-11-03T07:30:00+09:00'); assert.equal(runs, 1); assert.equal(state.failed[key].attempts, 2);
  await run('2026-11-03T07:40:00+09:00'); assert.equal(runs, 1); assert.equal(state.failed[key].attempts, 2);
});
test('collect再試行の成功でfailedを消し、過去の失敗で予定を上書きしない', async () => {
  const g = calendarMock(), request = g.request; let values = [['old']];
  g.request = async (scope, url, method, body) => {
    if (url.includes('sheets.googleapis.com')) {
      if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 42 } }] };
      if (method === 'PUT') values = body.values;
      return { values };
    }
    return request(scope, url, method, body);
  };
  const state = {};
  await dispatchJobs({ jobs: plan(), state, config, google: g, template: '{{PAYLOAD}}', checkpoint() {}, now: '2026-11-03T07:00:00+09:00', runLocal() { throw Error('timeout'); } });
  const result = await collectRun({ home: os.tmpdir(), state, fleet: { inbox: [] }, google: g, config, checkpoint() {}, now: '2026-11-03T07:30:00+09:00', template: '{{PAYLOAD}}',
    runLocal: async batch => JSON.stringify({ version: 1, batchId: batch.id, results: [{ key: batch.jobs[0].key, status: 'apply', summary: '復旧', writes: [write()] }] }) });
  assert.equal(result.exitCode, 0, JSON.stringify(result.errors)); assert.deepEqual(state.failed, {}); assert.equal(Object.keys(state.sent).length, 1);
  await collectRun({ home: os.tmpdir(), state, fleet: { inbox: [] }, google: g, config, checkpoint() {}, now: '2026-11-03T08:00:00+09:00', runLocal() { assert.fail('成功済み'); } });
  assert.match([...g.events.values()][0].description, /完了/);
});


test('外部参考URLを適用し、成果物リンクと危険URLの項目だけ拒否する', async () => {
  let values = [['old']];
  const g = { pages: async () => [], request: async (_, url, method, body) => {
    if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 22 } }] };
    if (method === 'PUT') values = body.values;
    return { values };
  } };
  const reference = '背景 https://peatix.com/event/123 参考 https://timerex.net/r/example https://company.example';
  const result = await applyResult(g, plan()[0], { status: 'apply', summary: '確認事項',
    links: [{ label: '外部成果物', url: 'https://evil.example/out' }, { label: '計画書', url: 'https://docs.google.com/spreadsheets/d/plan/edit#gid=22' }],
    writes: [write({ values: [[reference]] }), write({ range: 'B3:B3', values: [['javascript:alert(1)']] }), write({ range: 'B4:B4', values: [['data:text/html,test']] }), write({ range: 'B5:B5', url: 'https://evil.example/out' })] });
  assert.equal(result.status, 'ready'); assert.equal(values[1][1], reference);
  assert.equal(result.rejectedItems.length, 4); assert.ok(result.links.every(l => l.url.includes('docs.google.com')));
});
test('最新14日・両アカウントの案件スレッド本文を新しい順に入力する', async () => {
  const until = Date.parse('2026-11-04T00:00:00Z'), users = [];
  const msg = (id, ago, text, subject = 'C1234') => ({ id, internalDate: String(until - ago), payload: { headers: [{ name: 'Subject', value: subject }], mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } } });
  const recent = await loadCaseMail(plan()[0], config, { until, mailGoogle: user => {
    users.push(user);
    return { pages: async (_, url) => { assert.match(new URL(url).searchParams.get('q'), /C1234/); return [{ id: 'thread' }, { id: 'unrelated' }]; },
      request: async (_, url) => ({ messages: url.includes('unrelated') ? [msg('unrelated', 0, '他案件', '別件')] : [msg('old', 15 * 86400000, '古い'), msg('older', 2000, '本文2'), msg('newest', 1000, '最新本文' + 'あ'.repeat(3000)), msg('future', -1000, '未来')] }) };
  } });
  assert.deepEqual(users, ['seisaku-team@orgiast.jp', 'kim@orgiast.jp']); assert.equal(recent.mail.length, 4);
  assert.equal(recent.mail[0].id, 'newest'); assert.equal(recent.mail[0].text.length, 2000);
  const input = buildLocalInput({ jobs: plan() }, '指示', { mail: recent.mail }, { localInputBudgetChars: 10000 });
  assert.match(input.prompt, /最新本文/); assert.match(input.prompt, /本文2/); assert.doesNotMatch(input.prompt, /古い|未来|他案件/);
  assert.ok(input.inputChars <= 10000);
});
test('Drive export はJSONではなくtext/plainで読む', async () => {
  const g = createGoogle({ token: async () => 'fake', fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'ハブ本文', json: () => assert.fail('JSON不可') }) });
  assert.equal(await g.request('drive', 'https://www.googleapis.com/drive/v3/files/hub/export?mimeType=text%2Fplain'), 'ハブ本文');
});
test('根拠不足を確認事項とアジェンダへ出力するプロンプト契約', () => {
  const template = fs.readFileSync(new URL('../templates/meeting-prep-prompt.md', import.meta.url), 'utf8');
  const prompt = buildLocalInput({ jobs: plan() }, renderPrompt(template, { id: 'b', method: 'local', jobs: plan() }), { unconfirmed: ['Gmail未取得', '案件情報ハブ: HTTP 403'] }).prompt;
  for (const re of [/分かっている範囲で準備を完了/, /確認シートに起票し、アジェンダにも/, /必ず apply/, /場合だけ/, /before を捏造しない/]) assert.match(prompt, re);
  const result = filterResultUrls({ writes: [write({ target: 'confirmation', tab: '確認事項', range: 'D2:D2', before: [['']], values: [['最新の連絡内容を確認']] }), write({ values: [['案件情報ハブの最新情報を確認']] })] });
  assert.equal(result.writes.length, 2); result.writes.forEach(validateWrite);
});

test('外部リンク混在のapplyを回収してジョブを完了できる', async () => {
  const g = calendarMock(), request = g.request; let values = [['old']];
  g.request = async (scope, url, method, body) => {
    if (url.includes('sheets.googleapis.com')) {
      if (url.includes('fields=sheets')) return { sheets: [{ properties: { title: 'Claude_次回MTGアジェンダ', sheetId: 42 } }] };
      if (method === 'PUT') values = body.values;
      return { values };
    }
    return request(scope, url, method, body);
  };
  const state = {};
  const errors = await dispatchJobs({ jobs: plan(), state, config, google: g, template: '{{PAYLOAD}}', checkpoint() {},
    runLocal: async batch => JSON.stringify({ version: 1, batchId: batch.id, results: [{ key: batch.jobs[0].key, status: 'apply', summary: '最新連絡を確認',
      links: [{ label: '参考', url: 'https://peatix.com/event/123' }], writes: [write({ values: [['確認事項 https://timerex.net/r/example']] })] }] }) });
  assert.deepEqual(errors, []); assert.equal(Object.values(state.batches)[0].status, 'complete');
  assert.match(values[1][1], /timerex/); assert.equal(Object.values(state.batches)[0].completed[plan()[0].key].result.rejectedItems.length, 1);
});
test('片方のGmailが未取得でも他方の本文と確認事項用の理由を残す', async () => {
  const until = Date.parse('2026-11-04T00:00:00Z');
  const recent = await loadCaseMail(plan()[0], config, { until, mailGoogle: user => ({ pages: async () => {
    if (user === config.teamEmail) throw Error('HTTP 403'); return [{ id: 'thread' }];
  }, request: async () => ({ messages: [{ id: 'm', internalDate: String(until), payload: { mimeType: 'text/plain', body: { data: Buffer.from('C1234 確認が必要').toString('base64url') } } }] }) }) });
  assert.equal(recent.mail.length, 1); assert.match(recent.unconfirmed[0], /seisaku-team.*403/);
});

// Real output fixtures preserve row shapes, missing before fields and equality,
// while every non-empty free-text cell is anonymized. 8a63 raw stdout was lost.
const fixture = id => JSON.parse(fs.readFileSync(new URL(`./fixtures/meeting-prep/${id}.json`, import.meta.url), 'utf8'));
const agendaHeader = ['No', '議題', '目的', '背景', 'この場で決めること', '選択肢', '所要分'];
const confirmHeader = ['確認ID', 'フェーズ', 'カテゴリ', '確認内容', '回答', 'ステータス', '起票日時'];
async function sheetSandbox(initial = {}, { confirmation = true, submission = false } = {}) {
  const { createApplyPreview } = await import('./lib/meeting-prep-preview.mjs');
  const readCalls = [];
  const source = {
    pages: async (_, url) => decodeURIComponent(url).includes('打合せ補足資料') ? [] : [
      ...(confirmation ? [{ id: 'confirm', name: '確認シート', mimeType: 'application/vnd.google-apps.spreadsheet' }] : []),
      ...(submission ? [{ id: 'submit', name: 'C1234_展示会準備_ご提出フォーマット', mimeType: 'application/vnd.google-apps.spreadsheet' }] : [])
    ],
    request: async (_, url, method = 'GET') => {
      assert.equal(method, 'GET', 'dry-run must never write to the backing service'); readCalls.push(url);
      const u = new URL(url), id = u.pathname.split('/')[3], tabs = initial[id] || {};
      if (u.searchParams.has('fields')) return { sheets: Object.keys(tabs).map((title, i) => ({ properties: { title, sheetId: i + 1 } })) };
      const tab = decodeURIComponent(u.pathname.split('/values/')[1]).match(/^'([^']+)'/)[1];
      if (!Object.hasOwn(tabs, tab)) throw Error('unregistered tab');
      return { values: structuredClone(tabs[tab]) };
    }
  };
  return Object.assign(createApplyPreview(source), { readCalls });
}
const readTab = (g, id, tab) => g.request('spreadsheets', `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab}'`)}`);
for (const id of ['cdfd', 'e6d7', '6a7a']) test(`保存済み実出力 ${id}: 寸法補正・提出先fallback・全タブ読戻し`, async () => {
  const answer = fixture(id), result = answer.results[0];
  const g = await sheetSandbox({ plan: { 'Claude_次回MTGアジェンダ': [agendaHeader, [1, '古い議題']], 'Claude_実施計画更新': [['項目', '確定内容', '根拠', '更新日時']] }, confirm: { '確認事項': [['確認ID', 'フェーズ', '確認カテゴリ', '確認内容', '回答', 'ステータス', '起票日時']] } });
  const applied = await applyResult(g, plan()[0], result);
  assert.equal(applied.status, 'ready'); assert.equal(applied.skipped.length, id === 'e6d7' ? 1 : 0);
  assert.ok(applied.skipped.every(s => /gid/.test(s.reason)));
  assert.ok(applied.operations.every(op => op.readBack.verified));
  assert.equal(applied.operations.filter(op => op.tab === 'Claude_次回MTGアジェンダ').length, 1, 'split proposals replace the tab once');
  const agenda = (await readTab(g, 'plan', 'Claude_次回MTGアジェンダ')).values;
  assert.ok(!agenda.some(r => r.includes('古い議題')));
  if (id !== '6a7a') {
    assert.ok(applied.notes.includes('提出フォーマット未特定'));
    assert.ok(agenda.some(r => r[1] === '提出依頼'));
    assert.match(agenda.at(-1)[1], /^提出依頼:/);
  }
  const first = (await readTab(g, 'confirm', '確認事項')).values;
  const again = await applyResult(g, plan()[0], result);
  assert.equal(again.status, 'ready');
  assert.deepEqual((await readTab(g, 'confirm', '確認事項')).values, first);
  assert.ok(again.operations.filter(op => op.mode === 'append').every(op => op.rows === 0));
  if (id === 'cdfd') {
    assert.equal(first[1][3], result.writes.find(w => w.tab === '確認事項').values[0][2]);
    assert.equal(first[1][4], '');
  }
});
test('追記は内容で重複排除し既存回答を保持・列数を見出しへ補正', async () => {
  const g = await sheetSandbox({ confirm: { '確認事項': [confirmHeader, ['old-id', 'p', 'c', '既存 内容', 'お客様の回答', '済', 'date']] },
    submit: { 'Claude_提出依頼': [['提出物', '目的', '期限', '状態', '備考'], ['資料A', '目的', '', '受領済']] },
    plan: { '制作物一覧': [['No', '品名', 'サイズ'], [1, '看板', 'A1']] } }, { submission: true });
  const result = await applyResult(g, plan()[0], { writes: [
    { target: 'confirmation', tab: '確認事項', range: 'A2:G3', values: [['new-id', 'p', 'c', '既存内容', '', '', ''], ['new', '', '', '新しい確認', '', '未', 'date', '余分']] },
    { target: 'submission', tab: 'Claude_提出依頼', range: 'A2:E3', values: [['資料A', '書換不可'], ['資料B', '新規']] },
    { target: 'plan', tab: '制作物一覧', range: 'A2:C3', values: [[99, '看板', '変更不可'], [2, '名札', 'A6', '切り捨て']] }
  ] });
  assert.equal(result.status, 'ready'); assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.operations.map(op => [op.rows, op.duplicates]), [[1, 1], [1, 1], [1, 1]]);
  const rows = (await readTab(g, 'confirm', '確認事項')).values;
  assert.equal(rows[1][4], 'お客様の回答'); assert.equal(rows[2].length, 7);
  assert.deepEqual((await readTab(g, 'plan', '制作物一覧')).values[1], [1, '看板', 'A1']);
});
test('before不一致はその操作だけskip・一致する操作は適用・準備予定は一部完了', async () => {
  const g = await sheetSandbox({ plan: { 'Claude_実施計画更新': [['項目', '確定内容', '根拠', '更新日時'], ['人が編集'], ['一致']] } });
  const proposals = [write({ tab: 'Claude_実施計画更新', range: 'A2:A2', before: [['古い']], values: [['上書き禁止']] }),
    write({ tab: 'Claude_実施計画更新', range: 'A3:A3', before: [['一致']], values: [['更新']] }), write()];
  const checkpoints = [];
  const result = await applyResult(g, plan()[0], { status: 'apply', summary: '準備', writes: proposals }, p => checkpoints.push(structuredClone(p)));
  assert.equal(result.status, 'ready'); assert.equal(result.skipped.length, 1); assert.match(result.skipped[0].reason, /before不一致/);
  assert.equal(result.operations.length, 2); assert.ok(checkpoints.some(p => p.operations.length));
  const rows = (await readTab(g, 'plan', 'Claude_実施計画更新')).values;
  assert.equal(rows[1][0], '人が編集'); assert.equal(rows[2][0], '更新');
  const cal = calendarMock(); await upsertPreparation(cal, 'prep', plan()[0], result);
  assert.match([...cal.events.values()][0].description, /一部完了（skip 1件:.*before不一致/);
});
test('missing confirmationをskipしても提出依頼と残りの成果物は適用', async () => {
  const g = await sheetSandbox({ plan: { 'Claude_実施計画更新': [['項目', '確定内容', '根拠', '更新日時']] } }, { confirmation: false });
  const result = await applyResult(g, plan()[0], fixture('cdfd').results[0]);
  assert.equal(result.status, 'ready'); assert.equal(result.skipped.length, 1);
  const cal = calendarMock(); await upsertPreparation(cal, 'prep', plan()[0], result);
  assert.match([...cal.events.values()][0].description, /提出フォーマット未特定/);
});
test('synthetic 8a63 failure class: raw control characters survive tolerant parsing', () => {
  const value = '改行\nタブ\tNUL\u0000引用"逆斜線\\';
  const text = JSON.stringify({ version: 1, batchId: 'synthetic-8a63', results: [{ summary: value }] }).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\u0000/g, '\u0000');
  assert.throws(() => JSON.parse(text), SyntaxError);
  for (const raw of [text, '```json\n' + text + '\n```', JSON.stringify({ result: text })]) assert.equal(parseAnswer(raw).results[0].summary, value);
});
test('JSON構文修正は1回限定・parse前stdoutも永続checkpoint対象', async () => {
  for (const repairSucceeds of [true, false]) {
    const state = {}, g = calendarMock(); let runs = 0;
    await dispatchJobs({ jobs: plan(), state, config, template: '{{PAYLOAD}}', google: g, checkpoint() {},
      runLocal: async (batch, body, options) => {
        runs++;
        if (runs === 1) { assert.equal(options.repairRaw, undefined); return '{invalid'; }
        assert.equal(options.repairRaw, '{invalid');
        return repairSucceeds ? JSON.stringify({ version: 1, batchId: batch.id, results: [{ key: batch.jobs[0].key, status: 'needsReview', summary: '構文修正済み' }] }) : '{still invalid';
      } });
    assert.equal(runs, 2);
    const batch = Object.values(state.batches)[0];
    assert.equal(batch.localRaw, '{invalid'); assert.equal(batch.jsonRetry.attempts, 1); assert.ok(batch.localRepairRaw);
    assert.equal(batch.status, 'failed');
  }
});
test('読戻し不一致をskipとして記録し他タブは続行する', async () => {
  const g = await sheetSandbox(), original = g.request;
  g.request = async (scope, url, method, body) => {
    const response = await original(scope, url, method, body);
    if ((method || 'GET') === 'GET' && url.includes('/values/') && decodeURIComponent(url).includes('制作物デザイン') && g.mutations.some(m => m.method === 'PUT' && decodeURIComponent(m.url).includes('制作物デザイン'))) return { values: [['unexpected']] };
    return response;
  };
  const result = await applyResult(g, plan()[0], { writes: [write(), write({ tab: '制作物デザイン', range: 'A2:F2', values: [['制作物']] })] });
  assert.equal(result.status, 'ready'); assert.equal(result.skipped.length, 1); assert.match(result.skipped[0].reason, /read-back/);
  assert.ok(result.operations.every(op => op.readBack.verified));
});
test('アイテムリスト・回答・既存Docの削除は禁止、全skipなら成功にしない', async () => {
  const g = await sheetSandbox();
  const result = await applyResult(g, plan()[0], { writes: [write({ tab: 'アイテムリスト' })] });
  assert.equal(result.status, 'needsReview'); assert.equal(g.mutations.length, 0);
  const calls = [];
  const docs = { pages: async () => [{ id: 'doc' }], request: async (_, url, method = 'GET') => { calls.push(method); return { revisionId: 'r', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'existing\n' } }] } }] } }; } };
  const d = await applyResult(docs, plan()[0], { documents: [{ key: 'doc', beforeText: 'existing', text: 'new' }] });
  assert.equal(d.status, 'needsReview'); assert.match(d.skipped[0].reason, /削除・全置換は禁止/); assert.ok(calls.every(m => m === 'GET'));
});
test('提出依頼だけの再適用は既存アジェンダを保持して二重追記しない', async () => {
  const g = await sheetSandbox({ plan: { 'Claude_次回MTGアジェンダ': [agendaHeader, [1, '保持する議題']] } });
  const result = { writes: [{ target: 'submission', tab: 'Claude_提出依頼', range: 'A2:E2', values: [['資料', '目的', '', '', '']] }] };
  await applyResult(g, plan()[0], result);
  const before = (await readTab(g, 'plan', 'Claude_次回MTGアジェンダ')).values;
  await applyResult(g, plan()[0], result);
  assert.deepEqual((await readTab(g, 'plan', 'Claude_次回MTGアジェンダ')).values, before);
  assert.equal(before[1][1], '保持する議題'); assert.equal(before.length, 4);
});
test('確認事項の末尾列だけ不足した場合はカテゴリをずらさず末尾を補完する', async () => {
  const g = await sheetSandbox({ confirm: { '確認事項': [confirmHeader] } });
  await applySheetWrite(g, 'confirm', { target: 'confirmation', tab: '確認事項', range: 'A2:G2', values: [['id', 'phase', 'カテゴリ', '確認内容', '', '未']] });
  const row = (await readTab(g, 'confirm', '確認事項')).values[1];
  assert.equal(row[2], 'カテゴリ'); assert.equal(row[3], '確認内容'); assert.equal(row[4], '');
});
test('書込直前の再読込でbeforeが変わっていた場合もskip', async () => {
  let reads = 0, puts = 0;
  const g = { request: async (_, url, method = 'GET') => {
    if (url.includes('fields=')) return { sheets: [{ properties: { title: 'Claude_実施計画更新', sheetId: 1 } }] };
    if (method === 'PUT') puts++;
    return { values: [[++reads < 3 ? 'old' : 'human']] };
  } };
  await assert.rejects(applySheetWrite(g, 'plan', write({ tab: 'Claude_実施計画更新' })), /before不一致/);
  assert.equal(puts, 0);
});
test('apply-dryとliveの併用は認証・実行前に拒否する', async () => {
  const { main } = await import('./meeting-prep-dispatch.mjs');
  await assert.rejects(main(['--apply-dry', 'batch', '--live']), /併用不可/);
});
