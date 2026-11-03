import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dayBounds, isMeeting, excludeCalendar, matchCase, routeCase, chooseTransport, eventKey, planJobs,
  createGoogle, loadEvents, loadCases, parseCases, loadMailUpdates, loadMeetEvents, inspectFleet, ensureCalendar, upsertPreparation, workspaceUrl, validateWrite, applySheetWrite, applyResult, parseAnswer, collectAnswers, dispatchJobs, renderPrompt } from './meeting-prep-dispatch.mjs';
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
  return { events, calls, pages: async (_, url) => url.endsWith('/acl') ? [{ role: 'owner', scope: { type: 'user', value: 'kim@orgiast.jp' } }] : [{ id: 'prep', summary: config.prepCalendarName, accessRole: 'owner' }],
    request: async (_, url, method = 'GET', body) => {
      calls.push({ url, method, body });
      assert.ok(url.includes('/calendars/prep/'), '元カレンダーにはアクセスしない');
      const id = method === 'POST' ? body.id : url.split('/').at(-1);
      if (method === 'GET') { if (!events.has(id)) throw Object.assign(Error('404'), { status: 404 }); return events.get(id); }
      const result = { ...events.get(id), ...body }; events.set(id, result); return result;
    } };
}
test('準備予定を同じIDで更新し元予定を変更しない・read-back不一致検出', async () => {
  const g = calendarMock(), job = plan()[0];
  await upsertPreparation(g, 'prep', job, { summary: '初回' });
  await upsertPreparation(g, 'prep', job, { summary: '更新' });
  assert.equal(g.events.size, 1); assert.equal(g.calls.filter(c => c.method === 'POST').length, 1);
  assert.match([...g.events.values()][0].description, /更新/);
  assert.equal([...g.events.values()][0].extendedProperties.private.sourceEventId, 'event1');
  await assert.rejects(upsertPreparation(g, 'primary', job), /元の予定/);
  await assert.rejects(upsertPreparation({ request: async () => ({ extendedProperties: { private: { meetingPrepKey: job.key } } }) }, 'prep', job), /read-back/);
});
test('送信前checkpoint・PCごと1通・再実行時二重送信なし', async () => {
  const state = {}, g = calendarMock(); let sends = 0, checkpoints = 0;
  const jobs = plan({ events: [event(), event({ id: 'event2', iCalUID: 'ical2' })] });
  const args = { jobs, state, config, receivers: { pc008: receiver }, template: '{{PAYLOAD}}', google: g, checkpoint: () => checkpoints++, send: async batch => {
    assert.equal(state.batches[batch.id].status, 'sending'); assert.equal(Object.keys(state.sent).length, 2); sends++; return { id: 'mail-test' };
  } };
  await dispatchJobs(args); await dispatchJobs({ ...args, jobs: plan({ state, events: jobs.map(j => j.event) }) });
  assert.equal(sends, 1); assert.equal(g.events.size, 2); assert.ok(checkpoints >= 3);
});
test('送信応答消失でも対象を再送しない', async () => {
  const state = {};
  await assert.rejects(dispatchJobs({ jobs: plan(), state, config, receivers: { pc008: receiver }, template: '{{PAYLOAD}}', google: calendarMock(), checkpoint() {}, send: async () => { throw Error('timeout'); } }), /timeout/);
  assert.equal(plan({ state }).length, 0);
  assert.equal(Object.values(state.batches)[0].status, 'sending');
});
test('受付不明・過大本文はカレンダー作成前に停止', async () => {
  await assert.rejects(dispatchJobs({ jobs: plan(), state: {}, config, receivers: {}, template: '', google: {}, checkpoint() {}, send() { assert.fail(); } }), /opt-in/);
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
test('準備カレンダーの共有漏れを検知し業務データを書き込まない', async () => {
  let writes = 0;
  const g = { pages: async (_, url) => url.endsWith('/acl') ? [{ role: 'reader', scope: { type: 'default' } }] : [{ id: 'prep', summary: config.prepCalendarName, accessRole: 'owner' }], request: async () => { writes++; } };
  await assert.rejects(ensureCalendar(g, {}, config, () => {}), /kim以外/); assert.equal(writes, 0);
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
