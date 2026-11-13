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

test('group の空 mentions でも HTML 金功勇メンションを拾い金額は判断待ち', async t => {
  const f = fixture(t, { chats: [chat({ type: 'group' })] });
  f.data.chat1[0].text = '<p><a href="https://matrix.to/#/kim">金功勇</a> 検品結果をご確認のうえ請求の金額をご教示ください</p>';
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems.length, 1);
  assert.equal(f.inboxItems[0].kind, 'ask');
  assert.doesNotMatch(f.inboxItems[0].text, /転送/);
});

for (const request of [{ capabilities: { messageRequest: { acceptWithMessage: 1 } } }, { isMessageRequest: true }, { participants: { items: [{ isPending: true }] } }]) {
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

test('人の判断が必要な回答は kim-inbox ask に入り「転送」を含めない', async t => {
  const f = fixture(t, { decision: { ...reply, needs_kim_decision: true } });
  const result = await runOnce(f.options);
  assert.equal(result.decisions.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.inboxItems.length, 1);
  assert.equal(f.inboxItems[0].kind, 'ask');
  assert.doesNotMatch(f.inboxItems[0].text, /転送/);
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
