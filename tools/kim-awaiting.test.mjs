import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAwaiting, respond, apId, shownFile } from './kim-awaiting.mjs';
import { context, REPEAT_MS, SESSION_TTL, DISPLAY_LIMIT, TOP } from './kim-awaiting-context.mjs';
import { ledgerFile, readLedger, writeLedger, rowKey, MAX_RESUMES } from './auto-progress-ledger.mjs';
import { inboxFile } from './auto-progress-inbox-hook.mjs';
import { mailCategory } from './fleet-mail.mjs';
import { CATEGORY, DAY, ledgerPath, saveJson, readJson } from './lib/fleet-chase-ledger.mjs';
import { resumeSession, run as watch } from './auto-progress-watch.mjs';
import { run as digest, WINDOW_MS, needsDm, verdictOf, kimAction } from './auto-progress-digest.mjs';
const NOW = Date.parse('2026-10-23T12:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-awaiting-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const row = (extra = {}) => ({ pc: 'PC-A', user: 'u', sessionId: 'session-a', ts: new Date(NOW - 2 * DAY).toISOString(), cwd: '/project', promise: '配布を進める', status: 'waiting_user', nextKim: 'なし', reason: 'needs_user: 配布してよいですか', ...extra });
test('collect filters, fallback ask, fleet decision, dedup and oldest first', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), [row(), ...[
    { cwd: path.join(home, '.claude', 'scratch', 'job') }, { promise: 'なし' }, { kimAnswer: 'はい' }, { status: 'open' },
  ].map((extra, i) => row({ sessionId: `excluded-${i}`, ...extra })), row({ sessionId: 'duplicate' })]);
  saveJson(ledgerPath(home), { version: 1, items: { x: { kind: 'inbound', category: CATEGORY.decision, status: 'blocked', mailId: 'mail-one', title: '[判断依頼] PC-B 公開の確認', from: 'PC-B', createdAt: new Date(NOW - 4 * DAY).toISOString() } } });
  const items = collectAwaiting({ home, now: NOW });
  assert.equal(items.length, 2); assert.equal(items[0].id, 'fm:mail-one');
  assert.equal(items[0].title, '公開の確認（PC-Bから）'); assert.equal(items[0].ageDays, 4);
  assert.equal(items[1].ask, '配布してよいですか');
});
function fleetFixture(home, entries) {
  saveJson(ledgerPath(home), { version: 1, items: Object.fromEntries(entries.map((extra, i) => [i, {
    kind: 'inbound', category: CATEGORY.decision, status: 'blocked', mailId: `mail-test-${i}`,
    from: 'PC-B', createdAt: new Date(NOW - DAY).toISOString(), ...extra,
  }])) });
}
test('fleet permission forwards are excluded by title or body', t => {
  const home = fixture(t);
  const phrases = ['Claude needs your permission to use AskUserQuestio', 'AskUserQuestion', 'permission to use'];
  fleetFixture(home, [...phrases.map(title => ({ title })), ...phrases.map(bodyHead => ({ title: '公開してよいか判断してください', bodyHead })), { title: '通常の公開判断をお願いします' }]);
  const items = collectAwaiting({ home, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '通常の公開判断をお願いします（PC-Bから）');
});
test('fleet question prefixes are removed and duplicate asks use the fallback', t => {
  const home = fixture(t);
  fleetFixture(home, [
    { why: '[判断依頼] PC-B のセッション質問', bodyHead: '質問: 「発注の準備」はどちらの発注ですか？' },
    { why: '[判断依頼] 発注する商品についての確認', bodyHead: '質問： 何個発注しますか？' },
  ]);
  const items = collectAwaiting({ home, now: NOW });
  assert.equal(items[0].title, '「発注の準備」はどちらの発注ですか？（PC-Bから）');
  assert.equal(items[0].ask, '判断して返事をする');
  assert.equal(items[1].ask, '何個発注しますか？');
});
test('internal numeric and mail ids are removed from titles and asks without changing routes', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), [row({ purpose: 'SA(100453113321740511744) の確認 mail-1234567890-abc', nextKim: 'SA（100453113321740511744） 1234567890 mail-example の承認' })]);
  fleetFixture(home, [{ why: '[判断依頼] SA(100453113321740511744) の公開承認 mail-1234567890-abc', bodyHead: '質問: SA（100453113321740511744） 1234567890 を公開しますか？' }]);
  const items = collectAwaiting({ home, now: NOW });
  assert.equal(items[0].title, 'SA の確認');
  assert.equal(items[0].ask, 'SA の承認');
  assert.equal(items[1].title, 'SA の公開承認（PC-Bから）');
  assert.equal(items[1].ask, 'SA を公開しますか？');
  assert.deepEqual(items[1].route, { mailId: 'mail-test-0' });
});
test('fleet why takes priority over reply prose while session questions use the body', t => {
  const home = fixture(t);
  fleetFixture(home, [{ why: '[判断依頼] 発注先と発注数量についての確認', title: 'おっしゃる通り、良くない動きでした。', bodyHead: 'おっしゃる通り、良くない動きでした。\n質問: 発注を進めてもよいですか？' }]);
  const [item] = collectAwaiting({ home, now: NOW });
  assert.equal(item.title, '発注先と発注数量についての確認（PC-Bから）');
  assert.equal(item.ask, '発注を進めてもよいですか？');
  fleetFixture(home, [{ title: 'PC-B のセッション質問' }]);
  saveJson(path.join(home, '.claude', 'fleet-inbox', 'mail-test-0.json'), {
    why: '[判断依頼] 共通の拡張を修正して配布する判断',
    body: '質問: おっしゃる通り、良くない動きでした。\n修正してよいですか？',
  });
  assert.equal(collectAwaiting({ home, now: NOW })[0].title, '共通の拡張を修正して配布する判断（PC-Bから）');
  saveJson(path.join(home, '.claude', 'fleet-inbox', 'mail-test-0.json'), {
    why: '[判断依頼] PC-B のセッション質問',
    body: '質問: おっしゃる通り、良くない動きでした。\n原因を確認しました。修正案を送ってよいですか？',
  });
  assert.equal(collectAwaiting({ home, now: NOW })[0].title, '修正案を送ってよいですか？（PC-Bから）');
});
test('hook events, session suppression, changed ids, no items and headless', t => {
  const home = fixture(t), input = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/project' };
  const options = { home, now: NOW, env: {} };
  assert.equal(context(input, options), null);
  writeLedger(ledgerFile(home), [row()]);
  const out = context(input, options);
  assert.match(out.hookSpecificOutput.additionalContext, /📌 kim の返事待ち/);
  assert.match(out.hookSpecificOutput.additionalContext, /--answer/);
  // 同セッション・同 ids → 新着なしで null
  assert.equal(context(input, options), null);
  // 別セッション（25h後）→ fresh として表示
  const DAY = 24 * 3600_000;
  assert.ok(context({ ...input, session_id: 's-start', hook_event_name: 'SessionStart' }, { ...options, now: NOW + DAY + 3600_000 }));
  // SessionStart でも同セッション・同 ids なら2回目は null
  assert.equal(context({ ...input, hook_event_name: 'SessionStart', session_id: 's-start' }, { ...options, now: NOW + DAY + 3600_000 }), null);
  // ids が変わったら再表示
  writeLedger(ledgerFile(home), [row(), row({ sessionId: 'other', promise: '別の件' })]);
  assert.ok(context(input, options));
  assert.equal(context({ ...input, cwd: path.join(home, '.claude', 'auto-session') }, options), null);
  for (const env of [{ CLAUDE_HEADLESS: '1' }, { ORGIAST_AUTO_SESSION: '1' }]) assert.equal(context(input, { ...options, env }), null);
  // 古い shownFile が壊れていても null を返す（context はもう shownFile を読まない）
  fs.mkdirSync(path.dirname(shownFile(home)), { recursive: true }); fs.writeFileSync(shownFile(home), '{'); assert.equal(context(input, options), null);
});
test('hook caps display while tracking all ids', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), Array.from({ length: DISPLAY_LIMIT + 2 }, (_, i) => row({ sessionId: `s${i}`, promise: `件${i}` })));
  const out = context({ session_id: 's', cwd: '/project' }, { home, env: {}, now: NOW });
assert.match(out.hookSpecificOutput.additionalContext, /ほか 4 件/);
  // 新ポリシーの状態ファイルに全 ids が記録されている
  const policyFile = path.join(home, '.claude', 'inbox-display-shown.json');
  const state = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  assert.equal(Object.keys(state['kim-awaiting']).length, DISPLAY_LIMIT + 2);
});
test('hook shows up to three brief items with the current session first', t => {
  const home = fixture(t);
  const ask = '公開前に確認していただきたい内容です。'.repeat(8) + 'この条件で進めてよいですか？';
  const current = row({ sessionId: 'current', promise: '現在の判断', nextKim: ask });
  const older = Array.from({ length: 10 }, (_, i) => row({
    sessionId: `older-${i}`, promise: `古い判断${i}`, ts: new Date(NOW - (20 - i) * DAY).toISOString(),
  }));
  writeLedger(ledgerFile(home), [...older, current]);
  assert.equal(collectAwaiting({ home, now: NOW }).at(-1).ask.length, 80);
  const out = context({ session_id: 'current', cwd: '/project' }, { home, env: {}, now: NOW });
  const text = out.hookSpecificOutput.additionalContext;
  const lines = text.split('\n').filter(line => line.startsWith('・'));
  assert.equal(lines.length, TOP);
  assert.ok(lines.every(line => [...line].length <= 100));
  assert.ok(lines[0].startsWith('・'));
  assert.ok(lines[0].includes('答えてほしいこと:'));
  assert.ok(lines[0].includes('公開前に確認していただきたい内容です'));
  for (let i = 0; i < TOP - 1; i++) assert.ok(lines[i + 1].startsWith(`・古い判断${i} ／`));
  assert.match(text, /ほか 8 件/);
  assert.equal(text.split('\n').filter(line => line.startsWith('id=')).length, TOP);
  assert.ok(text.includes(`id=${apId(current)} | 現在の判断`));
  // 新ポリシーの状態ファイルに全 ids が記録されている
  const policyFile = path.join(home, '.claude', 'inbox-display-shown.json');
  const policyState = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  assert.equal(Object.keys(policyState['kim-awaiting']).length, 11);
});
test('hook keeps the current-session item even when another session has the same title', t => {
  const home = fixture(t);
  const current = [row({ sessionId: 'current', promise: '判断0' })];
  writeLedger(ledgerFile(home), [row({ sessionId: 'older', promise: '判断0', ts: new Date(NOW - 10 * DAY).toISOString() }), ...current]);
  const text = context({ sessionId: 'current', cwd: '/project' }, { home, env: {}, now: NOW }).hookSpecificOutput.additionalContext;
  const routes = text.split('\n').filter(line => line.startsWith('id='));
  assert.equal(routes.length, 2);
  for (let i = 0; i < current.length; i++) assert.ok(routes[i].startsWith(`id=${apId(current[i])} |`));
  assert.doesNotMatch(text, /ほか \d+ 件/);
});
test('answer ap patches ledger, clears marker and delivers inbox; skip closes', t => {
  const home = fixture(t), original = row({ resumedAt: new Date(NOW).toISOString() });
  writeLedger(ledgerFile(home), [original]);
  saveJson(shownFile(home), { s: { at: NOW, ids: [apId(original)] } });
  const bodyFile = path.join(home, 'answer.txt'); fs.writeFileSync(bodyFile, '進めてください');
  assert.equal(respond(apId(original), { home, bodyFile, now: NOW }), 0);
  const updated = readLedger(ledgerFile(home))[0];
  assert.equal(updated.kimAnswer, '進めてください'); assert.equal(updated.status, 'stalled');
  assert.equal(updated.resumedAt, undefined); assert.equal(updated.nextKim, 'なし');
  assert.equal(JSON.parse(fs.readFileSync(inboxFile(home, original.sessionId), 'utf8')).state, 'answered');
  assert.deepEqual(readJson(shownFile(home)).s.ids, []);
  assert.deepEqual(collectAwaiting({ home, now: NOW }), []);
  assert.equal(respond(apId(original), { home, skip: true, reason: 'もう不要', now: NOW }), 0);
  assert.equal(readLedger(ledgerFile(home))[0].status, 'done');
});
test('fleet routes are injected, failure propagates and preserves shown state', t => {
  const home = fixture(t), bodyFile = path.join(home, 'answer.txt'); fs.writeFileSync(bodyFile, 'はい');
  for (const [id, flag, skip] of [['mail-question-one', '--answer', false], ['mail-one', '--reply', false], ['mail-two', '--ack', true]]) {
    let invocation;
    assert.equal(respond(`fm:${id}`, { home, bodyFile, skip, reason: '不要', spawnImpl: (...args) => { invocation = args; return { status: 0 }; } }), 0);
    assert.deepEqual(invocation[1].slice(1), [flag, id, ...(skip ? [] : ['--body-file', bodyFile])]);
    assert.equal(invocation[2].env.ORGIAST_HOME, home);
  }
  saveJson(shownFile(home), { s: { at: NOW, ids: ['fm:mail-one'] } });
  assert.equal(respond('fm:mail-one', { home, bodyFile, spawnImpl: () => ({ status: 7 }) }), 7);
  assert.deepEqual(readJson(shownFile(home)).s.ids, ['fm:mail-one']);
});
test('watch resume prompt carries answer directly after declaration', async t => {
  const home = fixture(t); let prompt;
  await resumeSession(row({ kimAnswer: '公開してください' }), { home, io: { executable: 'fake', runChild: async (_exe, text) => { prompt = text; return { status: 'failed' }; } } });
  assert.match(prompt, /宣言: 「配布を進める」。\nkim の返事: 「公開してください」。これを前提に続きを進めてください。/);
});
test('answered old and exhausted row resumes on next watch', async t => {
  const home = fixture(t); let resumed = 0;
  writeLedger(ledgerFile(home), [row({ ts: new Date(NOW - 30 * DAY).toISOString(), kimAnswer: '進める', status: 'stalled', nextKim: 'なし', resumeCount: MAX_RESUMES })]);
  await watch({ home, now: NOW, io: { digest: async () => ({ sent: false }), sheetConfig: () => null, cwdExists: () => true, resume: async () => { resumed++; return { state: 'done', reason: '完了' }; }, appendInbox: () => {} } });
  assert.equal(resumed, 1);
});
test('kim reminders stay in session context across days and answered rows disappear', async t => {
  const home = fixture(t), r = row();
  writeLedger(ledgerFile(home), [r]);
  const io = { label: 'kim-PC', localOwner: 'kim@orgiast.jp', readLedger: () => readLedger(ledgerFile(home)),
    notify: () => assert.fail('kim summaries must not send an outbound notification') };
  // 各日は別セッションとして扱い、25h以上間隔を空ける（新ポリシー: 同セッションの既出は再掲しない・別セッションは24h以内なら省略）
  const DAY_MS = 24 * 3600_000;
  for (let i = 0; i < 4; i++) {
    const now = NOW + i * (DAY_MS + 3600_000); // 25h 間隔
    const out = await digest({ home, now, slot: '朝', io });
    assert.equal(out.sent, false);
    assert.equal(out.skipped, 'session-context-only');
    assert.match(context({ hook_event_name: 'SessionStart', session_id: `reminder-day${i}`, cwd: '/project' },
      { home, now, env: {} }).hookSpecificOutput.additionalContext, /配布してよいですか/);
  }
  writeLedger(ledgerFile(home), [{ ...r, kimAnswer: 'はい' }]);
  assert.equal(needsDm({ ...r, kimAnswer: 'はい' }), false);
  assert.equal(context({ hook_event_name: 'SessionStart', session_id: 'reminder-final', cwd: '/project' },
    { home, now: NOW + 5 * DAY_MS, env: {} }), null);
});

test('lightweight chase categories match mail classification', () => {
  assert.equal(CATEGORY.decision, mailCategory({ why: '[判断依頼]' }));
  assert.equal(CATEGORY.task, mailCategory({ why: '[作業依頼]' }));
});

test('collectAwaiting: セッション限りの画面操作は追わず、調査記録は問いに置き換える', async () => {
  const { SESSION_OP_RE } = await import('./kim-awaiting.mjs');
  for (const text of ['この古いタブを ✕ で1回閉じる', '右端の「Claude Code」タブで Enter を押す', '/session-close` を打つ（1回だけ）']) assert.match(text, SESSION_OP_RE);
  for (const text of ['上の案でよいか（変えたい月だけ）を一言で返す', '「cr-PC に一本化」か「このPCでも続ける」のどちらかを返答する']) assert.doesNotMatch(text, SESSION_OP_RE);
});

const extItem = (extra = {}) => ({ id: 'ex:aaaaaaaaaaaa', kind: 'reply', group: 'window', mailbox: 'seisaku-team@orgiast.jp', who: '川口様', subject: '日程のご相談', since: new Date(NOW - 30 * 3600_000).toISOString(), ask: '11/6 14時でお願いします', threadId: 't1', lastMessageId: 'm1', ...extra });
const writeExternal = (home, state) => saveJson(path.join(home, '.claude', 'state', 'external-waiting.json'), { generatedAt: new Date(NOW - 3600_000).toISOString(), sources: {}, items: [], ...state });
test('external は他のすべての項目より前に並び、external: true が付く', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), [row()]);
  writeExternal(home, { items: [extItem({ id: 'ex:bbbbbbbbbbbb', since: new Date(NOW - 2 * 3600_000).toISOString() }), extItem()] });
  const items = collectAwaiting({ home, now: NOW });
  assert.deepEqual(items.map(item => item.id).slice(0, 2), ['ex:aaaaaaaaaaaa', 'ex:bbbbbbbbbbbb']);
  assert.ok(items[0].external && items[1].external && !items[2].external);
  assert.equal(items[0].title, '川口様「日程のご相談」'); assert.equal(items[0].ageHours, 30);
});
test('下書きは「下書きのまま未送信」と表示する', t => {
  const home = fixture(t);
  writeExternal(home, { items: [extItem({ kind: 'draft', who: 'cust@example.com', ask: '送信するか決める' })] });
  assert.equal(collectAwaiting({ home, now: NOW })[0].title, '下書きのまま未送信: cust@example.com（seisaku-team@ の下書き）「日程のご相談」');
});
test('状態ファイルが古い・取得失敗があると警告項目が先頭に入る', t => {
  const home = fixture(t);
  writeExternal(home, { generatedAt: new Date(NOW - 5 * 3600_000).toISOString(), items: [extItem()] });
  let items = collectAwaiting({ home, now: NOW });
  assert.equal(items[0].id, 'ex:monitor'); assert.match(items[0].title, /^社外返信の監視が止まっています（最終更新 .+ \/ エラー /);
  writeExternal(home, { sources: { 'kim@orgiast.jp': { ok: false, error: 'Gmail API 403' } }, items: [] });
  items = collectAwaiting({ home, now: NOW });
  assert.match(items[0].title, /kim@orgiast\.jp: Gmail API 403/);
  writeExternal(home, { items: [extItem()] });
  assert.equal(collectAwaiting({ home, now: NOW }).some(item => item.warning), false);
});
test('hook は external を15件まで別枠で表示し、集合が変わると REPEAT_MS 前でも再表示する', t => {
  const home = fixture(t), input = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/project' }, options = { home, now: NOW, env: {} };
  writeLedger(ledgerFile(home), Array.from({ length: DISPLAY_LIMIT + 1 }, (_, i) => row({ sessionId: `s${i}`, promise: `社内${i}` })));
  writeExternal(home, { items: Array.from({ length: 17 }, (_, i) => extItem({ id: `ex:${String(i).padStart(12, '0')}`, subject: `件${i}` })) });
  const text = context(input, options).hookSpecificOutput.additionalContext;
  assert.match(text, /🔴 社外の人を待たせています 17 件（古い順）/); assert.match(text, /ほか 14 件/);
  assert.ok(text.indexOf('🔴') < text.indexOf('📌')); assert.match(text, /get_thread で読み、返信下書きまで作って/);
  assert.equal(text.split('\n').filter(line => line.startsWith('・') && line.includes('件')).length, TOP);
  assert.equal(context(input, options), null);
  writeExternal(home, { items: [extItem({ id: 'ex:cccccccccccc' })] });
  assert.ok(context(input, { ...options, now: NOW + 60_000 }));
});
test('ex: の --skip / --answer は専用ファイルへ書き、lastMessageId が変わると再表示される', t => {
  const home = fixture(t), bodyFile = path.join(home, 'answer.txt'); fs.writeFileSync(bodyFile, 'この日で返信して');
  writeExternal(home, { items: [extItem()] });
  assert.equal(respond('ex:aaaaaaaaaaaa', { home, bodyFile, now: NOW }), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'state', 'external-waiting-answers', 'aaaaaaaaaaaa.json'), 'utf8')).answer, 'この日で返信して');
  assert.equal(respond('ex:aaaaaaaaaaaa', { home, skip: true, reason: '対応済み', now: NOW }), 0);
  assert.equal(collectAwaiting({ home, now: NOW }).length, 0);
  writeExternal(home, { items: [extItem({ lastMessageId: 'm2' })] });
  assert.equal(collectAwaiting({ home, now: NOW }).length, 1);
});

test('check のない Claude 作業を質問と併記し6時間で警告する', t => {
  const home = fixture(t);
  for (const hours of [5, 6, 10]) {
    writeLedger(ledgerFile(home), [row({ status: 'open', nextKim: '色を選ぶ', ts: new Date(NOW - hours * 3600000).toISOString() })]);
    const [item] = collectAwaiting({ home, now: NOW });
    assert.equal(item.ask, '色を選ぶ');
    assert.match(item.progress, new RegExp(`Claude 側で進行中（最終更新 ${hours} 時間前）`));
    assert.equal(item.progress.includes('⚠️ 止まっている可能性'), hours >= 6);
    const output = context({ session_id: 'current', hook_event_name: 'SessionStart' }, { home, now: NOW, env: {} });
    assert.ok(output.hookSpecificOutput.additionalContext.includes(item.progress));
  }
  for (const extra of [{ check: 'test -f result.txt' }, { promise: '返信を待つ' }, { status: 'waiting_user' }]) {
    writeLedger(ledgerFile(home), [row({ status: 'open', nextKim: '色を選ぶ', ...extra })]);
    assert.equal(collectAwaiting({ home, now: NOW })[0].progress, '');
  }
});

 test('社外の先頭別枠と現セッションの Claude 進行表示を CLI・hook で両立する', async t => {
  const { formatList } = await import('./kim-awaiting.mjs');
  const home = fixture(t);
  writeExternal(home, { items: [extItem()] });
  writeLedger(ledgerFile(home), [row({ sessionId: 'current', status: 'open', nextKim: '色を選ぶ', ts: new Date(NOW - 6 * 3600000).toISOString() })]);
  const items = collectAwaiting({ home, now: NOW, sessionId: 'current' });
  const hook = context({ session_id: 'current', hook_event_name: 'SessionStart' }, { home, now: NOW, env: {} }).hookSpecificOutput.additionalContext;
  for (const text of [formatList(items), hook]) {
    assert.ok(text.indexOf('🔴') < text.indexOf('📌'));
    assert.match(text, /30時間待ち/);
    assert.match(text, /Claude 側で進行中（最終更新 6 時間前） ⚠️ 止まっている可能性/);
  }
  assert.match(hook, /現セッション優先/);
});

test('autoRegisteredCheck rows with status!=waiting_user are excluded from kim-awaiting', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), [{
    sessionId: 'session-autoreg',
    pc: 'PC-A', user: 'u', ts: new Date(NOW - 2 * DAY).toISOString(),
    promise: '身元照会の確認',
    status: 'open',
    nextKim: '以下の少なくとも1つを教えてください: 1. 文面 2. URL',
    autoRegisteredCheck: true
  }]);
  const items = collectAwaiting({ home, now: NOW });
  assert.equal(items.filter(item => item.route?.sessionId === 'session-autoreg').length, 0);
});


test('auto registration marker does not hide an explicit waiting_user request', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), [row({ autoRegisteredCheck: true, status: 'waiting_user', nextKim: '予算を承認してください' })]);
  const items = collectAwaiting({ home, now: NOW });
  assert.equal(items.filter(item => item.route?.sessionId === 'session-a').length, 1);
});

process.env.ORGIAST_AUTO_RESUME = '1';

test('hook displays only added ids at the end and suppresses repeated prompts', t => {
  const home = fixture(t), options = { home, now: NOW, env: {} };
  const input = { session_id: 'viewer', prompt: 'first request' };
  writeLedger(ledgerFile(home), [row({ sessionId: 'one', promise: 'old request' })]);
  assert.ok(context(input, options));
  const other = context({ ...input, session_id: 'other-viewer' }, options).hookSpecificOutput.additionalContext;
  assert.match(other, /ほか既出 1 件/);
  assert.doesNotMatch(other, /old request/);
  writeLedger(ledgerFile(home), [row({ sessionId: 'one', promise: 'old request' }), row({ sessionId: 'two', promise: 'new request' })]);
  const next = context({ ...input, prompt: 'second request' }, options).hookSpecificOutput.additionalContext;
  assert.match(next, /new request/);
  assert.doesNotMatch(next, /old request|応答の冒頭/);
  assert.match(next, /ほか既出 1 件/);
  assert.match(next, /本当に最後のメッセージ/);
  writeLedger(ledgerFile(home), [row({ sessionId: 'three', promise: 'third request' })]);
  assert.equal(context({ ...input, prompt: 'second request' }, options), null);
  assert.equal(context({ ...input, prompt: '<<autonomous-loop-dynamic>>' }, options), null);
});

test('ex: に kim の回答が保存されたら質問として出さず、回答済みとして分けて表示する（2026-11-19 重複質問）', t => {
  const home = fixture(t), bodyFile = path.join(home, 'answer.txt'); fs.writeFileSync(bodyFile, '最新にして送る');
  writeExternal(home, { items: [extItem(), extItem({ id: 'ex:bbbbbbbbbbbb', threadId: 't2', lastMessageId: 'n1' })] });
  assert.equal(respond('ex:aaaaaaaaaaaa', { home, bodyFile, now: NOW }), 0);
  const items = collectAwaiting({ home, now: NOW });
  const answered = items.find(item => item.id === 'ex:aaaaaaaaaaaa');
  assert.equal(answered.answered, true);
  assert.match(answered.progress, /kim 回答済み .*最新にして送る/);
  assert.equal(items.find(item => item.id === 'ex:bbbbbbbbbbbb').answered, undefined);
  const out = context({ hook_event_name: 'SessionStart', session_id: 's-dup' }, { home, now: NOW, env: {} });
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(!text.includes('id=ex:aaaaaaaaaaaa'));
  assert.ok(text.includes('id=ex:bbbbbbbbbbbb'));
  writeExternal(home, { items: [extItem({ lastMessageId: 'm2' })] });
  assert.equal(collectAwaiting({ home, now: NOW })[0].answered, undefined);
});
