import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectAwaiting, respond, apId, shownFile } from './kim-awaiting.mjs';
import { context, REPEAT_MS, SESSION_TTL, DISPLAY_LIMIT } from './kim-awaiting-context.mjs';
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
test('hook events, session suppression, three hours, changed ids, no items and headless', t => {
  const home = fixture(t), input = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/project' };
  const options = { home, now: NOW, env: {} };
  assert.equal(context(input, options), null);
  writeLedger(ledgerFile(home), [row()]);
  const out = context(input, options);
  assert.match(out.hookSpecificOutput.additionalContext, /📌 kim の返事待ち/);
  assert.match(out.hookSpecificOutput.additionalContext, /--answer/);
  assert.equal(context(input, options), null);
  assert.ok(context(input, { ...options, now: NOW + REPEAT_MS }));
  assert.ok(context({ ...input, hook_event_name: 'SessionStart' }, options));
  assert.ok(context({ ...input, hook_event_name: 'SessionStart' }, options));
  writeLedger(ledgerFile(home), [row(), row({ sessionId: 'other', promise: '別の件' })]);
  assert.ok(context(input, options));
  assert.equal(context({ ...input, cwd: path.join(home, '.claude', 'auto-session') }, options), null);
  for (const env of [{ CLAUDE_HEADLESS: '1' }, { ORGIAST_AUTO_SESSION: '1' }]) assert.equal(context(input, { ...options, env }), null);
  saveJson(shownFile(home), { old: { at: NOW - SESSION_TTL - 1, ids: [] } });
  context(input, options); assert.equal(readJson(shownFile(home)).old, undefined);
  fs.writeFileSync(shownFile(home), '{'); assert.equal(context(input, options), null);
});
test('hook caps display while tracking all ids', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), Array.from({ length: DISPLAY_LIMIT + 2 }, (_, i) => row({ sessionId: `s${i}`, promise: `件${i}` })));
  const out = context({ session_id: 's', cwd: '/project' }, { home, env: {}, now: NOW });
  assert.match(out.hookSpecificOutput.additionalContext, /ほか 2 件/);
  assert.equal(readJson(shownFile(home)).s.ids.length, DISPLAY_LIMIT + 2);
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
  for (const now of [NOW, NOW + WINDOW_MS - 1, NOW + WINDOW_MS, NOW + 3 * WINDOW_MS]) {
    const out = await digest({ home, now, slot: '朝', io });
    assert.equal(out.sent, false);
    assert.equal(out.skipped, 'session-context-only');
    assert.match(context({ hook_event_name: 'SessionStart', session_id: 'reminder', cwd: '/project' },
      { home, now, env: {} }).hookSpecificOutput.additionalContext, /配布してよいですか/);
  }
  writeLedger(ledgerFile(home), [{ ...r, kimAnswer: 'はい' }]);
  assert.equal(needsDm({ ...r, kimAnswer: 'はい' }), false);
  assert.equal(context({ hook_event_name: 'SessionStart', session_id: 'reminder', cwd: '/project' },
    { home, now: NOW + 4 * WINDOW_MS, env: {} }), null);
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
