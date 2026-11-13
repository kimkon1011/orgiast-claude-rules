import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce, DISCORD_ACCOUNT, messageLink, isMessageRequest } from './discord-beeper-autoreply.mjs';

const NOW = Date.parse('2026-11-12T04:00:00Z'); // 13:00 JST (allowed window)
const reply = { needs_reply: true, needs_kim_decision: false, answer: 'マニュアルの一覧から確認できます。', confidence: 0.95 };
const account = { accountID: DISCORD_ACCOUNT, network: 'Discord', user: { isSelf: true, id: 'kim' } };
const message = (overrides = {}) => ({ id: 'm1', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 1000).toISOString(), sortKey: '2', text: 'マニュアルはどこですか？', senderName: '田中', isSender: false, ...overrides });
const chat = (overrides = {}) => ({ id: 'chat1', localChatID: '828', accountID: DISCORD_ACCOUNT, title: '相談', type: 'single', ...overrides });

function fixture(t, { chats = [chat()], messages, decision = reply } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-autoreply-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const data = Object.fromEntries(chats.map(c => [c.id, messages || [message(), own]]));
  const sent = [], inboxItems = [], reads = [];
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
  const addItemImpl = async (homeDir, item) => {
    inboxItems.push(item);
    return { id: `ki-test-${inboxItems.length}` };
  };
  const options = {
    home, now: () => NOW, api, llm: async () => JSON.stringify(decision), sleepImpl: async () => {},
    addItemImpl
  };
  const file = path.join(home, '.claude/discord-beeper-autoreply/state.json');
  const save = state => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); };
  return { options, api, home, file, save, data, sent, inboxItems, reads, state: () => JSON.parse(fs.readFileSync(file)) };
}

test('既読 single を自動送信し本文読み戻し、kim-inboxへinfo記録、二重返信なし', async t => {
  const f = fixture(t);
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /^【kimのClaudeによる代理回答】/);
  assert.equal(f.sent[0].options.replyToMessageID, 'm1');
  assert.equal(f.state().chats.chat1.status, 'sent');
  assert.equal(f.inboxItems.length, 1);
  assert.equal(f.inboxItems[0].kind, 'info');
  assert.match(f.inboxItems[0].text, /\[Discord 代理回答完了 \(dm\)\]/);
  await runOnce(f.options); assert.equal(f.sent.length, 1); assert.equal(f.inboxItems.length, 1);
});

test('group の空 mentions でも HTML 金功勇メンションを拾い金額は暫定回答を送信', async t => {
  const f = fixture(t, { chats: [chat({ type: 'group' })] });
  f.data.chat1[0].text = '<p><a href="https://matrix.to/#/kim">金功勇</a> 検品結果をご確認のうえ請求の金額をご教示ください</p>';
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 1); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /kim 本人が確認後、訂正する場合があります/);
  assert.equal(f.inboxItems.length, 2);
  assert.equal(f.inboxItems[0].kind, 'ask');
  assert.doesNotMatch(f.inboxItems[0].text, /転送/);
});

test('capabilities.messageRequest オブジェクトだけではメッセージリクエスト判定しない', async t => {
  const f = fixture(t, { chats: [chat({ capabilities: { messageRequest: { acceptWithMessage: 1, acceptWithButton: 2 } } })] });
  const result = await runOnce(f.options);
  assert.equal(isMessageRequest(chat({ capabilities: { messageRequest: { acceptWithMessage: 1 } } })), false);
  assert.equal(result.replied, 1); assert.equal(f.sent.length, 1);
});

test('リクエスト状態はboolean trueのみ（能力やオブジェクトは除外）', () => {
  for (const key of ['isMessageRequest', 'isRequest', 'messageRequest']) {
    for (const value of [{ acceptWithMessage: 1 }, 'true', 1, false]) {
      assert.equal(isMessageRequest(chat({ [key]: value })), false);
    }
    assert.equal(isMessageRequest(chat({ [key]: true })), true);
  }
});

test('古いリクエストのpreviewもaskに積まない', async t => {
  const f = fixture(t, { chats: [chat({ isRequest: true, preview: message({ timestamp: new Date(NOW - 25 * 3600000).toISOString() }) })] });
  const result = await runOnce(f.options);
  assert.equal(result.skipped, 1);
  assert.equal(f.sent.length, 0); assert.equal(f.inboxItems.length, 0);
});

for (const complete of [true, false]) {
  test(`kim発言なし: history.complete=${complete}`, async t => {
    const f = fixture(t, { messages: [message()] });
    f.api.listMessages = async () => ({ items: f.data.chat1, hasMore: !complete });
    const result = await runOnce({ ...f.options, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.wouldSend.length, complete ? 0 : 1);
    assert.equal(result.decisions.length, complete ? 1 : 0);
    assert.equal(f.inboxItems.length, 0);
  });
}

test('添付のみは初対面でもFYI', async t => {
  const f = fixture(t, { messages: [message({ text: '', attachments: [{ mimeType: 'image/png' }] })] });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(result.decisions.length, 0);
  assert.equal(f.state().chats.chat1.status, 'fyi');
  assert.equal(f.sent.length, 0); assert.equal(f.inboxItems.length, 0);
});

test('別メッセージの本文と添付名・mimeTypeをまとめてLLMへ渡す', async t => {
  const f = fixture(t);
  f.data.chat1.push(message({ id: 'image', sortKey: '3', text: '', attachments: [{ fileName: 'photo.png' }, { mimeType: 'application/pdf' }] }));
  f.options.llm = async ({ input }) => {
    assert.match(input.message.content, /マニュアルはどこですか/);
    assert.match(input.message.content, /（画像\/ファイル添付あり: photo.png, application\/pdf）/);
    return JSON.stringify(reply);
  };
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(result.replied, 1);
});

test('暫定回答のdry-runはaskも永続化もしない', async t => {
  const f = fixture(t, { decision: { ...reply, needs_reply: false, needs_kim_decision: true } });
  const result = await runOnce({ ...f.options, dryRun: true });
  assert.equal(result.ok, true); assert.equal(result.wouldSend.length, 1);
  assert.match(result.wouldSend[0].content, /\n（kim 本人が確認後、訂正する場合があります）\n/);
  assert.equal(f.inboxItems.length, 0); assert.equal(fs.existsSync(f.file), false);
});

for (const request of [{ isMessageRequest: true }, { participants: { items: [{ isPending: true }] } }]) {
  test('メッセージリクエストは FYI 判定より先に判断待ち: ' + JSON.stringify(request), async t => {
    const f = fixture(t, { chats: [chat(request)], decision: { ...reply, needs_reply: false } });
    f.options.llm = async () => { throw new Error('LLM must not run'); };
    const result = await runOnce(f.options);
    assert.equal(isMessageRequest(chat(request)), true); assert.equal(result.decisions.length, 1); assert.equal(f.sent.length, 0);
  });
}

for (const network of ['LINE', 'WhatsApp', 'Facebook']) {
  test('Discord 以外のネットワークは絶対に自動返信しない: ' + network, async t => {
    const foreign = chat({ id: 'other', accountID: network + '.other', network });
    const f = fixture(t, { chats: [foreign] });
    f.api.getAccounts = async () => [account, { accountID: foreign.accountID, network }];
    const result = await runOnce(f.options);
    assert.equal(result.ok, true); assert.equal(f.sent.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.inboxItems.length, 0);
  });
}

test('指定 accountID でも accounts が Discord と証明しなければ停止', async t => {
  const f = fixture(t); f.api.getAccounts = async () => [{ ...account, network: 'LINE' }];
  assert.equal((await runOnce(f.options)).ok, false); assert.equal(f.sent.length, 0);
});

test('時間の枠外 (22:00 JST) では自動送信しない', async t => {
  const f = fixture(t);
  // 2026-11-12 13:00 UTC = 22:00 JST (outside 08:00 - 21:00 JST)
  const nightTime = Date.parse('2026-11-12T13:00:00Z');
  f.options.now = () => nightTime;
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(f.sent.length, 0);
});

test('1時間以内に同じ相手へ4通目は送信しない (recipient rate limit)', async t => {
  const f = fixture(t);
  f.save({ version: 1, chats: { chat1: {} }, hourly: [], hourlyByChat: { chat1: [NOW - 5000, NOW - 4000, NOW - 3000] } });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(f.sent.length, 0);
});

test('人の判断が必要な回答は暫定回答を送信し kim-inbox ask にも積む', async t => {
  const f = fixture(t, { decision: { ...reply, needs_kim_decision: true } });
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /kim 本人が確認後、訂正する場合があります/);
  assert.equal(f.inboxItems.length, 2);
  assert.equal(f.inboxItems[0].kind, 'ask');
  assert.doesNotMatch(f.inboxItems[0].text, /転送/);
});

test('禁止表現（kimに確認）→ 再生成1回 → 具体回答で送信', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async ({ input }) => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...reply, needs_kim_decision: true, answer: 'kimに確認いたします' });
    assert.equal(input.forbiddenRetry, true); assert.equal(input.previousAnswer, 'kimに確認いたします');
    return JSON.stringify({ ...reply, needs_kim_decision: true, answer: 'まず1個購入で進めてください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.replied, 1);
  assert.match(f.sent[0].content, /まず1個購入/); assert.doesNotMatch(f.sent[0].content, /確認いたします/);
  assert.match(f.sent[0].content, /kim 本人が確認後、訂正する場合があります/);
});
test('禁止表現が2回続いたら送信せず判断待ち（askのみ）', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => {
    calls++;
    return JSON.stringify({ ...reply, needs_kim_decision: true, answer: calls === 1 ? '確認待ちです' : '少々お待ちください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.ok, true);
  assert.equal(f.sent.length, 0);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].reason, 'kim の判断が必要');
  assert.deepEqual(f.inboxItems.map(i => i.kind), ['ask']);
});
test('禁止表現でもneeds_kim_decision=falseなら再生成後そのまま送信', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => {
    calls++;
    return JSON.stringify({ ...reply, answer: calls === 1 ? '転送しました' : 'マニュアルの一覧から確認できます。' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.replied, 1);
  assert.doesNotMatch(f.sent[0].content, /kim 本人が確認後/);
});
test('禁止表現がなければ再生成しない', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => { calls++; return JSON.stringify(reply); };
  const result = await runOnce(f.options);
  assert.equal(calls, 1); assert.equal(result.replied, 1);
});

test('禁止表現が2回続きneeds_kim_decision=falseでも送信せずaskのみ', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => {
    calls++;
    return JSON.stringify({ ...reply, needs_kim_decision: false, answer: calls === 1 ? '確認待ちです' : '少々お待ちください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.ok, true);
  assert.equal(f.sent.length, 0);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].reason, 'kim の判断が必要');
  assert.deepEqual(f.inboxItems.map(i => i.kind), ['ask']);
});

test('センシティブ質問で禁止表現→再生成成功→送信本文に注記＋ask', async t => {
  let calls = 0;
  const f = fixture(t);
  f.data.chat1[0].text = 'この案件の金額を教えてください';
  f.options.llm = async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...reply, needs_kim_decision: false, answer: 'kimに確認いたします' });
    return JSON.stringify({ ...reply, needs_kim_decision: true, answer: 'まず1個購入で進めてください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.replied, 1);
  assert.match(f.sent[0].content, /まず1個購入/);
  assert.match(f.sent[0].content, /kim 本人が確認後、訂正する場合があります/);
  assert.equal(f.inboxItems.length, 2);
  assert.equal(f.inboxItems[0].kind, 'ask');
});

test('人の判断が必要かつ answer が空なら送信せず判断待ちのみ', async t => {
  const f = fixture(t, { decision: { needs_reply: true, needs_kim_decision: true, answer: '', confidence: 0.9 } });
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].reason, 'kim の判断が必要');
  assert.equal(f.inboxItems.length, 1);
  assert.equal(f.inboxItems[0].kind, 'ask');
});

test('24時間より古いメッセージは送信せず skipped（kim-inbox にも積まない）', async t => {
  const oldMsg = message({ id: 'old1', timestamp: new Date(NOW - 25 * 3600000).toISOString() });
  const f = fixture(t, { messages: [oldMsg] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal(f.state().chats.chat1.status, 'skipped');
});

test('ちょうど24時間前は回答対象', async t => {
  const f = fixture(t, { messages: [
    message({ timestamp: new Date(NOW - 24 * 3600000).toISOString() }),
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 25 * 3600000).toISOString() }),
  ] });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(result.replied, 1);
});

test('判断が必要でanswerが欠落しても分類エラーにせずaskのみ', async t => {
  const f = fixture(t, { decision: { needs_reply: true, needs_kim_decision: true, confidence: 0.9 } });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(f.sent.length, 0);
  assert.equal(result.decisions[0].reason, 'kim の判断が必要');
  assert.deepEqual(f.inboxItems.map(i => i.kind), ['ask']);
});

test('本文＋画像添付は回答対象になる', async t => {
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const msg = message({ attachments: [{ name: 'image.png', mimeType: 'image/png' }] });
  const f = fixture(t, { messages: [msg, own] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1); assert.equal(f.sent.length, 1);
});

test('添付のみ（本文なし）は FYI としてスキップ', async t => {
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const msg = message({ text: '', attachments: [{ name: 'file.pdf', mimeType: 'application/pdf' }] });
  const f = fixture(t, { messages: [msg, own] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems.length, 0);
});

test('dry-run は送信・kim-inbox・台帳・ロック作成なし', async t => {
  const f = fixture(t); f.options.dryRun = true;
  const result = await runOnce(f.options);
  assert.equal(result.wouldSend.length, 1);
  assert.match(result.wouldSend[0].content, /^【kimのClaudeによる代理回答】/);
  assert.equal(f.sent.length, 0); assert.equal(f.inboxItems.length, 0);
});

test('リンクは明示 native IDs → 会話名、内部数値IDを使わない', () => {
  assert.equal(messageLink(chat({ id: '828' }), message({ id: '7405' })), '会話名: 相談');
  assert.equal(messageLink(chat({ discordChannelID: '123456789012345678' }), message({ discordMessageID: '234567890123456789' })), 'https://discord.com/channels/@me/123456789012345678/234567890123456789');
});

test('会話に無い金額を含む回答は送信せず判断待ち', async t => {
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const f = fixture(t, {
    messages: [own, message()],
    decision: { ...reply, answer: '30,000円で対応可能です' }
  });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].reason, '会話に無い金額を含むため kim の判断が必要');
  assert.equal(f.sent.length, 0);
});
test('質問文にある金額を回答で引用しても送信される', async t => {
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const msg = message({ text: '330,000円の見積もりをお願いします' });
  const f = fixture(t, {
    messages: [own, msg],
    decision: { ...reply, answer: '330,000円で承りました。' }
  });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /330,000円/);
});
