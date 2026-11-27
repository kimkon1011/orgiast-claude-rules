import { withTema } from './test-fixtures/tema-record.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce, main, DISCORD_ACCOUNT, messageLink, isMessageRequest, isSyntheticMessage, SEND_PROMISE_PTN } from './discord-beeper-autoreply.mjs';
import { trialFailAnswer } from './lib/trial-self-decline.mjs';
import { main as guildMain } from './discord-autoreply.mjs';

const NOW = Date.parse('2026-11-12T04:00:00Z'); // 13:00 JST (allowed window)
const reply = { needs_reply: true, needs_kim_decision: false, answer: 'マニュアルの一覧から確認できます。', confidence: 0.95 };
const account = { accountID: DISCORD_ACCOUNT, network: 'Discord', user: { isSelf: true, id: 'kim' } };
const message = (overrides = {}) => ({ id: 'm1', type: 'TEXT', accountID: DISCORD_ACCOUNT, timestamp: new Date(NOW - 1000).toISOString(), sortKey: '2', text: 'マニュアルはどこですか？', senderName: '田中', isSender: false, ...overrides });
const chat = (overrides = {}) => ({ id: 'chat1', localChatID: '828', accountID: DISCORD_ACCOUNT, title: '相談', type: 'single', ...overrides });

test('送信約束の表現を台帳対象として検出する', () => { assert.equal(SEND_PROMISE_PTN.test('本日中に資料をお送りします'), true); assert.equal(SEND_PROMISE_PTN.test('確認しました'), false); });

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
      ? JSON.stringify(['スマートエイト']) : (async () => {
        const raw = await replyLlm(args);
        try { const data = JSON.parse(raw); if (args.category === 'jp_reply' && data.answer?.trim()) data.answer = withTema(data.answer); return JSON.stringify(data); } catch { return raw; }
      })(),
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

// ── 合成メッセージ（通話通知）対応 ──────────────────────────────────

test('最新が通話通知→1つ前の本物の質問に返信', async t => {
  const callMsg = message({
    id: 'call',
    sortKey: '3',
    timestamp: new Date(NOW - 500).toISOString(),
    text: 'kanbara1110 started a call. Use the Discord app to answer.',
  });
  const f = fixture(t, { messages: [message(), callMsg] });
  f.data.chat1.push(message({ id: 'own', sortKey: '1', timestamp: new Date(NOW - 5000).toISOString(), isSender: true }));
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1);
  // 返信先は通話通知(id=call)ではなく本物の質問(id=m1)
  assert.equal(f.sent[0].options.replyToMessageID, 'm1');
  const logged = fs.readFileSync(path.join(f.home, '.claude/discord-autoreply/sent-log.jsonl'), 'utf8');
  assert.doesNotMatch(JSON.parse(logged.trim()).question, /started a call/);
});

test('通話通知のみ（本物のメッセージなし）→送信しない', async t => {
  const callMsg = message({
    id: 'call',
    sortKey: '2',
    timestamp: new Date(NOW - 500).toISOString(),
    text: '(kanbara1110 started a call. Use the Discord app to answer.)',
  });
  const f = fixture(t, { messages: [callMsg] });
  f.data.chat1.push(message({ id: 'own', sortKey: '1', timestamp: new Date(NOW - 5000).toISOString(), isSender: true }));
  const result = await runOnce(f.options);
  // pending が空になる（通話通知のみ）→ skipped
  assert.equal(result.replied, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(result.skipped, 1);
});

test('不在着信も合成メッセージとして扱う', async t => {
  const missedCall = message({
    id: 'missed',
    sortKey: '3',
    timestamp: new Date(NOW - 500).toISOString(),
    text: '不在着信: kanbara1110',
  });
  const f = fixture(t, { messages: [message(), missedCall] });
  f.data.chat1.push(message({ id: 'own', sortKey: '1', timestamp: new Date(NOW - 5000).toISOString(), isSender: true }));
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1);
  assert.equal(f.sent.length, 1);
  // 返信先は本物の質問
  assert.equal(f.sent[0].options.replyToMessageID, 'm1');
});

test('通話通知の後に本物の質問が来たらそちらに返信', async t => {
  // own → 通話通知 → 質問(新しい)
  const callMsg = message({
    id: 'call',
    sortKey: '2',
    timestamp: new Date(NOW - 1000).toISOString(),
    text: 'started a call. Use the Discord app to answer.',
  });
  const newQuestion = message({
    id: 'new-q',
    sortKey: '3',
    timestamp: new Date(NOW - 500).toISOString(),
    text: 'さっきの件どうなりましたか？',
  });
  const f = fixture(t, { messages: [callMsg, newQuestion] });
  f.data.chat1.push(message({ id: 'own', sortKey: '1', timestamp: new Date(NOW - 5000).toISOString(), isSender: true }));
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1);
  // 最新の本物の質問に返信
  assert.equal(f.sent[0].options.replyToMessageID, 'new-q');
  // 質問本文に通話通知が含まれない
  const sentContent = f.sent[0].content;
  assert.doesNotMatch(sentContent, /started a call/);
  const logged = fs.readFileSync(path.join(f.home, '.claude/discord-autoreply/sent-log.jsonl'), 'utf8');
  assert.match(JSON.parse(logged.trim()).question, /どうなりましたか/);
  assert.doesNotMatch(JSON.parse(logged.trim()).question, /started a call/);
});

for (const safeRetry of [false, true]) test(`11/17 社外招待指示: 再生成1回・safe=${safeRetry}`, async t => {
  const items = [];
  const f = fixture(t);
  f.options.addItemImpl = async (_home, item) => { items.push(item); return { id: 'ask' }; };
  let calls = 0;
  f.options.llm = async ({ input, system }) => {
    calls++;
    assert.match(system, /お客様（社外の人）を社内カレンダーの予定に招待するよう社員に指示しない/);
    if (calls === 2) assert.equal(input.forbiddenRetry, true);
    return JSON.stringify({ ...reply, answer: calls === 2 && safeRetry
      ? 'お客様へメール本文に日時と会議URLを書いて案内してください。'
      : 'カレンダー招待への丸山様（必要であれば加藤様）の追加もお願いします' });
  };
  await runOnce(f.options);
  assert.equal(calls, 2);
  assert.equal(f.sent.length, safeRetry ? 1 : 0);
  if (!safeRetry) assert.deepEqual(items.map(i => i.kind), ['ask']);
});

test('合成判定は受信TEXTのみ、HTMLと英語不在着信にも対応', () => {
  for (const text of ['<p>STARTED A CALL</p>', 'Use the Discord app to answer', '不在着信', 'Missed call']) {
    assert.equal(isSyntheticMessage(message({ text })), true);
    assert.equal(isSyntheticMessage(message({ text, isSender: true })), false);
    assert.equal(isSyntheticMessage(message({ text, type: 'IMAGE' })), false);
  }
  assert.equal(isSyntheticMessage(null), false);
  assert.equal(isSyntheticMessage(message()), false);
});

test('TEXTの質問がない添付メッセージにはreplyToを付けない', async t => {
  const f = fixture(t);
  f.data.chat1[0].type = 'IMAGE';
  f.data.chat1[0].text = '';
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1);
  assert.deepEqual(f.sent[0].options, {});
});

test('本文が空のTEXTは返信先にしない', async t => {
  const f = fixture(t);
  f.data.chat1.unshift(message({ id: 'empty', text: '<p> </p>', timestamp: new Date(NOW - 500).toISOString() }));
  assert.equal((await runOnce(f.options)).replied, 1);
  assert.equal(f.sent[0].options.replyToMessageID, 'm1');
});

for (const failure of [{ sendError: 'bridge failed' }, { failed: true }, { status: 'failed' }, { sendStatus: 'error' }]) {
  test(`読み戻しの送信失敗を成功記録しない ${JSON.stringify(failure)}`, async t => {
    const f = fixture(t);
    const send = f.api.sendMessage;
    f.api.sendMessage = async (...args) => {
      const sent = await send(...args);
      Object.assign(f.data.chat1[0], failure);
      return sent;
    };
    assert.equal((await runOnce(f.options)).replied, 0);
    assert.equal(f.state().chats.chat1.status, 'uncertain');
    assert.equal(fs.existsSync(path.join(f.home, '.claude/discord-autoreply/sent-log.jsonl')), false);
    await runOnce(f.options);
    assert.equal(f.sent.length, 1);
  });
}


const learnNeutral = { is_correction: false, is_confirmation: false, rule: null, fact: null };
const learnCorrected = { ...learnNeutral, is_correction: true,
  rule: '最新の案件状況を確認する', fact: 'スマートエイトの担当は百瀬' };
const learningFile = (f, name) => path.join(f.home, '.claude', 'discord-autoreply', name);
const learnedRows = f => fs.readFileSync(learningFile(f, 'corrections.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));

function mockLearning(f, classify) {
  f.options.llm = async ({ category, system, input }) => {
    if (!system.startsWith('質問／自動返信／kimの発言')) return JSON.stringify(reply);
    assert.equal(category, 'classification');
    return JSON.stringify(classify(input));
  };
}
function addKimFollowup(f, text, id = 'kim-followup') {
  f.options.now = () => NOW + 2000;
  f.data.chat1.push(message({ id, isSender: true, text, timestamp: new Date(NOW + 1000).toISOString() }));
}

test('削除されていない代理回答への後続訂正を学習し、再巡回でも重複しない', async t => {
  const f = fixture(t);
  mockLearning(f, () => learnCorrected);
  assert.equal((await runOnce(f.options)).replied, 1);
  assert.equal(f.state().chats.chat1.learnedDeletion, true);
  const kimAnswer = 'スマートエイトは失注しました。担当は百瀬';
  addKimFollowup(f, kimAnswer);
  assert.equal((await runOnce(f.options)).learned.corrected, 1);
  await runOnce(f.options);
  assert.deepEqual(learnedRows(f), [{
    ts: new Date(NOW + 2000).toISOString(), where: 'dm', chatId: 'chat1', msgId: 'sentchat1',
    question: `田中: ${message().text}`, autoAnswer: f.sent[0].content, kimAnswer, rule: learnCorrected.rule, outcome: 'corrected'
  }]);
  assert.match(fs.readFileSync(learningFile(f, 'rules.md'), 'utf8'), /最新の案件状況を確認する/);
  assert.match(fs.readFileSync(learningFile(f, 'knowledge.md'), 'utf8'), /スマートエイトの担当は百瀬/);
  const notifications = f.inboxItems.filter(item => item.dedupeKey === 'dm-learn:sentchat1');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].text, '自動返信の訂正を学習: 田中');
});

test('無関係な発言は記録して再評価せず、後から来た確認を学習する', async t => {
  const f = fixture(t);
  const seen = [];
  mockLearning(f, ({ kimAnswer }) => {
    seen.push(kimAnswer);
    return { ...learnNeutral, is_confirmation: kimAnswer === 'そのURLで合っています' };
  });
  await runOnce(f.options);
  addKimFollowup(f, '明日は出張です');
  await runOnce(f.options);
  assert.deepEqual(f.state().learnQueue[0].evaluatedKimIds, ['kim-followup']);
  assert.equal(f.state().learnQueue[0].learned, false);
  assert.equal(fs.existsSync(learningFile(f, 'corrections.jsonl')), false);
  f.data.chat1.push(message({ id: 'confirmation', isSender: true, text: 'そのURLで合っています',
    timestamp: new Date(NOW + 1500).toISOString() }));
  await runOnce(f.options);
  assert.deepEqual(seen, ['明日は出張です', 'そのURLで合っています']);
  assert.equal(learnedRows(f)[0].outcome, 'confirmed');
  assert.equal(fs.existsSync(learningFile(f, 'rules.md')), false);
});

test('同じDMで2件目を送信しても1件目の学習を続ける', async t => {
  const f = fixture(t);
  mockLearning(f, ({ question }) => question === `田中: ${message().text}` ? learnCorrected : learnNeutral);
  await runOnce(f.options);
  const sendTime = NOW + 5000;
  f.options.now = () => sendTime;
  f.data.chat1.push(message({ id: 'second-question', text: '次の案件の担当は？',
    timestamp: new Date(sendTime - 1000).toISOString() }));
  f.api.sendMessage = async (id, content) => {
    f.data[id].push(message({ id: 'second-reply', text: content, isSender: true,
      timestamp: new Date(sendTime).toISOString() }));
    return { id: 'second-reply' };
  };
  assert.equal((await runOnce(f.options)).replied, 1);
  assert.equal(f.state().chats.chat1.replyId, 'second-reply');
  assert.deepEqual(f.state().learnQueue.map(entry => entry.replyId), ['sentchat1', 'second-reply']);
  f.options.now = () => sendTime + 2000;
  f.data.chat1.push(message({ id: 'first-correction', text: '最初の回答を訂正します', isSender: true,
    timestamp: new Date(sendTime + 1000).toISOString() }));
  await runOnce(f.options);
  assert.equal(learnedRows(f)[0].msgId, 'sentchat1');
  assert.deepEqual(f.state().learnQueue.map(entry => entry.learned), [true, false]);
});

test('72時間で未学習の返信をexpiredとして閉じる', async t => {
  const f = fixture(t);
  await runOnce(f.options);
  f.options.now = () => NOW + 72 * 3600000;
  assert.equal((await runOnce(f.options)).learned.expired, 1);
  assert.equal(learnedRows(f)[0].outcome, 'expired');
  assert.equal(f.state().learnQueue[0].learned, true);
  let status;
  assert.equal(await guildMain(['status'], { home: f.home, print: output => { status = output; } }), 0);
  assert.deepEqual(status.learnQueue, { unlearned: 0, learned: 1 });
});

test('代理回答プレフィックス付きの後続発言は判定に渡さない', async t => {
  const f = fixture(t);
  let calls = 0;
  mockLearning(f, () => { calls++; return learnCorrected; });
  await runOnce(f.options);
  addKimFollowup(f, '【kimのClaudeによる代理回答】\n別の質問への回答');
  await runOnce(f.options);
  assert.equal(calls, 0);
  assert.deepEqual(f.state().learnQueue[0].evaluatedKimIds, []);
  assert.equal(f.state().learnQueue[0].learned, false);
});

test('learn-backfill --days 3 --dry-run はDM履歴でIDを補完し、件数だけ返す', async t => {
  const f = fixture(t);
  const log = learningFile(f, 'sent-log.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const entry = { where: 'dm', channelId: 'chat1', question: '質問', content: '代理回答',
    ts: new Date(NOW - 2000).toISOString(), senderName: '田中' };
  fs.writeFileSync(log, [
    { ...entry, replyId: 'known-id' }, entry, { ...entry, content: '履歴にない本文' },
    { ...entry, where: 'guild', replyId: 'guild-id' },
    { ...entry, ts: new Date(NOW - 4 * 86400000).toISOString(), replyId: 'old-id' }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  f.data.chat1.push(message({ id: 'resolved-id', isSender: true, text: entry.content, timestamp: entry.ts }));
  const reports = [];
  const options = { ...f.options, print: report => reports.push(report) };
  assert.equal(await main(['learn-backfill', '--days', '3', '--dry-run'], options), 0);
  assert.deepEqual(reports.at(-1), { ok: true, dryRun: true, count: 2 });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(await main(['learn-backfill', '--days', '3'], options), 0);
  assert.deepEqual(f.state().learnQueue.map(row => row.replyId), ['known-id', 'resolved-id']);
  assert.equal(await main(['learn-backfill', '--days', '3'], options), 0);
  assert.equal(reports.at(-1).count, 0);
});


test('送信上限に達した巡回でも後続訂正を学習する', async t => {
  const f = fixture(t);
  mockLearning(f, () => learnCorrected);
  await runOnce(f.options);
  addKimFollowup(f, '担当は百瀬です');
  f.data.chat1.push(message({ id: 'next-question', text: '次の案件は？',
    timestamp: new Date(NOW + 1500).toISOString() }));
  const state = f.state();
  state.hourly = Array(30).fill(NOW);
  f.save(state);
  const result = await runOnce(f.options);
  assert.equal(result.limited, true);
  assert.equal(result.replied, 0);
  assert.equal(result.learned.corrected, 1);
});

test('送信結果の復旧でも読み戻した返信をキューに追加する', async t => {
  const f = fixture(t);
  const content = '【kimのClaudeによる代理回答】\n回答';
  const sent = message({ id: 'recovered-reply', text: content, isSender: true,
    timestamp: new Date(NOW).toISOString() });
  f.data.chat1.push(sent);
  f.save({ version: 1, hourly: [], chats: { chat1: { ...message(), status: 'sending',
    content, question: '質問' } } });
  assert.equal((await runOnce(f.options)).ok, true);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.state().learnQueue, [{
    chatId: 'chat1', replyId: sent.id, question: '質問', answer: content, ts: sent.timestamp,
    senderName: '田中', evaluatedKimIds: [], learned: false
  }]);
});

for (const started of [false, true]) {
  test(`トライアル本人辞退: 開始済み=${started} の定型文を dryRun で返す`, async t => {
    const messages = [message({ senderName: 'テスト参加者', text: 'トライアルを辞退させてください' })];
    if (started) messages.push(message({ senderName: 'テスト参加者', id: 'report', timestamp: new Date(NOW - 5000).toISOString(), text: 'トライアル 1日目 累計2時間' }));
    const f = fixture(t, { messages });
    f.options.llm = async ({ category }) => {
      assert.equal(category, 'classification');
      return '{"selfDecline":true}';
    };
    const result = await runOnce({ ...f.options, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.decisions.length, 0);
    assert.equal(result.wouldSend.length, 1);
    assert.equal(result.wouldSend[0].content.includes('まだ入社手続きをしていない場合は不要です。'), !started);
    assert.match(result.wouldSend[0].content, /ご連絡ありがとうございます。承知いたしました。/);
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(f.file), false);
  });
}

for (const blocked of [{ isMessageRequest: true }, { isReadOnly: true }, { participants: { items: [{ isSelf: true, cannotMessage: true }] } }]) {
  test('辞退でも送信不可の会話は判断待ち: ' + JSON.stringify(blocked), async t => {
    const f = fixture(t, { chats: [chat(blocked)], messages: [message({ senderName: 'テスト参加者', text: '辞退します' })] });
    f.options.llm = async () => { assert.fail('分類不要'); };
    const result = await runOnce({ ...f.options, dryRun: true });
    assert.equal(result.decisions.length, 1);
    assert.equal(result.wouldSend.length, 0);
  });
}

for (const text of ['こんにちは', '別の業務を辞めたいです']) {
  test('本人辞退以外の初対面は従来処理: ' + text, async t => {
    const f = fixture(t, { messages: [message({ senderName: 'テスト参加者', text })] });
    let calls = 0;
    f.options.llm = async () => { calls++; return '{"selfDecline":false}'; };
    const result = await runOnce({ ...f.options, dryRun: true });
    assert.equal(result.decisions[0].reason, '初対面または会話履歴を確認できません');
    assert.equal(result.wouldSend.length, 0);
    assert.equal(calls, text.includes('辞め') ? 1 : 0);
  });
}

test('本人辞退の定型文は会話ごとに一度のみ、次回は従来分類', async t => {
  const f = fixture(t, { messages: [message({ senderName: 'テスト参加者', text: '辞退します' })] });
  f.options.llm = async ({ category }) => category === 'classification'
    ? '{"selfDecline":true}' : JSON.stringify({ ...reply, needs_reply: false });
  const first = await runOnce(f.options);
  assert.equal(first.replied, 1);
  assert.equal(f.state().trialSelfDeclined.chat1, true);
  f.data.chat1.push(message({ senderName: 'テスト参加者', id: 'second-decline', timestamp: new Date(NOW + 1000).toISOString(), text: '辞退します' }));
  const second = await runOnce({ ...f.options, now: NOW + 2000 });
  assert.equal(second.replied, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.state().chats.chat1.status, 'fyi');
});
test('トライアル途中通過条件の未達は終了案内の定型文を dryRun で返す（送信しない）', async t => {
  const f = fixture(t, { messages: [message({ senderName: 'テスト参加者', text: '昨日のトライアル3日目で到達タスクが20件未満だったのですが、本日も業務を続けてよろしいのでしょうか。' })] });
  f.options.llm = async () => { assert.fail('未達の判定に LLM は使わない'); };
  const result = await runOnce({ ...f.options, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.wouldSend.length, 1);
  assert.equal(result.wouldSend[0].content.includes(trialFailAnswer(false)), true);
  assert.match(result.wouldSend[0].content, /トライアルは終了とさせていただきます/);
  assert.equal(f.sent.length, 0);
});

test('トライアル3日目で累計20件以上の報告は従来の分類に進み、終了案内を出さない', async t => {
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 5000).toISOString(), text: '前回の案内' }),
    message({ senderName: 'テスト参加者', text: '1.トライアル：3日目\n6.累計完了タスク数\nイベントタスク：18件、チュートリアル情報収集：6件、マニュアル更新：4件\n本日も続けてよいですか' }),
  ] });
  let classified = 0;
  f.options.llm = async ({ category }) => {
    if (category === 'jp_reply') {
      classified++;
      return JSON.stringify({ needs_reply: true, needs_kim_decision: false, answer: '3日目の途中通過条件は満たしています。引き続き進めてください。', confidence: 0.95 });
    }
    return '{}';
  };
  const result = await runOnce({ ...f.options, dryRun: true });
  assert.equal(classified, 1);
  assert.equal(result.wouldSend.length, 1);
  assert.match(result.wouldSend[0].content, /途中通過条件は満たしています/);
  assert.equal(result.wouldSend[0].content.includes('トライアルは終了とさせていただきます'), false);
  assert.equal(f.sent.length, 0);
});

test('途中通過条件未達の定型文は会話ごとに一度のみ', async t => {
  const f = fixture(t, { messages: [
    message({ id: 'own', isSender: true, timestamp: new Date(NOW - 5000).toISOString(), text: '前回の案内' }),
    message({ senderName: 'テスト参加者', text: '昨日のトライアル3日目で到達タスクが20件未満だったのですが、本日も業務を続けてよろしいのでしょうか。' }),
  ] });
  f.options.llm = async ({ category }) => category === 'jp_reply'
    ? JSON.stringify({ ...reply, needs_reply: false })
    : '{}';
  const first = await runOnce(f.options);
  assert.equal(first.replied, 1);
  assert.equal(f.state().trialMidpointFailed.chat1, true);
  f.data.chat1.push(message({ senderName: 'テスト参加者', id: 'second-fail', timestamp: new Date(NOW + 1000).toISOString(), text: '昨日のトライアル3日目で到達タスクが20件未満だったのですが、本日も業務を続けてよろしいのでしょうか。' }));
  const second = await runOnce({ ...f.options, now: NOW + 2000 });
  assert.equal(second.replied, 0);
  assert.equal(f.sent.length, 1);
});

