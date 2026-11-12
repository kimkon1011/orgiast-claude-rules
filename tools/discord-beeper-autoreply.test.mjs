import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce, DISCORD_ACCOUNT, messageLink, isMessageRequest } from './discord-beeper-autoreply.mjs';

const NOW = Date.parse('2026-11-12T04:00:00Z');
const reply = { needs_reply: true, needs_kim_decision: false, answer: 'マニュアルの一覧から確認できます。', confidence: 0.95 };
const account = { accountID: DISCORD_ACCOUNT, network: 'Discord', user: { isSelf: true, id: 'kim' } };
const message = (overrides = {}) => ({ id: 'm1', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 1000).toISOString(), sortKey: '2', text: 'マニュアルはどこですか？', senderName: '田中', isSender: false, ...overrides });
const chat = (overrides = {}) => ({ id: 'chat1', localChatID: '828', accountID: DISCORD_ACCOUNT, title: '相談', type: 'single', ...overrides });
function fixture(t, { chats = [chat()], messages, decision = reply } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-autoreply-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const data = Object.fromEntries(chats.map(c => [c.id, messages || [message(), own]]));
  const sent = [], notices = [], reads = [];
  const api = {
    getAccounts: async () => [account],
    listChats: async () => ({ items: chats, hasMore: false }),
    getChat: async id => chats.find(c => c.id === id),
    listMessages: async id => { reads.push(id); return { items: data[id], hasMore: false }; },
    sendMessage: async (id, content, options) => {
      sent.push({ id, content, options });
      data[id] = [message({ id: 'sent' + id, timestamp: new Date(NOW).toISOString(), isSender: true, text: content }), ...data[id]];
      return { id: 'sent' + id };
    },
  };
  const options = { home, now: () => NOW, api, llm: async () => JSON.stringify(decision), sleepImpl: async () => {},
    notifyKimImpl: async (text, opts) => { notices.push({ text, ...opts }); return { delivered: 'dm' }; } };
  const file = path.join(home, '.claude/discord-beeper-autoreply/state.json');
  const save = state => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); };
  return { options, api, home, file, save, data, sent, notices, reads, state: () => JSON.parse(fs.readFileSync(file)) };
}
test('既読 single を自動送信し本文読み戻し、全文報告、二重返信なし', async t => {
  const f = fixture(t);
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /^【AI自動返信】/);
  assert.equal(f.sent[0].options.replyToMessageID, 'm1');
  assert.equal(f.state().chats.chat1.status, 'sent');
  assert.equal(f.notices[0].category, 'autoreply-sent'); assert.ok(f.notices[0].text.includes(f.sent[0].content));
  await runOnce(f.options); assert.equal(f.sent.length, 1); assert.equal(f.notices.length, 1);
});
test('group の空 mentions でも HTML 金功勇メンションを拾い金額は判断待ち', async t => {
  const f = fixture(t, { chats: [chat({ type: 'group' })] });
  f.data.chat1[0].text = '<p><a href="https://matrix.to/#/kim">金功勇</a> 検品結果をご確認のうえ請求の金額をご教示ください</p>';
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.notices[0].category, 'autoreply-decision');
  await runOnce(f.options); assert.equal(f.notices.length, 1);
});
for (const request of [{ capabilities: { messageRequest: { acceptWithMessage: 1 } } }, { isMessageRequest: true }, { participants: { items: [{ isPending: true }] } }]) {
  test('メッセージリクエストは FYI 判定より先に判断待ち: ' + JSON.stringify(request), async t => {
    const f = fixture(t, { chats: [chat(request)], decision: { ...reply, needs_reply: false } });
    f.options.llm = async () => { throw new Error('LLM must not run'); };
    const result = await runOnce(f.options);
    assert.equal(isMessageRequest(chat(request)), true); assert.equal(result.decisions.length, 1); assert.equal(f.sent.length, 0);
  });
}
for (const network of ['LINE', 'WhatsApp', 'Facebook', 'Discord']) {
  test('指定 Discord アカウント以外は API の絞り込みが漏れても絶対に読取・送信しない: ' + network, async t => {
    const foreign = chat({ id: 'other', accountID: network + '.other', network });
    const f = fixture(t, { chats: [foreign] });
    f.api.getAccounts = async () => [account, { accountID: foreign.accountID, network }];
    const result = await runOnce(f.options);
    assert.equal(result.ok, true); assert.equal(f.sent.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.notices.length, 0);
  });
}
test('指定 accountID でも accounts が Discord と証明しなければ停止', async t => {
  const f = fixture(t); f.api.getAccounts = async () => [{ ...account, network: 'LINE' }];
  assert.equal((await runOnce(f.options)).ok, false); assert.equal(f.sent.length, 0);
});
test('既読 group の kim への返信は処理し、他メンバー宛だけなら返信しない', async t => {
  const f = fixture(t, { chats: [chat({ type: 'group' })] });
  await runOnce(f.options); assert.equal(f.sent.length, 0);
  f.data.chat1[0].linkedMessageID = 'own';
  await runOnce(f.options); assert.equal(f.sent.length, 1);
});
test('FYI は送信も DM もせず台帳へ保存', async t => {
  const f = fixture(t, { decision: { ...reply, needs_reply: false } });
  await runOnce(f.options); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 0); assert.equal(f.state().chats.chat1.status, 'fyi');
});
for (const overrides of [{ needs_kim_decision: true }, { answer: '【要kim判断】承認をお願いします' }, { confidence: 0.3 }]) {
  test('人の判断が必要な回答は送らない: ' + JSON.stringify(overrides), async t => {
    const f = fixture(t, { decision: { ...reply, ...overrides } });
    assert.equal((await runOnce(f.options)).decisions.length, 1); assert.equal(f.sent.length, 0);
  });
}
test('初対面・履歴なしは判断待ち', async t => {
  const f = fixture(t, { messages: [message()] });
  assert.equal((await runOnce(f.options)).decisions.length, 1); assert.equal(f.sent.length, 0);
});
test('dry-run は送信・DM・台帳・ロック作成なし、既存台帳も変更なし', async t => {
  const f = fixture(t); f.options.dryRun = true;
  const result = await runOnce(f.options);
  assert.equal(result.wouldSend.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 0);
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
  f.save({ version: 1, chats: {}, hourly: [], outbox: {} }); const before = fs.readFileSync(f.file, 'utf8');
  await runOnce(f.options); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('dry-run は金額質問とリクエストを判断待ちにする', async t => {
  const f = fixture(t, { chats: [chat({ capabilities: { messageRequest: {} } })] }); f.options.dryRun = true;
  assert.equal((await runOnce(f.options)).decisions[0].classification, '判断待ち'); assert.equal(f.notices.length, 0);
});
test('生成中の kim 返信は送信直前に検出', async t => {
  const f = fixture(t); f.options.llm = async () => { f.data.chat1.unshift(message({ id: 'kim2', isSender: true, timestamp: new Date(NOW).toISOString() })); return JSON.stringify(reply); };
  await runOnce(f.options); assert.equal(f.sent.length, 0);
});
test('送信直前のアカウント変更・リクエスト・下書きは判断待ち', async t => {
  for (const changed of [{ accountID: 'line.x' }, { capabilities: { messageRequest: {} } }, { draft: '手入力中' }]) {
    const f = fixture(t); f.api.getChat = async () => chat(changed);
    assert.equal((await runOnce(f.options)).decisions.length, 1); assert.equal(f.sent.length, 0);
  }
});
test('送信前の読取失敗は送らず判断待ち', async t => {
  const f = fixture(t); let calls = 0; const original = f.api.listMessages;
  f.api.listMessages = async (...args) => { if (++calls > 1) throw new Error('offline'); return original(...args); };
  assert.equal((await runOnce(f.options)).decisions.length, 1); assert.equal(f.sent.length, 0);
});
test('送信後の読取失敗は uncertain に固定し再送しない', async t => {
  const f = fixture(t); f.api.sendMessage = async (id, content) => { f.sent.push(content); return { id: 'not-visible' }; };
  assert.equal((await runOnce(f.options)).decisions.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.state().chats.chat1.status, 'uncertain');
  await runOnce(f.options); assert.equal(f.sent.length, 1); assert.equal(f.notices.length, 1);
});
test('POST タイムアウトも再送しない。送信前に台帳へ記録済み', async t => {
  const f = fixture(t); f.api.sendMessage = async () => { assert.equal(f.state().chats.chat1.status, 'sending'); f.sent.push('attempt'); throw new Error('timeout'); };
  await runOnce(f.options); await runOnce(f.options); assert.equal(f.sent.length, 1); assert.equal(f.state().hourly.length, 1);
});
test('sending 状態での再起動は再送せず判断待ちを一度だけ通知', async t => {
  const f = fixture(t); f.save({ version: 1, chats: { chat1: { ...message(), status: 'sending' } }, hourly: [NOW], outbox: {} });
  await runOnce(f.options); await runOnce(f.options); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 1);
});
test('通知失敗が返信済み台帳を壊さず次回 outbox を配送できる', async t => {
  const f = fixture(t), notify = f.options.notifyKimImpl;
  f.options.notifyKimImpl = async () => { throw new Error('offline'); };
  const first = await runOnce(f.options); assert.equal(first.ok, true); assert.ok(first.notificationErrors.length);
  assert.equal(f.sent.length, 1); assert.equal(Object.keys(f.state().outbox).length, 1);
  f.options.notifyKimImpl = notify; await runOnce(f.options);
  assert.equal(f.sent.length, 1); assert.equal(f.notices.length, 1); assert.equal(Object.keys(f.state().outbox).length, 0);
});
test('1回5件、1時間30件を越えて送信しない', async t => {
  const chats = Array.from({ length: 7 }, (_, i) => chat({ id: 'c' + i }));
  const f = fixture(t, { chats }); assert.equal((await runOnce(f.options)).replied, 5);
  const g = fixture(t, { chats }); g.save({ version: 1, chats: {}, hourly: Array(29).fill(NOW - 1000), outbox: {} });
  assert.equal((await runOnce(g.options)).replied, 1); assert.equal(g.state().hourly.length, 30);
  await runOnce(g.options); assert.equal(g.sent.length, 1);
});
test('破損台帳と重複プロセスは fail closed', async t => {
  const f = fixture(t); f.save({ broken: true });
  assert.equal((await runOnce(f.options)).ok, false); assert.equal(f.sent.length, 0);
  fs.writeFileSync(path.join(path.dirname(f.file), 'lock'), 'active');
  assert.equal((await runOnce(f.options)).locked, true); assert.equal(f.sent.length, 0);
});
test('処理済みより古いメッセージを再処理しない', async t => {
  const f = fixture(t); f.save({ version: 1, chats: { chat1: { ...message({ id: 'newer', timestamp: new Date(NOW).toISOString() }), status: 'sent' } }, hourly: [], outbox: {} });
  await runOnce(f.options); assert.equal(f.sent.length, 0);
});
test('リンクは明示 native IDs → 会話名、内部数値IDを使わない', () => {
  assert.equal(messageLink(chat({ id: '828' }), message({ id: '7405' })), '会話名: 相談');
  assert.equal(messageLink(chat({ discordChannelID: '123456789012345678' }), message({ discordMessageID: '234567890123456789' })), 'https://discord.com/channels/@me/123456789012345678/234567890123456789');
  assert.equal(messageLink(chat({ deepLink: 'beeper://room/abc' }), message()), '会話名: 相談');
});

test('送信後クラッシュからの復旧は読み戻して報告し再送しない', async t => {
  const f = fixture(t); const content = '【AI自動返信】\n回答';
  f.save({ version: 1, chats: { chat1: { ...message(), content, question: '質問', status: 'sending' } }, hourly: [NOW], outbox: {} });
  f.data.chat1.unshift(message({ id: 'actual-sent', isSender: true, text: content, timestamp: new Date(NOW).toISOString() }));
  await runOnce(f.options); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].category, 'autoreply-sent'); assert.equal(f.state().chats.chat1.replyId, 'actual-sent');
});
test('kim が後で対応し新しい質問が来たら uncertain の会話も復帰できる', async t => {
  const f = fixture(t); f.save({ version: 1, chats: { chat1: { ...message({ id: 'old-message', timestamp: new Date(NOW - 6000).toISOString() }), status: 'uncertain' } }, hourly: [], outbox: {} });
  await runOnce(f.options); assert.equal(f.sent.length, 1);
});
test('既存の同文返信は読み戻し成功と誤認しない', async t => {
  const f = fixture(t); f.data.chat1[1].text = '【AI自動返信】\n' + reply.answer;
  f.api.sendMessage = async () => ({ pendingMessageID: 'pending' });
  await runOnce(f.options); assert.equal(f.state().chats.chat1.status, 'uncertain');
});
test('pendingMessageID を返す Beeper の実形式でも新しい本文を読み戻す', async t => {
  const f = fixture(t); const send = f.api.sendMessage;
  f.api.sendMessage = async (...args) => { await send(...args); return { chatID: 'chat1', pendingMessageID: 'pending' }; };
  assert.equal((await runOnce(f.options)).replied, 1);
});
test('チャットの複数ページと過去ページの kim 発言を辿る', async t => {
  const f = fixture(t); let pages = 0;
  f.api.listChats = async ({ cursor }) => { pages++; return cursor ? { items: [chat()], hasMore: false } : { items: [], hasMore: true, oldestCursor: 'next' }; };
  f.api.listMessages = async (id, { cursor }) => f.sent.length ? { items: f.data[id], hasMore: false }
    : cursor ? { items: [f.data[id][1]], hasMore: false } : { items: [f.data[id][0]], hasMore: true, oldestCursor: 'older' };
  assert.equal((await runOnce(f.options)).replied, 1); assert.equal(pages, 2);
});
test('読取エラーを再通知し続けない', async t => {
  const f = fixture(t); f.api.listMessages = async () => { throw new Error('offline'); };
  await runOnce(f.options); await runOnce(f.options); assert.equal(f.notices.length, 1); assert.equal(f.sent.length, 0);
});
test('既に判断待ちにした質問を次の FYI と結合して再通知しない', async t => {
  const f = fixture(t, { chats: [chat({ type: 'group' })] });
  f.data.chat1[0].text = '金功勇 金額を教えてください';
  await runOnce(f.options); assert.equal(f.notices.length, 1);
  f.data.chat1.unshift(message({ id: 'fyi2', timestamp: new Date(NOW).toISOString(), text: '金功勇 資料を送ります' }));
  f.options.llm = async () => JSON.stringify({ ...reply, needs_reply: false });
  await runOnce(f.options); assert.equal(f.notices.length, 1); assert.equal(f.sent.length, 0);
});

test('プレビューが kim の最終発言なら履歴を読まず次へ進む', async t => {
  const f = fixture(t, { chats: [chat({ preview: { isSender: true } })] });
  await runOnce(f.options); assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
});
test('メッセージリクエストは古い履歴を全ページ読まず判断待ちにする', async t => {
  const f = fixture(t, { chats: [chat({ capabilities: { messageRequest: {} } })], messages: [message()] });
  f.api.listMessages = async (id, params) => { f.reads.push(id); assert.equal(params.cursor, undefined); return { items: [message()], hasMore: true, oldestCursor: 'older' }; };
  await runOnce(f.options); assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 1);
});

test('リクエストの最新プレビューを判断待ちに使い履歴取得を省く', async t => {
  const f = fixture(t, { chats: [chat({ capabilities: { messageRequest: {} }, preview: message() })] });
  await runOnce(f.options); await runOnce(f.options);
  assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].text, /マニュアルはどこですか/);
});

test('履歴が不完全でも kim 宛でないグループ発言を判断待ち通知しない', async t => {
  const f = fixture(t, { chats: [chat({ type: 'group' })], messages: [message()] });
  f.api.listMessages = async () => ({ items: [message()], hasMore: true });
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.notices.length, 0);
});

for (const needsDecision of [false, true]) {
  test(`kim通知にDiscord会話リンクを含める: ${needsDecision ? '判断待ち' : '代理返信'}`, async t => {
    const f = fixture(t, { chats: [chat({ discordChannelID: '1547513352513790113' })],
      decision: { ...reply, needs_kim_decision: needsDecision } });
    await runOnce(f.options);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].category, needsDecision ? 'autoreply-decision' : 'autoreply-sent');
    assert.ok(f.notices[0].text.includes('https://discord.com/channels/@me/1547513352513790113'));
  });
}
