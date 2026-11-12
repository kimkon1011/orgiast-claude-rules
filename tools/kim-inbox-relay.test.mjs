import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems, main, answerItem, markSeen, updateInboxItem, selectContext } from './kim-inbox.mjs';
import { evaluateKimInboxRelay, commitKimInboxDelivery } from './kim-inbox-relay.mjs';
import { inboxSummary, recordInjection, recordPromptAnswers, relayDue, interactiveInboxSession } from './lib/kim-inbox-relay-state.mjs';
import { run } from './stop-gate-runner.mjs';
const now = Date.parse('2026-11-12T10:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-relay-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const input = { session_id: 'human-session', cwd: home };
  const f = { home, input, inject: items => recordInjection(home, input.session_id, items, { now }),
    judge: (text = '', extra = {}) => evaluateKimInboxRelay(input, { home, now, env: {}, text, ...extra }),
    section: items => '【受信箱】\n' + items.map((i,n) => `${n+1}. ${i.id} ${inboxSummary(i)}`).join('\n') };
  // Fixtures are retained under /tmp; production inboxes are never modified.
  return f;
}
test('context injection is not delivery; final ID and summary are required, not thinking/history or ID alone', async t => {
  const f = fixture(t), item = await addItem(f.home, { kind: 'ask', text: '鍵付き化が完了。nacci0713 の扱いと PR #7 は承認待ち' });
  const output = [];
  await main(['--context'], { home: f.home, stdout: s => output.push(s), readStdin: async () => JSON.stringify({ ...f.input, hook_event_name: 'UserPromptSubmit' }) });
  assert.equal(listItems(f.home)[0].shownCount, 1);
  assert.equal(listItems(f.home)[0].deliveredToKim, undefined);
  assert.equal(f.judge('別作業は完了しました', { raw: f.section([item]) }).decision, 'block');
  assert.equal(f.judge(`【受信箱】\n${item.id}`).decision, 'block');
  assert.equal(f.judge(`${item.id} ${inboxSummary(item)}`).decision, 'block');
  assert.equal(f.judge('```\n' + f.section([item]) + '\n```').decision, 'block');
  assert.equal(f.judge(f.section([item]).split('\n').map(l => '> ' + l).join('\n')).decision, 'block');
  assert.equal(f.judge(f.section([item])).decision, 'pass');
});
test('receipts suppress same-session asks until next JST day, high info until refreshed, other sessions still see asks', async t => {
  const f = fixture(t);
  const ask = await addItem(f.home, { kind: 'ask', text: '承認をお願いします' });
  const info = await addItem(f.home, { kind: 'info', text: '進捗: PR のテスト成功', priority: 'high', dedupeKey: 'progress' });
  f.inject([ask,info]);
  const result = f.judge(f.section([ask,info]));
  commitKimInboxDelivery(f.home, f.input.session_id, result.receipts, now);
  const saved = listItems(f.home), a = saved.find(i => i.id === ask.id), i = saved.find(i => i.id === info.id);
  assert.equal(a.deliveredToKim.count, 1); assert.equal(a.shownCount, 0);
  assert.equal(f.judge('別の作業の結果').decision, 'pass');
  assert.equal(relayDue(a, f.input.session_id, now + 3600000), false);
  assert.equal(relayDue(a, f.input.session_id, now + 86400000), true);
  assert.equal(relayDue(a, 'another-session', now), true);
  assert.equal(relayDue(i, 'another-session', now + 86400000), false);
  assert.equal(relayDue({ ...i, lastAt: new Date(now + 1).toISOString() }, 'another-session', now), false);
  assert.equal(relayDue({ ...i, text: '進捗: PR をマージ済み' }, 'another-session', now), true);
  assert.equal(selectContext(saved, { sessionId: f.input.session_id, now, home: f.home }), '');
});
test('answered, dropped, unseen-by-context and changed records are not blocked using old context', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '依頼' });
  assert.equal(f.judge().decision, 'pass'); f.inject([a]);
  answerItem(f.home, a.id, '可'); assert.equal(f.judge().decision, 'pass');
  updateInboxItem(f.home, a.id, i => { i.status = 'open'; i.text = '新しい依頼'; });
  assert.equal(f.judge().decision, 'pass');
});
test('high progress is injected with deadlines and long asks even when shownCount is already high', async t => {
  const f = fixture(t);
  const info = await addItem(f.home, { text: '進んでいること: LinuxとWindowsの検証が完了' });
  updateInboxItem(f.home, info.id, i => { i.shownCount = 900; });
  for (let n=0;n<8;n++) await addItem(f.home, { kind: 'ask', text: '判断 '+ n + '詳'.repeat(800) });
  for (let n=0;n<5;n++) await addItem(f.home, { kind: 'deadline', key: `D-${n}`, text: `期限 ${n}`, remainingDays: 1 });
  const output = [];
  await main(['--context'], { home: f.home, stdout: s => output.push(s), readStdin: async () => JSON.stringify({ ...f.input, hook_event_name: 'UserPromptSubmit' }) });
  assert.match(output.join(''), new RegExp(info.id));
  assert.match(f.judge().reason, new RegExp(info.id));
});
test('headless flags, SDK metadata, subagents and non-kim seats never force relay or record answers', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '依頼' }); f.inject([a]);
  for (const env of [{ CLAUDE_HEADLESS: '1' }, { ORGIAST_HEADLESS_JOB: 'cron' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }]) assert.equal(f.judge('', { env }).decision, 'pass');
  assert.equal(f.judge('', { raw: JSON.stringify({ entrypoint: 'sdk-cli' }) }).decision, 'pass');
  for (const input of [{ agent_id: 'worker' }, { entrypoint: 'sdk-ide' }, { transcript_path: '/projects/a/subagents/b.jsonl' }]) assert.equal(interactiveInboxSession(input, { home: f.home, env: {} }), false);
  fs.writeFileSync(path.join(f.home, '.claude.json'), '{}');
  assert.equal(f.judge().decision, 'pass');
});
test('1 可 records the shown ask via answerItem; quoted, ambiguous, stale and other-session replies do not', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: 'PR のマージを承認してください' }); f.inject([a]);
  commitKimInboxDelivery(f.home, f.input.session_id, f.judge(f.section([a])).receipts, now);
  const answer = (prompt, session = f.input.session_id) => recordPromptAnswers(f.home, session, prompt, { listItems, answerItem });
  for (const p of ['例: 1 可', '1 可\n作業を調べて', '> 1 可', '1 保留']) assert.equal(answer(p).length, 0);
  assert.equal(answer('1 可', 'other').length, 0);
  assert.equal(answer('1 可').length, 1);
  assert.equal(listItems(f.home)[0].answer, '可');
  assert.equal(listItems(f.home)[0].answerSession, f.input.session_id);
  const multi = await addItem(f.home, { kind: 'ask', text: '承認待ち2件\n1. 共有\n2. 配布' }); f.inject([multi]);
  commitKimInboxDelivery(f.home, f.input.session_id, f.judge(f.section([multi])).receipts, now);
  assert.equal(answer('1 可').length, 0);
});
test('runner relay precedes retry/close bypasses, and another gate rejecting a draft prevents receipt', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '登録の承認をお願いします' }); f.inject([a]);
  const old = process.env.ORGIAST_HOME; process.env.ORGIAST_HOME = f.home;
  t.after(() => { if (old === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = old; });
  const ctx = { raw: '', humanText: '確認して', assistantText: '' };
  for (let n=0;n<5;n++) assert.equal((await run({ ...f.input, stop_hook_active: true, last_assistant_message: '完了' }, ctx)).record.blockedBy[0], 'kim-inbox-relay');
  const result = await run({ ...f.input, last_assistant_message: f.section([a]) + '\nhttps://discord.com/oauth2/authorize?client_id=1511684767546871818&permissions=0' }, ctx);
  assert.equal(result.decision, 'block');
  assert.equal(listItems(f.home)[0].deliveredToKim, undefined);
  const success = await run({ ...f.input, last_assistant_message: f.section([a]) + '\n次に kim がすること: なし' }, ctx);
  assert.notEqual(success.decision, 'block', JSON.stringify(success));
  assert.equal(listItems(f.home)[0].deliveredToKim.count, 1);
});

test('manual --seen during a turn cannot bypass final-message verification', async t => {
  const f = fixture(t), info = await addItem(f.home, { text: '完了: 検証成功', priority: 'high' });
  f.inject([info]); markSeen(f.home, info.id);
  assert.equal(f.judge('完了しました').decision, 'block');
  commitKimInboxDelivery(f.home, f.input.session_id, f.judge(f.section([info])).receipts, now);
  assert.equal(listItems(f.home)[0].deliveredToKim.count, 1);
});

test('passkey ask relays the complete signed URL rather than a truncated token', async t => {
  const f = fixture(t), url = 'https://keyserve.test/api/knowledge?register=' + 'a'.repeat(500);
  const item = await addItem(f.home, { kind: 'ask', priority: 'high', source: 'knowledge-lock-passkey-link', text: `パスキー登録をお願いします。\n登録リンク: ${url}` });
  const context = selectContext([item], { sessionId: f.input.session_id, now, home: f.home });
  assert.ok(context.includes(url)); f.inject([item]);
  assert.ok(f.judge().reason.includes(url));
});

test('hundreds of reserved asks rotate in bounded batches without starving progress', async t => {
  const f = fixture(t), base = await addItem(f.home, { kind: 'ask', text: '承認待ち', priority: 'high' });
  const items = Array.from({length:150}, (_,n)=>({...base, id:`ki-20261112000000-${n.toString(16).padStart(4,'0')}`, shownSessions:[], shownCount:0}));
  const info = await addItem(f.home, { text: '完了: テスト成功', priority: 'high' }); items.push(info);
  const first = selectContext(items, {sessionId:f.input.session_id, now, home:f.home});
  assert.ok(first.includes(info.id));
  assert.ok(items.filter(i=>i.shownCount>0).length <= 11);
  const initial = new Set(items.filter(i=>i.shownCount>0).map(i=>i.id));
  selectContext(items,{sessionId:f.input.session_id,now,home:f.home});
  assert.ok(items.some(i=>i.shownCount>0 && !initial.has(i.id)));
});
