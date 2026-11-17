import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems, answerItem, updateInboxItem, main, selectContext, oneScreenSummary } from './kim-inbox.mjs';
import { commitKimInboxDelivery, evaluateKimInboxRelay } from './kim-inbox-relay.mjs';
import { revisionOf, recordPromptAnswers, recordInjection } from './lib/kim-inbox-relay-state.mjs';
import { matchPromptAnswers, presentedTargets } from './lib/kim-answer-match.mjs';
import { inboxCounts } from './lib/kim-inbox-category.mjs';
import { apId, collectAwaiting, promptAwaitingCandidates, answerFromPrompt, readJson, saveJson, shownFile, awaitingRevision } from './kim-awaiting.mjs';
import { context } from './kim-awaiting-context.mjs';
import { ledgerFile, writeLedger, readLedger } from './auto-progress-ledger.mjs';
import { externalFile, answersDir } from './lib/external-waiting-state.mjs';
const NOW = Date.parse('2026-11-17T02:40:00Z');
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/kim-chat-replies.json', import.meta.url), 'utf8'));
const reply = id => real.replies.find(r => r.uuid === id).prompt;
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-chat-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const sessionId = 'human-session';
  return { home, sessionId,
    delivered(items) { commitKimInboxDelivery(home, sessionId, items.map((item, i) => ({ id: item.id, revision: revisionOf(item), number: i + 1 })), NOW); },
    answer(prompt, opts = {}) { return recordPromptAnswers(home, sessionId, prompt, { listItems, answerItem, now: NOW, ...opts }); } };
}
const apRow = (extra = {}) => ({ pc: 'PC-A', user: 'u', sessionId: 'origin-session', ts: '2026-11-16T00:00:00Z', cwd: '/project', promise: '公開鍵の配布', status: 'waiting_user', nextKim: '公開鍵を入れてよいですか', ...extra });

test('実返事1: 1.削除して良い〜4.OK を一つの ask の4問として記録する（操作は実行しない）', async () => {
  const f = fixture();
  const text = '鍵付き化の承認待ち\n1. 平文を削除してよいか\n2. 編集者を外してよいか\n3. 監視権限を追加してよいか\n4. 毎回 kim が判断するか';
  const item = await addItem(f.home, { kind: 'ask', text }); f.delivered([item]);
  const assistantText = `【受信箱】\n- ${item.id} 鍵付き化の承認待ち\n${text}`;
  assert.equal(f.answer(reply('92405d67-4bab-4435-8820-9281fd82aa52'), { assistantText }).length, 1);
  const saved = listItems(f.home)[0];
  assert.equal(saved.status, 'answered');
  assert.equal(saved.answer, '1. 削除して良い\n2. 外して良い\n3. 良い\n4. OK');
  assert.equal(saved.answerSession, f.sessionId);
});

test('実返事2: 上の4・5まで入れてよい + 別の依頼文を、明確な同一番号の提示に照合する', async () => {
  const f = fixture(), items = [];
  for (let n = 1; n <= 5; n++) items.push(await addItem(f.home, { kind: 'ask', text: `鍵付き化の項目${n}を追加するか` }));
  f.delivered(items);
  const assistantText = items.map((item, i) => `${i + 1}. ${item.text} (${item.id})`).join('\n');
  assert.equal(f.answer(reply('873a6562-9772-4d69-b420-0c7f650f8cb0'), { assistantText }).length, 2);
  const saved = listItems(f.home);
  assert.equal(saved.filter(item => item.status === 'answered').length, 2);
  for (const item of saved.filter(item => item.status === 'answered')) assert.equal(item.answer, '入れてよい。');
});

test('実返事2の元の提示: 受信箱4・5と鍵付き化の案4・5は競合するため未記録＋1行確認', async () => {
  const f = fixture(), items = [];
  for (let n = 1; n <= 5; n++) items.push(await addItem(f.home, { kind: 'ask', text: `別件の返事待ち${n}` }));
  f.delivered(items);
  const assistantText = items.map((item, i) => `${i + 1}. ${item.id} ${item.text}`).join('\n')
    + '\n次に kim がすること: 鍵付き化の案は、4・5まで入れるか、1〜3のみにするかを返信してください。受信箱の1〜5は「番号と答え」で返信してください。';
  const result = f.answer(reply('873a6562-9772-4d69-b420-0c7f650f8cb0'), { assistantText });
  assert.equal(result.length, 0);
  assert.match(result.confirmation, /この返事は.*鍵付き化の案.*違えば言ってください/);
  assert.ok(listItems(f.home).every(item => item.status === 'open'));
});

test('実返事3: 今晩じゃなく今からやって を awaiting ap: の同じ --answer 経路へ記録', () => {
  const f = fixture(), row = apRow({ promise: '夜間ジョブを開始する', nextKim: '今夜から着手するか' });
  writeLedger(ledgerFile(f.home), [row]);
  const items = collectAwaiting({ home: f.home, now: NOW });
  context({ session_id: f.sessionId, cwd: '/project' }, { home: f.home, env: {}, now: NOW });
  const awaiting = promptAwaitingCandidates(f.home, f.sessionId, items, NOW);
  const result = f.answer(reply('3d8e489e-2df1-4430-9ce1-859f8ef3a839'), { awaiting, assistantText: `${items[0].title}\n今夜23時に着手します。`,
    answerAwaiting: (id, body) => answerFromPrompt(id, body, { home: f.home, now: NOW, spawnImpl: () => assert.fail('ap has no outbound route') }) });
  assert.equal(result.length, 1);
  assert.equal(readLedger(ledgerFile(f.home))[0].kimAnswer, 'こちら今晩じゃなく今からやって。');
  assert.deepEqual(collectAwaiting({ home: f.home, now: NOW }), []);
});

test('実返事4: 進捗どう？は回答にしない', async () => {
  const f = fixture(), item = await addItem(f.home, { kind: 'ask', text: '公開鍵を入れるか' }); f.delivered([item]);
  assert.equal(f.answer(reply('32cac7c1-e99d-4e3c-84af-4cd386e12d03')).length, 0);
  assert.equal(listItems(f.home)[0].status, 'open');
});

test('自然文・否定・題名・ID・インライン複数回答・部分成功・保留・条件・引用', () => {
  const targets = [{ id: 'ap:aaaaaaaaaaaa', title: '公開鍵の配布', number: 1 }, { id: 'fm:mail-test', title: '見積書の提出', number: 2 }];
  for (const [text, ids] of [
    ['公開鍵は入れてよい', ['ap:aaaaaaaaaaaa']], ['見積書は不要', ['fm:mail-test']],
    ['1. 良い 2.OK', targets.map(t => t.id)], ['1 お願い\n2 不可\n作業を調べて', targets.map(t => t.id)],
    ['ap:aaaaaaaaaaaa 進めて', ['ap:aaaaaaaaaaaa']], ['2 進めないで', ['fm:mail-test']],
    ['1 保留\n2 OK', ['fm:mail-test']], ['1 良いなら進めて', []], ['1 良いですか？', []],
    ['> 1 OK\n```\n2 可\n```', []], ['例: 1 可', []], ['Stop hook feedback:\n1 OK', []],
  ]) assert.deepEqual(matchPromptAnswers(text, targets).matches.map(m => m.target.id), ids, text);
  for (const text of ['OK', '他のデータも削除して良い']) {
    const result = matchPromptAnswers(text, targets);
    assert.equal(result.matches.length, 0); assert.ok(result.uncertain.length);
  }
  assert.equal(matchPromptAnswers('他のデータも削除して良い', targets.slice(0, 1)).matches.length, 0);
  assert.equal(matchPromptAnswers('1 可\n1 不可', targets).matches.length, 0);
});

test('まとめ ask の部分回答を蓄積し、全問揃うまで answered にしない', async () => {
  const f = fixture(), item = await addItem(f.home, { kind: 'ask', text: '2つの判断\n1. 配布してよいか\n2. 公開してよいか' }); f.delivered([item]);
  assert.equal(f.answer('1 良い').length, 0);
  assert.equal(listItems(f.home)[0].status, 'open');
  assert.equal(f.answer('2 不可').length, 1);
  assert.equal(listItems(f.home)[0].answer, '1. 良い\n2. 不可');
});

test('stale revision / delivery / session / last assistant / unpresented awaiting are rejected', async () => {
  const f = fixture(), item = await addItem(f.home, { kind: 'ask', text: '公開鍵の配布' }); f.delivered([item]);
  assert.equal(f.answer('1 OK', { now: NOW + 8 * 86400_000 }).length, 0);
  assert.equal(f.answer('1 OK', { assistantText: '別の作業の報告だけ' }).length, 0);
  updateInboxItem(f.home, item.id, i => { i.text = '新しい公開鍵の配布'; });
  assert.equal(f.answer('1 OK').length, 0);
  assert.equal(recordPromptAnswers(f.home, 'other-session', '1 OK', { listItems, answerItem, now: NOW }).length, 0);
  const row = apRow(); writeLedger(ledgerFile(f.home), [row]);
  assert.deepEqual(promptAwaitingCandidates(f.home, f.sessionId, collectAwaiting({ home: f.home, now: NOW }), NOW), []);
  context({ session_id: f.sessionId }, { home: f.home, now: NOW, env: {} });
  const items = collectAwaiting({ home: f.home, now: NOW });
  assert.deepEqual(presentedTargets(promptAwaitingCandidates(f.home, f.sessionId, items, NOW), '別件'), []);
  assert.deepEqual(promptAwaitingCandidates(f.home, f.sessionId, [{ ...items[0], ask: '変更した質問' }], NOW), []);
});

test('awaiting fm: は既存の内部回答ルートを使い、失敗時は未回答のまま', () => {
  const f = fixture(); let invocation;
  const item = { id: 'fm:mail-question-one', title: '公開鍵の配布', ask: '配布してよいか', route: { mailId: 'mail-question-one' } };
  saveJson(shownFile(f.home), { [f.sessionId]: { at: NOW, ids: [item.id], candidates: [{ ...item, revision: awaitingRevision(item) }] } });
  const opts = { awaiting: promptAwaitingCandidates(f.home, f.sessionId, [item], NOW), assistantText: '1. 公開鍵の配布',
    answerAwaiting: (id, answer) => answerFromPrompt(id, answer, { home: f.home, now: NOW, spawnImpl: (...args) => { invocation = args; return { status: 7 }; } }) };
  assert.equal(f.answer('1 お願い', opts).length, 0);
  assert.equal(invocation[1][1], '--answer');
  assert.match(f.answer('1 お願い', opts).confirmation, /違えば言ってください/);
  opts.answerAwaiting = (id, answer) => answerFromPrompt(id, answer, { home: f.home, now: NOW, spawnImpl: () => ({ status: 0 }) });
  assert.equal(f.answer('1 お願い', opts).length, 1);
  assert.deepEqual(readJson(shownFile(f.home))[f.sessionId].ids, []);
});

test('ex: は送信依頼の文でも answers だけに保存し、新着まで返事待ちから外す', () => {
  const f = fixture(), id = 'ex:aaaaaaaaaaaa';
  const external = { id, kind: 'reply', who: '担当者', subject: '会議の日程', mailbox: 'test@example.invalid', since: '2026-11-17T01:00:00Z', threadId: 'thread-test', lastMessageId: 'message-1' };
  saveJson(externalFile(f.home), { generatedAt: new Date(NOW).toISOString(), sources: {}, items: [external] });
  context({ session_id: f.sessionId }, { home: f.home, now: NOW, env: {} });
  const items = collectAwaiting({ home: f.home, now: NOW });
  const awaiting = promptAwaitingCandidates(f.home, f.sessionId, items, NOW);
  assert.equal(f.answer(`${id} この内容で送信をお願いします`, { awaiting, assistantText: `1. ${items[0].title}`,
    answerAwaiting: (id, answer) => answerFromPrompt(id, answer, { home: f.home, now: NOW, spawnImpl: () => assert.fail('ex must never spawn a sender') }) }).length, 1);
  assert.match(readJson(path.join(answersDir(f.home), 'aaaaaaaaaaaa.json')).answer, /送信をお願いします/);
  assert.deepEqual(collectAwaiting({ home: f.home, now: NOW }), []);
  saveJson(externalFile(f.home), { generatedAt: new Date(NOW).toISOString(), sources: {}, items: [{ ...external, lastMessageId: 'message-2' }] });
  assert.equal(collectAwaiting({ home: f.home, now: NOW })[0].id, id);
});

test('gate-report ask/info は通知に分け、既存レコードを保持して判断待ちとStopから除外', async () => {
  const f = fixture();
  const gate = await addItem(f.home, { kind: 'ask', source: 'gate-report', text: 'gate pc=PC name=handover-doc-gate verdict=deny remedy=tools/gate-remedies.md' });
  const legacy = await addItem(f.home, { kind: 'info', text: '旧ゲート通知' });
  updateInboxItem(f.home, legacy.id, i => { i.text = 'gate pc=PC name=handover-doc-gate verdict=deny'; });
  const decision = await addItem(f.home, { kind: 'ask', text: '公開鍵の配布を承認してよいか' });
  const items = listItems(f.home);
  assert.deepEqual(inboxCounts(items), { decision: 1, information: 0, notification: 2, deadline: 0 });
  const text = selectContext(items, { home: f.home, sessionId: f.sessionId, now: NOW });
  assert.ok(text.includes(decision.id)); assert.ok(!text.includes(gate.id)); assert.ok(!text.includes(legacy.id));
  assert.match(oneScreenSummary(items), /返事待ち 1件/);
  recordInjection(f.home, f.sessionId, [gate], { now: NOW });
  assert.equal(evaluateKimInboxRelay({ session_id: f.sessionId }, { home: f.home, env: {}, now: NOW, text: '' }).decision, 'pass');
  assert.ok(listItems(f.home).every(item => item.status === 'open'));
});

test('UserPromptSubmit 本番エントリで transcript の題名から ap を自動記録、他アカウントでは記録しない', async () => {
  for (const kim of [true, false]) {
    const f = fixture(), row = apRow();
    if (!kim) fs.writeFileSync(path.join(f.home, '.claude.json'), '{}');
    writeLedger(ledgerFile(f.home), [row]);
    // Runtime main uses wall clock; the presentation snapshot must be current too.
    context({ session_id: f.sessionId, cwd: '/project' }, { home: f.home, env: {}, now: Date.now() });
    const transcript = path.join(f.home, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '公開鍵の配布\n答えてほしいこと: 公開鍵を入れてよいですか' }] } }) + '\n');
    assert.equal(await main(['--context'], { home: f.home, stdout() {}, readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: f.sessionId, transcript_path: transcript, cwd: '/project', prompt: '公開鍵は入れてよい' }) }), 0);
    assert.equal(Boolean(readLedger(ledgerFile(f.home))[0].kimAnswer), kim);
  }
});
