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
  // Keep extraction separate from reply/retry mocks and never contact a live Beeper.
  options.beeperFetch = async () => ({ items: [] });
  let replyLlm = options.llm;
  Object.defineProperty(options, 'llm', {
    get: () => async args => args.system?.startsWith('Extract proper nouns')
      ? JSON.stringify(['スマートエイト']) : replyLlm(args),
    set: value => { replyLlm = value; },
  });
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

test('古いリクエストのpreviewもaskに積まない（7日超）', async t => {
  const f = fixture(t, { chats: [chat({ isRequest: true, preview: message({ timestamp: new Date(NOW - 8 * 86400000 - 1).toISOString() }) })] });
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

test('添付のみの初対面は判断待ち', async t => {
  const f = fixture(t, { messages: [message({ text: '', attachments: [{ mimeType: 'image/png' }] })] });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(result.decisions.length, 1);
  assert.equal(f.state().chats.chat1.status, 'decision');
  assert.equal(f.sent.length, 0); assert.equal(f.inboxItems.length, 1);
});

test('別メッセージの本文と添付名・mimeTypeをまとめてLLMへ渡す', async t => {
  const f = fixture(t);
  f.data.chat1.push(message({ id: 'image', sortKey: '3', text: '', attachments: [{ fileName: 'photo.png', mimeType: 'image/png', srcURL: 'mxc://test/photo' }, { fileName: 'notes.txt', mimeType: 'text/plain', srcURL: 'mxc://test/text' }] }));
  f.api.downloadAttachment = async a => Buffer.from(a.mimeType.startsWith('text/') ? '本文テスト' : 'image');
  f.options.llm = async ({ input }) => {
    assert.equal(input.images.length, 1);
    assert.equal(input.documents[0].text, '本文テスト');
    assert.match(input.message.content, /マニュアルはどこですか/);
    assert.match(input.message.content, /（画像\/ファイル添付あり: photo.png, notes.txt）/);
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

test('7日より古いメッセージは送信せず skipped（state に skipped を保存しない）', async t => {
  const oldMsg = message({ id: 'old1', timestamp: new Date(NOW - 8 * 86400000 - 1).toISOString() });
  const f = fixture(t, { messages: [oldMsg] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems.length, 0);
  assert.equal(result.skipped, 1);
  // state に skipped が保存されていないことを確認
  const st = f.state();
  assert.equal(st.chats?.chat1?.status !== 'skipped', true);
});

test('3日前のDM未返信 → 送信対象（maxAgeMs=7dで上書き）', async t => {
  // own（isSender）より後にユーザーメッセージが来るタイムスタンプ順にする
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 3 * 86400000 - 60000).toISOString() }),
    message({ timestamp: new Date(NOW - 3 * 86400000).toISOString() }),
  ] });
  const result = await runOnce({ ...f.options, maxAgeMs: 7 * 86400000 });
  assert.equal(result.replied, 1); assert.equal(f.sent.length, 1);
});
test('8日前のDM未返信 → 送信せず、stateにskippedを保存しない', async t => {
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 8 * 86400000 - 120000).toISOString() }),
    message({ timestamp: new Date(NOW - 8 * 86400000 - 1).toISOString() }),
  ] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0); assert.equal(f.sent.length, 0);
  assert.equal(result.skipped, 1);
  const st = f.state();
  // state.chats に chat1 が存在する場合でも status は skipped ではない
  assert.equal(st.chats?.chat1?.status !== 'skipped', true);
});
test('既定24h: 30時間前のDM未返信 → skipped（stateにskippedを保存しない）', async t => {
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 30 * 3600000 - 60000).toISOString() }),
    message({ timestamp: new Date(NOW - 30 * 3600000).toISOString() }),
  ] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0); assert.equal(f.sent.length, 0);
  assert.equal(result.skipped, 1);
  const st = f.state();
  assert.equal(st.chats?.chat1?.status !== 'skipped', true);
});
test('maxAgeMs=48h: 30時間前のDM → 送信対象、50時間前のDM → 送信せず', async t => {
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 31 * 3600000).toISOString() }),
    message({ timestamp: new Date(NOW - 30 * 3600000).toISOString() }),
  ] });
  const result = await runOnce({ ...f.options, maxAgeMs: 48 * 3600000 });
  assert.equal(result.replied, 1); assert.equal(f.sent.length, 1);
  const f2 = fixture(t, { messages: [
    message({ id: 'own2', isSender: true, timestamp: new Date(NOW - 51 * 3600000).toISOString() }),
    message({ timestamp: new Date(NOW - 50 * 3600000).toISOString() }),
  ] });
  const result2 = await runOnce({ ...f2.options, maxAgeMs: 48 * 3600000 });
  assert.equal(result2.replied, 0); assert.equal(f2.sent.length, 0);
  assert.equal(result2.skipped, 1);
  const st = f2.state();
  assert.equal(st.chats?.chat2?.status !== 'skipped', true);
});
test('stateにskippedがある会話 → 再評価され送信対象', async t => {
  // prior.status='skipped' の状態で、同じメッセージが再度評価される
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 7200000).toISOString() }),
    message({ timestamp: new Date(NOW - 3600000).toISOString() }),
  ] });
  // skip状態をstateに保存（旧コード由来、再評価されるべき）
  f.save({ version: 1, chats: { chat1: { id: 'm1', timestamp: new Date(NOW - 3600000).toISOString(), sortKey: '2', status: 'skipped' } }, hourly: [], hourlyByChat: {} });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1); assert.equal(f.sent.length, 1);
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
  const msg = message({ attachments: [{ name: 'image.png', mimeType: 'image/png', srcURL: 'mxc://test/image' }] });
  const f = fixture(t, { messages: [msg, own] });
  f.api.downloadAttachment = async () => Buffer.from('image');
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1); assert.equal(f.sent.length, 1);
});

test('添付のみ（本文なし）でURLなしは判断待ち', async t => {
  const own = message({ id: 'own', timestamp: new Date(NOW - 5000).toISOString(), sortKey: '1', isSender: true });
  const msg = message({ text: '', attachments: [{ name: 'file.pdf', mimeType: 'application/pdf' }] });
  const f = fixture(t, { messages: [msg, own] });
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems.length, 1);
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

import { downloadAttachment } from './beeper-api.mjs';
test('Beeper mxc添付はassets/download→assets/serveを認証付きで取得', async () => {
  const calls = [];
  const bytes = await downloadAttachment({ srcURL: 'mxc://example/image' }, {
    token: 'test-token', fetchImpl: async (url, init) => {
      calls.push(String(url));
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      if (String(url).endsWith('/assets/download')) {
        assert.deepEqual(JSON.parse(init.body), { url: 'mxc://example/image' });
        return new Response(JSON.stringify({ srcURL: 'file:///image.png' }));
      }
      assert.equal(new URL(url).searchParams.get('url'), 'file:///image.png');
      return new Response(Buffer.from('image-bytes'));
    },
  });
  assert.equal(bytes.toString(), 'image-bytes');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith('http://localhost:23373/v1/assets/')));
});

test('Beeper画像とGoogle本文をLLMへ渡すdry-runは送信も保存もしない', async t => {
  const f = fixture(t);
  f.data.chat1[0].text += ' https://docs.google.com/document/d/example/edit';
  f.data.chat1[0].attachments = [{ name: 'photo.png', mimeType: 'image/png', srcURL: 'mxc://example/photo' }];
  f.api.downloadAttachment = async () => Buffer.from('IMAGE_BYTES');
  f.options.readGoogleUrl = async () => 'GOOGLE_DOCUMENT_TEXT';
  let called = false;
  f.options.llm = async ({ input, system }) => {
    called = true;
    assert.equal(input.images[0].dataUrl, 'data:image/png;base64,SU1BR0VfQllURVM=');
    assert.equal(input.documents[0].text, 'GOOGLE_DOCUMENT_TEXT');
    assert.match(system, /閲覧できない/);
    return JSON.stringify(reply);
  };
  const result = await runOnce({ ...f.options, dryRun: true });
  assert.equal(called, true);
  assert.equal(result.wouldSend.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(f.file), false);
});

test('Beeper添付失敗は名前と理由付きでkim-inboxへ送りLLM・送信を止める', async t => {
  const f = fixture(t);
  f.data.chat1[0].attachments = [{ name: 'broken.png', mimeType: 'image/png', srcURL: 'mxc://example/broken' }];
  f.api.downloadAttachment = async () => { throw new Error('HTTP 404'); };
  f.options.llm = async () => assert.fail('must not generate a reply');
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems[0].kind, 'ask');
  assert.match(f.inboxItems[0].text, /broken.png: HTTP 404/);
});

test('Beeperで閲覧できない仕様という回答はkim-inboxだけに回す', async t => {
  const f = fixture(t, { decision: { ...reply, answer: '閲覧できない仕様です' } });
  await runOnce(f.options);
  assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems[0].kind, 'ask');
});

test('beeper: 文脈メッセージに未対応添付(.xlsx)があっても、対象メッセージがテキストだけなら返信が送られる', async t => {
  const f = fixture(t);
  // Context message before own (self) message, so it's in history but not in pending.
  f.data.chat1.push(message({ id: 'context-xlsx', sortKey: '0.5', timestamp: new Date(NOW - 10000).toISOString(), text: '会議資料です', attachments: [{ fileName: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', srcURL: 'mxc://test/xlsx' }] }));
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.inboxItems.length, 1); // info (sent report) only, no ask
});

test('beeper: 対象メッセージの添付取得失敗は従来どおり kim-inbox', async t => {
  const f = fixture(t);
  f.data.chat1[0].attachments = [{ name: 'target-broken.png', mimeType: 'image/png', srcURL: 'mxc://example/target-broken' }];
  f.api.downloadAttachment = async () => { throw new Error('HTTP 404'); };
  f.options.llm = async () => assert.fail('must not generate a reply');
  const result = await runOnce(f.options);
  assert.equal(result.replied, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems[0].kind, 'ask');
  assert.match(f.inboxItems[0].text, /target-broken.png: HTTP 404/);
});

// ─── acquire 堅牢化 ────────────────────────────────────────────────

test('死んだ pid のロックを奪って実行される', async t => {
  const f = fixture(t);
  const lockDir = path.join(f.home, '.claude/discord-beeper-autoreply');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lock'), JSON.stringify({ pid: 99999999, host: os.hostname(), ts: Date.now() }));
  const result = await runOnce(f.options);
  assert.equal(result.locked, undefined);
  assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1);
});

test('生存 pid（自プロセス）かつ新しいロックは locked', async t => {
  const f = fixture(t);
  const lockDir = path.join(f.home, '.claude/discord-beeper-autoreply');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), ts: Date.now() }));
  const result = await runOnce(f.options);
  assert.equal(result.locked, true);
  assert.equal(result.holder.pid, process.pid);
  assert.equal(result.holder.host, os.hostname());
  assert.equal(f.sent.length, 0);
});

test('15分超で異なるホストのロックも奪う', async t => {
  const f = fixture(t);
  const lockDir = path.join(f.home, '.claude/discord-beeper-autoreply');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 12345, host: 'OTHER-PC', ts: Date.now() - 20 * 60000 }));
  const old = new Date(Date.now() - 20 * 60000);
  fs.utimesSync(lockFile, old, old);
  const result = await runOnce(f.options);
  assert.equal(result.locked, undefined);
  assert.equal(result.replied, 1);
});

test('壊れた JSON で 15分超は奪う', async t => {
  const f = fixture(t);
  const lockDir = path.join(f.home, '.claude/discord-beeper-autoreply');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'lock');
  fs.writeFileSync(lockFile, 'garbage-bytes');
  const old = new Date(Date.now() - 20 * 60000);
  fs.utimesSync(lockFile, old, old);
  const result = await runOnce(f.options);
  assert.equal(result.locked, undefined);
  assert.equal(result.replied, 1);
});

test('locked も log.jsonl に残る（holder 情報付き）', async t => {
  const f = fixture(t);
  const lockDir = path.join(f.home, '.claude/discord-beeper-autoreply');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lock'), JSON.stringify({ pid: 88888, host: 'OTHER-PC', ts: Date.now() }));
  const result = await runOnce(f.options);
  assert.equal(result.locked, true);
  const logFile = path.join(lockDir, 'log.jsonl');
  assert.equal(fs.existsSync(logFile), true);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.locked, true);
  assert.equal(last.holder.host, 'OTHER-PC');
  assert.equal(last.holder.pid, 88888);
  assert.ok(typeof last.holder.ageSec === 'number');
});

test('壊れた JSON で 15分以内なら locked', async t => {
  const f = fixture(t);
  const lockDir = path.join(f.home, '.claude/discord-beeper-autoreply');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lock'), 'corrupt-data');
  // mtime は直近（utimes しないので作成直後）→ stale にならず locked
  const result = await runOnce(f.options);
  assert.equal(result.locked, true);
  assert.equal(result.holder.pid, 'unknown');
  assert.equal(result.holder.host, 'unknown');
  assert.equal(f.sent.length, 0);
});

test('連続 locked が30分を超えると通知完了を待ち、1件だけ通知する', async t => {
  const f = fixture(t);
  const dir = path.dirname(f.file), lock = path.join(dir, 'lock');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  let now = NOW;
  f.options.now = () => now;
  const items = [];
  f.options.addItemImpl = async (_home, item) => {
    await Promise.resolve();
    items.push(item);
  };
  await runOnce(f.options);
  now += 30 * 60000;
  await runOnce(f.options);
  assert.equal(items.length, 0);
  now++;
  await runOnce(f.options);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'info');
  assert.match(items[0].dedupeKey, /^beeper-autoreply-stuck-lock:/);
  now += 5 * 60000;
  await runOnce(f.options);
  assert.equal(items.length, 1);
  // A successful acquisition interrupts the streak, including when paused.
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(dir, 'PAUSE'), 'test');
  await runOnce(f.options);
  assert.equal(fs.existsSync(path.join(dir, 'locked-stuck.json')), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  await runOnce(f.options);
  now += 30 * 60000 + 1;
  await runOnce(f.options);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].dedupeKey, items[1].dedupeKey);
});

test('通知失敗時は notified にせず次回再試行する', async t => {
  const f = fixture(t), dir = path.dirname(f.file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
  await runOnce(f.options);
  f.options.now = () => NOW + 31 * 60000;
  f.options.addItemImpl = async () => { throw new Error('inbox unavailable'); };
  await runOnce(f.options);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'locked-stuck.json'))).notified, false);
  f.options.addItemImpl = async (_home, item) => { f.inboxItems.push(item); };
  await runOnce(f.options);
  assert.equal(f.inboxItems.length, 1);
});

test('実行中のロックに所有者とtsを記録し30秒ごとにmtimeを更新する', async t => {
  const f = fixture(t), lock = path.join(path.dirname(f.file), 'lock');
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.api.getAccounts = async () => {
    const owner = JSON.parse(fs.readFileSync(lock));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.host, os.hostname());
    assert.equal(typeof owner.ts, 'number');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    t.mock.timers.tick(29999);
    assert.ok(fs.statSync(lock).mtimeMs <= old.getTime() + 1);
    t.mock.timers.tick(1);
    assert.ok(fs.statSync(lock).mtimeMs > old.getTime() + 50000);
    return [account];
  };
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(lock), false);
});

// Related conversation integration: use the same fixture through the real reply pipeline.
for (const amount of ['40,000円', '4万円']) {
  test(`辻さん: related を LLM 入力に含め、${amount} を捏造扱いしない`, async t => {
    const f = fixture(t);
    f.options.beeperFetch = async (endpoint, { query }) => {
      assert.equal(endpoint, '/v1/messages/search');
      assert.equal(query.query, 'スマートエイト');
      return {
        items: [{ id: 'related-1', chatID: 'group1', senderName: '川本',
          timestamp: new Date(Date.now() - 86400000).toISOString(),
          text: '<p>制作費２万円+5千円+1.5万円の合計４万円(税抜)で3プランという認識でよろしいでしょうか</p>' }],
        chats: { group1: { title: '川本, 大平, 白川 & 百瀬' } },
      };
    };
    f.options.llm = async ({ input, system }) => {
      assert.equal(input.related.length, 1);
      assert.equal(input.related[0].sender, '川本');
      assert.equal(input.related[0].chat, '川本, 大平, 白川 & 百瀬');
      assert.match(input.related[0].text, /合計４万円/);
      assert.match(system, /全体最適/);
      return JSON.stringify({ needs_reply: true, needs_kim_decision: false,
        answer: `${amount}で合っているので原価に計上してください。根拠: 川本, 大平, 白川 & 百瀬で川本さんが合計４万円と発言。`, confidence: 0.95 });
    };
    // The question itself contains no amount: only related can justify the reply.
    f.data.chat1[0].text = 'スマートエイト様 DXPO福岡、studioreal様の請求書を原価に追加してよいか';
    const result = await runOnce(f.options);
    assert.equal(result.replied, 1);
    assert.match(f.sent[0].content, /原価に計上/);
  });
}

test('関連検索失敗でも返信処理が続く', async t => {
  const f = fixture(t);
  let searched = false;
  f.options.beeperFetch = async () => { searched = true; throw new Error('Beeper down'); };
  const result = await runOnce(f.options);
  assert.equal(searched, true);
  assert.equal(result.replied, 1);
});

test('実行中に別の所有者へ置換されたロックを解放時に削除しない', async t => {
  const f = fixture(t), lock = path.join(path.dirname(f.file), 'lock');
  const replacement = JSON.stringify({ pid: process.pid, host: os.hostname(), ts: 1 });
  f.api.getAccounts = async () => {
    fs.writeFileSync(lock, replacement);
    return [account];
  };
  assert.equal((await runOnce(f.options)).ok, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
});

// ── (B) Delete + correct learning ─────────────────────────────────────

function deletionFixture(t, { deleted = true, kimCorrected = true, alreadyLearned = false, correctionsFileExists = false } = {}) {
  const f = fixture(t);
  const NOW = f.options.now();
  const chatId = 'chat1';
  const replyId = 'auto-reply-1';
  const question = '原価確認をお願いします';
  const autoAnswer = '【kimのClaudeによる代理回答】\n確認しました。原価は40,000円です。\n\n※kim本人の返答ではなく自動返信です。';
  const kimAnswer = '原価は35,000円です。訂正します。';

  // Set up state with a sent auto-reply
  const state = {
    version: 1,
    chats: {
      [chatId]: {
        id: 'user-msg-1',
        timestamp: new Date(NOW - 3600000).toISOString(),
        sortKey: '2',
        status: 'sent',
        replyId,
        content: autoAnswer,
        question,
        senderName: '辻',
        link: '会話名: テスト',
        ...(alreadyLearned ? { learnedDeletion: true } : {}),
      },
    },
    hourly: [],
    hourlyByChat: {},
  };
  f.save(state);

  // Set up chat history
  const messages = [
    { id: 'user-msg-1', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 3600000).toISOString(), sortKey: '2', text: question, senderName: '辻', isSender: false },
  ];

  if (!deleted) {
    // Auto-reply still exists
    messages.push({ id: replyId, accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 3500000).toISOString(), sortKey: '3', text: autoAnswer, senderName: 'kim', isSender: true });
  }

  if (kimCorrected) {
    // kim's correction after deletion
    messages.push({ id: 'kim-correct-1', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 3000000).toISOString(), sortKey: '4', text: kimAnswer, senderName: 'kim', isSender: true });
  }

  // Override listMessages to return our fixture data
  f.api.listMessages = async (id) => {
    if (id === chatId) return { items: messages, hasMore: false };
    return { items: [] };
  };

  // Set up corrections file
  if (correctionsFileExists) {
    const corrDir = path.join(f.home, '.claude', 'discord-autoreply');
    fs.mkdirSync(corrDir, { recursive: true });
    fs.writeFileSync(path.join(corrDir, 'corrections.jsonl'), JSON.stringify({ msgId: 'existing', outcome: 'confirmed' }) + '\n');
  }

  return { ...f, chatId, replyId, question, autoAnswer, kimAnswer };
}

test('削除＋訂正→1件学習', async t => {
  const f = deletionFixture(t, { deleted: true, kimCorrected: true });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.learned?.deletedAndCorrected, 1, 'should learn 1 deletion correction');

  // Check corrections.jsonl was written
  const corrFile = path.join(f.home, '.claude', 'discord-autoreply', 'corrections.jsonl');
  assert.ok(fs.existsSync(corrFile), 'corrections.jsonl should exist');
  const lines = fs.readFileSync(corrFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.msgId, f.replyId);
  assert.equal(entry.question, f.question);
  assert.equal(entry.autoAnswer, f.autoAnswer);
  assert.equal(entry.kimAnswer, '原価は35,000円です。訂正します。');
  assert.equal(entry.outcome, 'deleted_and_corrected');
  assert.equal(entry.confirmed, true);
  assert.equal(entry.where, 'dm');

  // Check state was updated
  const state = f.state();
  assert.equal(state.chats[f.chatId].learnedDeletion, true);

  // Check kim-inbox was notified
  assert.ok(f.inboxItems.some(item =>
    item.kind === 'info' && item.text.includes('自動返信の訂正を学習')
  ));
});

test('削除なし→学習なし', async t => {
  const f = deletionFixture(t, { deleted: false, kimCorrected: true });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.learned?.deletedAndCorrected, undefined, 'should not learn when not deleted');

  // Check corrections.jsonl was NOT written
  const corrFile = path.join(f.home, '.claude', 'discord-autoreply', 'corrections.jsonl');
  assert.equal(fs.existsSync(corrFile), false, 'corrections.jsonl should not exist');
});

test('削除＋訂正なし→学習なし（訂正を待つ）', async t => {
  const f = deletionFixture(t, { deleted: true, kimCorrected: false });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  // No correction found yet — should not learn
  assert.equal(result.learned?.deletedAndCorrected, undefined);
  // State should NOT have learnedDeletion (keep checking on next run)
  const state = f.state();
  assert.equal(state.chats[f.chatId].learnedDeletion, undefined, 'should keep checking for correction');
});

test('重複なし: 既存のcorrections.jsonlに同じmsgIdがあれば追記しない', async t => {
  const f = deletionFixture(t, { deleted: true, kimCorrected: true, correctionsFileExists: true });
  // Pre-populate with the same msgId
  const corrDir = path.join(f.home, '.claude', 'discord-autoreply');
  const existingEntry = { msgId: f.replyId, outcome: 'deleted_and_corrected', confirmed: true };
  fs.writeFileSync(path.join(corrDir, 'corrections.jsonl'), JSON.stringify(existingEntry) + '\n');

  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  // Should not add duplicate
  const lines = fs.readFileSync(path.join(corrDir, 'corrections.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'should not add duplicate entry');
});

test('既に学習済み(learnedDeletion)は再処理しない', async t => {
  const f = deletionFixture(t, { deleted: true, kimCorrected: true, alreadyLearned: true });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  // Should not learn again
  assert.equal(result.learned?.deletedAndCorrected, undefined);
  // corrections.jsonl should not exist
  const corrFile = path.join(f.home, '.claude', 'discord-autoreply', 'corrections.jsonl');
  assert.equal(fs.existsSync(corrFile), false);
});

test('7日より古い自動返信は学習対象外', async t => {
  const f = fixture(t);
  const NOW = f.options.now();
  const chatId = 'chat1';
  const replyId = 'old-reply';
  // 8 days old
  const oldTs = new Date(NOW - 8 * 86400000 - 1).toISOString();

  const state = {
    version: 1,
    chats: {
      [chatId]: {
        id: 'old-msg',
        timestamp: oldTs,
        sortKey: '1',
        status: 'sent',
        replyId,
        content: '古い自動返信',
        question: '古い質問',
        senderName: 'User',
      },
    },
    hourly: [],
    hourlyByChat: {},
  };
  f.save(state);

  f.api.listMessages = async (id) => {
    if (id === chatId) return { items: [
      { id: 'old-msg', accountID: DISCORD_ACCOUNT, timestamp: oldTs, sortKey: '1', text: '古い質問', senderName: 'User', isSender: false },
    ], hasMore: false };
    return { items: [] };
  };

  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  // Should mark as learnedDeletion without writing corrections
  const st = f.state();
  assert.equal(st.chats[chatId].learnedDeletion, true);
  const corrFile = path.join(f.home, '.claude', 'discord-autoreply', 'corrections.jsonl');
  assert.equal(fs.existsSync(corrFile), false);
});

test('corrections が DM 入力に入る', async t => {
  const f = fixture(t);
  // Pre-populate corrections.jsonl
  const corrDir = path.join(f.home, '.claude', 'discord-autoreply');
  fs.mkdirSync(corrDir, { recursive: true });
  fs.writeFileSync(path.join(corrDir, 'corrections.jsonl'),
    JSON.stringify({ msgId: 'c1', outcome: 'deleted_and_corrected', confirmed: true, question: 'テスト質問', autoAnswer: '自動返信', kimAnswer: '正解' }) + '\n');

  let llmInput = null;
  f.options.llm = async (args) => {
    if (args.system?.startsWith('Extract proper nouns')) return JSON.stringify(['スマートエイト']);
    llmInput = args.input;
    return JSON.stringify({ needs_reply: true, needs_kim_decision: false, answer: '確認しました。', confidence: 0.9 });
  };

  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.ok(llmInput, 'LLM should have been called');
  assert.ok(Array.isArray(llmInput.corrections), 'corrections should be in LLM input');
  assert.equal(llmInput.corrections.length, 1);
  assert.equal(llmInput.corrections[0].msgId, 'c1');
  assert.equal(llmInput.corrections[0].outcome, 'deleted_and_corrected');
});

// ── Deletion coverage tests ──────────────────────────────────────────

test('削除検出: 範囲外（履歴が自動返信の時刻をカバーしない）→ 学習しない', async t => {
  const f = fixture(t);
  const NOW = f.options.now();
  const chatId = 'chat1';
  const replyId = 'old-reply';
  // Auto-reply is 2 hours ago, but the fetched messages are only from 30 min ago
  const autoReplyTs = new Date(NOW - 7200000).toISOString();
  const state = {
    version: 1,
    chats: {
      [chatId]: {
        id: 'user-msg',
        timestamp: autoReplyTs,
        sortKey: '1',
        status: 'sent',
        replyId,
        content: '古い自動返信',
        question: '古い質問',
        senderName: 'User',
      },
    },
    hourly: [],
    hourlyByChat: {},
  };
  f.save(state);

  // Only return messages from the last 30 minutes — does NOT cover auto-reply timestamp
  f.api.listMessages = async (id) => {
    if (id === chatId) {
      return {
        items: [
          { id: 'recent-1', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 600000).toISOString(), sortKey: '3', text: '最近のメッセージ', senderName: 'User', isSender: false },
          { id: 'recent-2', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 1200000).toISOString(), sortKey: '2', text: '少し前のメッセージ', senderName: 'kim', isSender: true },
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };

  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  // Should NOT learn because history doesn't cover the auto-reply timestamp
  assert.equal(result.learned?.deletedAndCorrected, undefined);
  const st = f.state();
  // learnedDeletion should NOT be set (still uncertain)
  assert.equal(st.chats[chatId].learnedDeletion, undefined, 'should remain uncertain when history does not cover');
});

test('削除検出: 範囲内で消えている → 学習する', async t => {
  const f = fixture(t);
  const NOW = f.options.now();
  const chatId = 'chat1';
  const replyId = 'deleted-reply';
  const autoReplyTs = new Date(NOW - 3600000).toISOString();
  const state = {
    version: 1,
    chats: {
      [chatId]: {
        id: 'user-msg',
        timestamp: autoReplyTs,
        sortKey: '2',
        status: 'sent',
        replyId,
        content: '自動返信',
        question: '確認お願いします',
        senderName: '辻',
      },
    },
    hourly: [],
    hourlyByChat: {},
  };
  f.save(state);

  // Messages: oldest (user-msg) is older than auto-reply → covers timestamp
  // Auto-reply is NOT in the list → truly deleted
  f.api.listMessages = async (id) => {
    if (id === chatId) {
      return {
        items: [
          { id: 'user-msg', accountID: DISCORD_ACCOUNT, timestamp: autoReplyTs, sortKey: '2', text: '確認お願いします', senderName: '辻', isSender: false },
          { id: 'kim-correct', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 3000000).toISOString(), sortKey: '3', text: '確認しました。原価は35,000円です。', senderName: 'kim', isSender: true },
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };

  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.learned?.deletedAndCorrected, 1, 'should learn when history covers and message is missing');

  const corrFile = path.join(f.home, '.claude', 'discord-autoreply', 'corrections.jsonl');
  assert.ok(fs.existsSync(corrFile));
  const entry = JSON.parse(fs.readFileSync(corrFile, 'utf8').trim());
  assert.equal(entry.msgId, replyId);
  assert.equal(entry.outcome, 'deleted_and_corrected');
});

test('削除検出: isDeleted フラグ → 学習する', async t => {
  const f = fixture(t);
  const NOW = f.options.now();
  const chatId = 'chat1';
  const replyId = 'flagged-deleted';
  const autoReplyTs = new Date(NOW - 3600000).toISOString();
  const state = {
    version: 1,
    chats: {
      [chatId]: {
        id: 'user-msg',
        timestamp: autoReplyTs,
        sortKey: '2',
        status: 'sent',
        replyId,
        content: '自動返信',
        question: '確認お願いします',
        senderName: '辻',
      },
    },
    hourly: [],
    hourlyByChat: {},
  };
  f.save(state);

  // Auto-reply is present but has isDeleted=true
  f.api.listMessages = async (id) => {
    if (id === chatId) {
      return {
        items: [
          { id: 'user-msg', accountID: DISCORD_ACCOUNT, timestamp: autoReplyTs, sortKey: '2', text: '確認お願いします', senderName: '辻', isSender: false },
          { id: replyId, accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 3500000).toISOString(), sortKey: '3', text: '【kimのClaudeによる代理回答】\n確認しました。', senderName: 'kim', isSender: true, isDeleted: true },
          { id: 'kim-correct', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 3000000).toISOString(), sortKey: '4', text: '確認しました。原価は35,000円です。', senderName: 'kim', isSender: true },
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };

  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.learned?.deletedAndCorrected, 1, 'should learn when isDeleted flag is set');

  const corrFile = path.join(f.home, '.claude', 'discord-autoreply', 'corrections.jsonl');
  assert.ok(fs.existsSync(corrFile));
  const entry = JSON.parse(fs.readFileSync(corrFile, 'utf8').trim());
  assert.equal(entry.msgId, replyId);
  assert.equal(entry.outcome, 'deleted_and_corrected');
});
