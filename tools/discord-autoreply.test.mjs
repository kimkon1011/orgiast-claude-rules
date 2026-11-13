import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runOnce, main, createDiscord, discordRequest, ensureTaskPriority, createLlm, contentFor, parseJson, combinePermissions, inventedAmounts } from './discord-autoreply.mjs';

const NOW = Date.parse('2026-10-09T03:00:00Z');
const KIM = '715210673642012733';
const json = data => new Response(JSON.stringify(data), { status: 200 });
const decision = { needs_reply: true, needs_kim_decision: false, answer: '資料を確認します。', confidence: 0.9 };
function message(overrides = {}) {
  return { id: '100', channel_id: 'channel', content: `<@${KIM}> 資料を確認してもらえますか？`,
    timestamp: new Date(NOW - 1000).toISOString(), author: { id: 'member', username: '田中', bot: false }, ...overrides };
}
function fixture(t, { initial = true, messages = [message()], reply = [], after = [], llmResult = decision, ...extra } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-autoreply-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'discord-autoreply');
  fs.mkdirSync(dir, { recursive: true });
  const file = name => path.join(dir, name);
  const state = { baselineTs: NOW - 2000, handled: {}, replies: reply, hourly: [] };
  if (initial) fs.writeFileSync(file('state.json'), JSON.stringify(state));
  const calls = [], notifications = [], llmCalls = [];
  const options = {
    home, now: () => NOW, env: {}, readTokenImpl: () => ({ admin: true, token: 'test-token' }),
    notifyKimImpl: async text => { notifications.push(text); return { delivered: 'dm' }; },
    addItemImpl: async () => ({ id: 'mock-inbox-item' }),
    llm: async input => { llmCalls.push(input); return JSON.stringify(llmResult); },
    fetchImpl: async (url, init) => {
      const u = new URL(url); calls.push({ path: u.pathname, query: u.searchParams, ...init, body: init.body && JSON.parse(init.body) });
      assert.equal(init.headers['User-Agent'], 'DiscordBot (orgiast-autoreply, 1.0)');
      assert.equal(init.headers.Authorization, 'Bot test-token');
      if (u.pathname.endsWith('/members/self')) return json({ roles: ['bot-role'] });
      if (u.pathname.endsWith('/roles')) return json([{ id: '715211007307284530', permissions: '0' }, { id: 'bot-role', permissions: '8' }]);
      if (u.pathname.endsWith('/users/@me')) return json({ id: 'self' });
      if (u.pathname.endsWith('/messages/search')) return json({ total: messages.length, messages: messages.map(m => [m]) });
      if (init.method === 'POST') return json({ id: '200' });
      if (init.method === 'PATCH') return json({ id: '200' });
      if (u.searchParams.has('after')) return json(typeof after === 'function' ? after(u.searchParams.get('after')) : after);
      if (u.searchParams.has('before')) return json([]);
      if (u.pathname.endsWith('/channel')) return json({ name: '相談' });
      throw new Error(`Unexpected request: ${url}`);
    }, ...extra,
  };
  return { options, home, dir, file, calls, notifications, llmCalls, state,
    readState: () => JSON.parse(fs.readFileSync(file('state.json'), 'utf8')),
    writeState: () => fs.writeFileSync(file('state.json'), JSON.stringify(state)),
    posts: () => calls.filter(x => x.method === 'POST'), patches: () => calls.filter(x => x.method === 'PATCH') };
}
function prior(overrides = {}) {
  return { msgId: '100', channelId: 'channel', channelName: '相談', authorId: 'member', authorName: '田中',
    question: '締切は？', answer: '金曜です。', replyId: '200', ts: NOW - 10000, needsKimDecision: false, learned: false, outcome: null, ...overrides };
}
function kim(overrides = {}) { return message({ id: '300', author: { id: KIM }, content: '締切は木曜です。', message_reference: { message_id: '200' }, ...overrides }); }

test('baselineより古い投稿、7日超、bot、kim、自分、除外chを除外', async t => {
  const f = fixture(t, { messages: [
    message({ id: '1', timestamp: new Date(NOW - 3000).toISOString() }),
    message({ id: '2', timestamp: new Date(NOW - 8 * 86400000 - 1).toISOString() }),
    message({ id: '3', author: { id: 'bot', bot: true } }), message({ id: '4', author: { id: KIM } }),
    message({ id: '5', author: { id: 'self' } }), message({ id: '6', channel_id: 'excluded' }),
    message({ id: '7', channel_id: 'notify' }), message({ id: '8', channel_id: 'autopilot' }),
  ] });
  f.options.env.DISCORD_AUTOREPLY_EXCLUDE = ' excluded , other ';
  fs.writeFileSync(path.join(f.home, '.claude', 'orgiast-discord-channel-id.txt'), 'notify');
  fs.writeFileSync(path.join(f.home, '.claude', 'orgiast-autopilot-channel-id.txt'), 'autopilot');
  const result = await runOnce(f.options);
  assert.equal(result.ok, true); assert.equal(f.posts().length, 0);
  assert.deepEqual(result.skipped, { kim_replied: 0, fyi: 0, excluded: 3, old: 2, bot: 3 });
});
test('初回はネットワークより先にbaselineを永続化し過去に返信しない', async t => {
  const f = fixture(t, { initial: false });
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = (...args) => { assert.equal(f.readState().baselineTs, NOW); return fetchImpl(...args); };
  const result = await runOnce(f.options);
  assert.equal(result.skipped.old, 1); assert.equal(f.posts().length, 0);
  assert.match(fs.readFileSync(f.file('knowledge.md'), 'utf8'), /株式会社オージャスト/);
});
test('kimの既返信はhandledに保存', async t => {
  const f = fixture(t, { after: [kim()] });
  await runOnce(f.options);
  assert.equal(f.readState().handled['100'].reason, 'kim_replied'); assert.equal(f.posts().length, 0);
});
test('自己返信が既存なら重複送信しない', async t => {
  const f = fixture(t, { after: [message({ author: { id: 'self' }, content: '【Claude自動返信】\n回答' })] });
  await runOnce(f.options);
  assert.equal(f.readState().handled['100'].reason, 'already'); assert.equal(f.posts().length, 0);
});
test('FYIは返信しない', async t => {
  const f = fixture(t, { llmResult: { ...decision, needs_reply: false } });
  const result = await runOnce(f.options);
  assert.equal(result.skipped.fyi, 1); assert.equal(f.readState().handled['100'].reason, 'fyi'); assert.equal(f.posts().length, 0);
});
test('質問にprefixとmessage_reference付きPOST、履歴とログを保存', async t => {
  const f = fixture(t); const result = await runOnce(f.options);
  assert.equal(result.replied, 1); assert.equal(result.errors.length, 0);
  const body = f.posts()[0].body;
  assert.ok(body.content.startsWith('【kimのClaudeによる代理回答】\n'));
  assert.deepEqual(body.message_reference, { message_id: '100' });
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: true });
  assert.equal(f.readState().replies[0].replyId, '200');
  assert.equal(f.readState().hourly.length, 1); assert.ok(fs.existsSync(f.file('run.log')));
  assert.equal(f.llmCalls[0].category, 'jp_reply');
  await runOnce(f.options); assert.equal(f.posts().length, 1);
});
test('判断待ちは暫定回答を送信しkim-inboxにも保存', async t => {
  const inboxItems = [];
  const f = fixture(t, { llmResult: { ...decision, needs_kim_decision: true }, addItemImpl: async (home, item) => { inboxItems.push(item); return { id: 'ki-1' }; } });
  await runOnce(f.options);
  assert.equal(f.posts().length, 1);
  assert.ok(f.posts()[0].body.content.includes('kim 本人が確認後、訂正する場合があります'));
  assert.equal(inboxItems.length, 2);
  assert.equal(inboxItems[0].kind, 'ask');
  assert.match(inboxItems[0].text, /\[Discord 判断待ち \(guild\)\]/);
});

for (const answer of ['', '   ', undefined]) {
  test(`判断が必要でanswer=${JSON.stringify(answer)}なら送信せずaskのみ`, async t => {
    const items = [];
    const f = fixture(t, { llmResult: { ...decision, needs_kim_decision: true, answer },
      addItemImpl: async (_home, item) => { items.push(item); return { id: 'ask' }; } });
    const result = await runOnce(f.options);
    assert.equal(result.ok, true); assert.equal(f.posts().length, 0);
    assert.deepEqual(items.map(i => i.kind), ['ask']);
    assert.equal(f.readState().handled['100'].reason, 'decision');
  });
}

test('禁止表現（kimに確認）→ 再生成1回 → 具体回答で送信', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => {
    calls++;
    const answer = calls === 1 ? 'kimに確認いたします' : 'まず1個購入で進めてください';
    return JSON.stringify({ ...decision, needs_kim_decision: true, answer });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.replied, 1);
  const content = f.posts()[0].body.content;
  assert.match(content, /まず1個購入/); assert.doesNotMatch(content, /確認いたします/);
  assert.match(content, /kim 本人が確認後、訂正する場合があります/);
});
test('禁止表現が2回続いたら送信せず判断待ち（askのみ）', async t => {
  const items = [];
  let calls = 0;
  const f = fixture(t, { addItemImpl: async (_home, item) => { items.push(item); return { id: 'ask' }; } });
  f.options.llm = async () => {
    calls++;
    return JSON.stringify({ ...decision, needs_kim_decision: true, answer: calls === 1 ? '確認待ちです' : '少々お待ちください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.ok, true); assert.equal(f.posts().length, 0);
  assert.equal(f.readState().handled['100'].reason, 'decision');
  assert.deepEqual(items.map(i => i.kind), ['ask']);
  assert.match(items[0].text, /\[Discord 判断待ち \(guild\)\]/);
});
test('禁止表現でもneeds_kim_decision=falseなら再生成後そのまま送信', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => {
    calls++;
    const answer = calls === 1 ? '転送しました' : 'マニュアルの一覧から確認できます。';
    return JSON.stringify({ ...decision, answer });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.replied, 1);
  assert.doesNotMatch(f.posts()[0].body.content, /kim 本人が確認後/);
});
test('禁止表現がなければ再生成しない', async t => {
  let calls = 0;
  const f = fixture(t);
  f.options.llm = async () => { calls++; return JSON.stringify(decision); };
  const result = await runOnce(f.options);
  assert.equal(calls, 1); assert.equal(result.replied, 1);
});

test('禁止表現が2回続きneeds_kim_decision=falseでも送信せずaskのみ', async t => {
  const items = [];
  let calls = 0;
  const f = fixture(t, { addItemImpl: async (_home, item) => { items.push(item); return { id: 'ask' }; } });
  f.options.llm = async () => {
    calls++;
    return JSON.stringify({ ...decision, needs_kim_decision: false, answer: calls === 1 ? '確認待ちです' : '少々お待ちください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.ok, true);
  assert.equal(f.posts().length, 0);
  assert.equal(f.readState().handled['100'].reason, 'decision');
  assert.deepEqual(items.map(i => i.kind), ['ask']);
});

test('センシティブ質問で禁止表現→再生成成功→送信本文に注記＋ask', async t => {
  const items = [];
  let calls = 0;
  const f = fixture(t, { llmResult: { ...decision, needs_kim_decision: false, answer: 'kimに確認いたします' },
    addItemImpl: async (_home, item) => { items.push(item); return { id: 'ki-1' }; } });
  f.options.llm = async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...decision, needs_kim_decision: false, answer: 'kimに確認いたします' });
    return JSON.stringify({ ...decision, needs_kim_decision: true, answer: 'まず1個購入で進めてください' });
  };
  const result = await runOnce(f.options);
  assert.equal(calls, 2); assert.equal(result.replied, 1);
  const content = f.posts()[0].body.content;
  assert.match(content, /まず1個購入/);
  assert.match(content, /kim 本人が確認後、訂正する場合があります/);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'ask');
});

test('判断が必要ならneeds_reply=falseでも暫定回答、dry-runではaskなし', async t => {
  const items = [];
  const f = fixture(t, { llmResult: { ...decision, needs_reply: false, needs_kim_decision: true },
    addItemImpl: async (_home, item) => { items.push(item); return { id: 'item' }; } });
  const preview = await runOnce({ ...f.options, dryRun: true });
  assert.equal(preview.wouldSend.length, 1); assert.equal(items.length, 0);
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1);
  assert.equal(f.posts()[0].body.content, contentFor('資料を確認します。\n\n（kim 本人が確認後、訂正する場合があります）'));
  assert.deepEqual(items.map(i => i.kind), ['ask', 'info']);
});

test('baselineより新しくても7日より前の投稿は送信もaskもなし', async t => {
  const f = fixture(t, { messages: [message({ timestamp: new Date(NOW - 8 * 86400000 - 1).toISOString() })],
    addItemImpl: async () => assert.fail('must not record inbox item') });
  f.state.baselineTs = NOW - 48 * 3600000; f.writeState();
  const result = await runOnce(f.options);
  assert.equal(result.skipped.old, 1); assert.equal(f.posts().length, 0); assert.equal(f.llmCalls.length, 0);
});
test('3日前のメンション → 回答対象（maxAgeMs=7dで上書き）', async t => {
  const f = fixture(t, { messages: [message({ timestamp: new Date(NOW - 3 * 86400000).toISOString() })] });
  f.state.baselineTs = NOW - 10 * 86400000; f.writeState();
  const result = await runOnce({ ...f.options, maxAgeMs: 7 * 86400000 });
  assert.equal(result.replied, 1); assert.equal(f.posts().length, 1);
});
test('8日前のメンション → old', async t => {
  const f = fixture(t, { messages: [message({ timestamp: new Date(NOW - 8 * 86400000 - 1).toISOString() })],
    addItemImpl: async () => assert.fail('must not record inbox item') });
  f.state.baselineTs = NOW - 10 * 86400000; f.writeState();
  const result = await runOnce(f.options);
  assert.equal(result.skipped.old, 1); assert.equal(f.posts().length, 0); assert.equal(f.llmCalls.length, 0);
});
test('既定24h: 30時間前のメンション → skipped（stateに保存しない）', async t => {
  const f = fixture(t, {
    messages: [message({ timestamp: new Date(NOW - 30 * 3600000).toISOString() })],
    addItemImpl: async () => assert.fail('must not record inbox item')
  });
  f.state.baselineTs = NOW - 48 * 3600000; f.writeState();
  const result = await runOnce(f.options);
  assert.equal(result.skipped.old, 1); assert.equal(f.posts().length, 0); assert.equal(f.llmCalls.length, 0);
  assert.equal(f.readState().handled['100'], undefined);
});
test('maxAgeMs=48h: 30時間前は回答対象、50時間前はskipped', async t => {
  const f = fixture(t, {
    messages: [message({ timestamp: new Date(NOW - 30 * 3600000).toISOString() })],
    addItemImpl: async () => assert.fail('must not record inbox item on 30h case')
  });
  f.state.baselineTs = NOW - 72 * 3600000; f.writeState();
  const result = await runOnce({ ...f.options, maxAgeMs: 48 * 3600000 });
  assert.equal(result.replied, 1); assert.equal(f.posts().length, 1);
  const f2 = fixture(t, {
    messages: [message({ timestamp: new Date(NOW - 50 * 3600000).toISOString() })],
    addItemImpl: async () => assert.fail('must not record inbox item on 50h case')
  });
  f2.state.baselineTs = NOW - 72 * 3600000; f2.writeState();
  const result2 = await runOnce({ ...f2.options, maxAgeMs: 48 * 3600000 });
  assert.equal(result2.skipped.old, 1); assert.equal(f2.posts().length, 0);
});
test('--max-age-hours 0 / 200 / abc → エラー', async t => {
  const out = [];
  for (const arg of ['0', '200', 'abc']) {
    const f = fixture(t, { messages: [] });
    const code = await main(['--max-age-hours', arg, '--dry-run'], { ...f.options, print: v => out.push(v) });
    assert.equal(code, 1);
    assert.match(out.at(-1)?.error || '', /--max-age-hours/);
  }
});
test('生成中にkimが発言したら送信直前に止める', async t => {
  let count = 0;
  const f = fixture(t, { after: () => ++count === 1 ? [] : [kim()] });
  await runOnce(f.options); assert.equal(f.posts().length, 0); assert.equal(f.readState().handled['100'].reason, 'kim_replied');
});
test('parse失敗をhandledに記録し再試行・通知しない', async t => {
  const f = fixture(t); f.options.llm = async () => 'not json';
  await runOnce(f.options); await runOnce(f.options);
  assert.equal(f.readState().handled['100'].reason, 'llm_parse_error');
  assert.equal(f.posts().length, 0); assert.equal(f.notifications.length, 0);
});
test('JSONの周囲に説明があっても抽出、不正なboolは拒否', async t => {
  assert.deepEqual(parseJson('説明```json\n{"a":1}\n```'), { a: 1 });
  const f = fixture(t, { llmResult: { ...decision, needs_reply: 'false' } });
  await runOnce(f.options); assert.equal(f.posts().length, 0);
});
test('kim訂正で例・ルール・事実を追記し自己返信だけPATCH', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim()],
    llmResult: { is_correction: true, is_confirmation: false, rule: '締切は木曜', fact: '定例の締切は木曜' } });
  const result = await runOnce(f.options);
  assert.equal(result.learned.corrected, 1); assert.equal(f.readState().replies[0].outcome, 'corrected');
  assert.equal(JSON.parse(fs.readFileSync(f.file('corrections.jsonl'), 'utf8')).kimAnswer, '締切は木曜です。');
  assert.match(fs.readFileSync(f.file('rules.md'), 'utf8'), /- 締切は木曜/);
  assert.match(fs.readFileSync(f.file('knowledge.md'), 'utf8'), /- 定例の締切は木曜/);
  assert.equal(f.patches()[0].path, '/api/v10/channels/channel/messages/200');
  assert.match(f.patches()[0].body.content, /^【kimのClaudeによる代理回答・kimが訂正済み/);
  assert.equal(f.llmCalls[0].category, 'classification');
  await runOnce(f.options); assert.equal(f.patches().length, 1);
});
test('訂正編集が失敗したら次周は学習例を重複させずPATCHを再試行', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim()],
    llmResult: { is_correction: true, is_confirmation: false, rule: '木曜', fact: null } });
  const fetchImpl = f.options.fetchImpl; let fail = true;
  f.options.fetchImpl = async (...args) => args[1].method === 'PATCH' && fail ? new Response('', { status: 500 }) : fetchImpl(...args);
  await runOnce(f.options); assert.equal(f.readState().replies[0].pendingEdit, true);
  fail = false; await runOnce(f.options);
  assert.equal(f.patches().length, 1); assert.equal(f.llmCalls.length, 1);
  assert.equal(fs.readFileSync(f.file('corrections.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('確認はconfirmed、rule:nullの正解例、PATCHなし', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim()],
    llmResult: { is_correction: false, is_confirmation: true, rule: 'ignored', fact: null } });
  const result = await runOnce(f.options);
  assert.equal(result.learned.confirmed, 1); assert.equal(f.readState().replies[0].outcome, 'confirmed');
  assert.equal(JSON.parse(fs.readFileSync(f.file('corrections.jsonl'), 'utf8')).rule, null); assert.equal(f.patches().length, 0);
});
test('72h経過でkim発言なしはexpired', async t => {
  const f = fixture(t, { messages: [], reply: [prior({ ts: NOW - 72 * 3600000 })] });
  const result = await runOnce(f.options);
  assert.equal(result.learned.expired, 1); assert.equal(f.readState().replies[0].learned, true);
});
test('kimの返信参照を最優先、無関係な発言の後でも後続訂正を学習', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim({ id: '301', message_reference: null, content: '雑談' }), kim()] });
  f.options.llm = async ({ input }) => {
    assert.equal(input.kimAnswer, '締切は木曜です。');
    return JSON.stringify({ is_correction: true, is_confirmation: false, rule: null, fact: null });
  };
  await runOnce(f.options); assert.equal(f.readState().replies[0].outcome, 'corrected');
});
test('無関係なkim発言を繰り返し学習せず次の発言を待つ', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim()],
    llmResult: { is_correction: false, is_confirmation: false, rule: null, fact: null } });
  await runOnce(f.options); await runOnce(f.options);
  assert.equal(f.llmCalls.length, 1); assert.equal(f.readState().replies[0].learned, false);
});
test('1時間30件超でPAUSEと通知1回、その後は何もしない', async t => {
  const f = fixture(t); f.state.hourly = Array(31).fill(NOW - 1000); f.writeState();
  const result = await runOnce(f.options); const count = f.calls.length;
  assert.equal(result.paused, true); assert.equal(f.posts().length, 0); assert.ok(fs.existsSync(f.file('PAUSE')));
  assert.deepEqual(f.notifications, ['自動返信を異常停止（1時間30件超）']);
  await runOnce(f.options); assert.equal(f.calls.length, count); assert.equal(f.notifications.length, 1);
});
test('31件目の送信成功直後にもPAUSEを保存', async t => {
  const f = fixture(t); f.state.hourly = Array(30).fill(NOW - 1000); f.writeState();
  const result = await runOnce(f.options);
  assert.equal(result.replied, 1); assert.equal(result.paused, true); assert.equal(f.notifications.length, 1);
});
test('dry-runはcontentを返すがPOST・通知・stateその他ファイルを書かない', async t => {
  const f = fixture(t, { llmResult: { ...decision, needs_kim_decision: true } });
  const before = fs.readFileSync(f.file('state.json'), 'utf8');
  const result = await runOnce({ ...f.options, dryRun: true });
  assert.equal(result.wouldSend.length, 1); assert.match(result.wouldSend[0].content, /^【kimのClaudeによる代理回答】/);
  assert.equal(f.posts().length, 0); assert.equal(f.notifications.length, 0);
  assert.equal(fs.readFileSync(f.file('state.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.dir), ['state.json']);
});
test('初回dry-runはbaselineも種ファイルも作らない', async t => {
  const f = fixture(t, { initial: false });
  const result = await runOnce({ ...f.options, dryRun: true });
  assert.equal(result.wouldSend.length, 0); assert.deepEqual(fs.readdirSync(f.dir), []);
});
test('dry-run学習はPATCH・学習ファイル更新なし', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim()],
    llmResult: { is_correction: true, is_confirmation: false, rule: '木曜', fact: '木曜' } });
  const before = fs.readFileSync(f.file('state.json'), 'utf8');
  await runOnce({ ...f.options, dryRun: true });
  assert.equal(f.patches().length, 0); assert.equal(fs.readFileSync(f.file('state.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.dir), ['state.json']);
});
test('429はretry_after秒待ち1回のみ再試行', async () => {
  let requests = 0; const waits = [];
  const api = createDiscord({ token: 'test', sleepImpl: async ms => waits.push(ms), fetchImpl: async () => {
    requests++; return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 });
  } });
  await assert.rejects(api('/users/@me'), /HTTP 429/);
  assert.equal(requests, 2); assert.deepEqual(waits, [10]);
});
test('接続失敗はclose接続で2回再試行しroute名を残す', async () => {
  const calls = [], waits = [];
  const api = createDiscord({ token: 'test', sleepImpl: async ms => waits.push(ms), fetchImpl: async (url, init) => {
    calls.push({ url, headers: init.headers }); throw new DOMException('aborted', 'TimeoutError');
  } });
  await assert.rejects(api('/users/@me'), /Discord GET \/users\/@me timeout/);
  assert.equal(calls.length, 3); assert.deepEqual(waits, [250, 500]);
  assert.equal(calls[1].headers.Connection, 'close');
});
test('users me失敗時もtoken由来IDで検索まで継続', async t => {
  const token = Buffer.from('123456789012345678').toString('base64url') + '.x.y';
  const f = fixture(t, { messages: [], readTokenImpl: () => ({ admin: true, token }) });
  const base = f.options.fetchImpl;
  f.options.sleepImpl = async () => {};
  f.options.fetchImpl = async (url, init) => new URL(url).pathname.endsWith('/users/@me')
    ? Promise.reject(new DOMException('aborted', 'TimeoutError')) : base(url, init);
  const result = await runOnce(f.options);
  assert.equal(result.scanned, 0); assert.match(result.errors[0], /identity: Discord GET \/users\/@me timeout/);
  assert.ok(f.calls.some(c => c.path.endsWith('/messages/search')));
});
test('fresh lockは処理せずstale lockは回収', async t => {
  const f = fixture(t); fs.writeFileSync(f.file('lock'), 'other');
  const live = await runOnce(f.options); assert.equal(live.locked, true); assert.equal(f.calls.length, 0);
  const old = new Date(NOW - 16 * 60000); fs.utimesSync(f.file('lock'), old, old);
  const recovered = await runOnce(f.options); assert.equal(recovered.replied, 1); assert.equal(fs.existsSync(f.file('lock')), false);
});
test('admin tokenがなければ指定エラーで終了1、state未作成', async t => {
  const f = fixture(t, { initial: false, readTokenImpl: () => ({ admin: false, token: 'x' }) }); const output = [];
  const code = await main(['once'], { ...f.options, print: v => output.push(v) });
  assert.equal(code, 1); assert.match(output[0].error, /admin token がありません/); assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
test('壊れたstateはリセットせずfatal', async t => {
  const f = fixture(t); fs.writeFileSync(f.file('state.json'), '{invalid');
  const result = await runOnce(f.options);
  assert.equal(result.ok, false); assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(f.file('state.json'), 'utf8'), '{invalid');
});
test('status / pause / resumeと引数チェック', async t => {
  const f = fixture(t), out = []; const options = { ...f.options, print: v => out.push(v) };
  assert.equal(await main(['pause'], options), 0); assert.ok(fs.existsSync(f.file('PAUSE')));
  await main(['status'], options); assert.equal(out.at(-1).paused, true);
  await main(['resume'], options); assert.equal(fs.existsSync(f.file('PAUSE')), false);
  assert.equal(await main(['loop', '--interval', '0'], options), 1);
});
test('2000 UTF-16文字以内、免責文と補助文字を維持', () => {
  for (const corrected of [false, true]) {
    const content = contentFor('😀'.repeat(3000), corrected);
    assert.ok(content.length <= 2000); assert.ok(!content.includes('\uFFFD')); assert.match(content, /訂正があれば kim が追って返信します。$/);
  }
});
test('rulesが200行を超えたらclassificationで統合', async t => {
  const f = fixture(t, { messages: [] }); fs.writeFileSync(f.file('rules.md'), Array.from({ length: 201 }, (_, i) => `- rule ${i}`).join('\n'));
  f.options.llm = async input => { assert.equal(input.category, 'classification'); return '{"rules":["統合済み"]}'; };
  await runOnce(f.options); assert.equal(fs.readFileSync(f.file('rules.md'), 'utf8'), '- 統合済み\n');
});
test('500件を超える履歴は古い順に切る', async t => {
  const f = fixture(t, { messages: [], reply: Array.from({ length: 501 }, (_, i) => prior({ msgId: String(i), ts: NOW - 1000 + i, learned: true, outcome: 'confirmed' })) });
  await runOnce(f.options); assert.equal(f.readState().replies.length, 500); assert.equal(f.readState().replies[0].msgId, '1');
});
test('登録スクリプトはASCII、無期限5分、非昇格principal、登録後開始', () => {
  const text = fs.readFileSync(new URL('./register-discord-autoreply.ps1', import.meta.url), 'utf8');
  assert.match(text, /^[\x00-\x7F]*$/); assert.match(text, /New-TimeSpan -Minutes 5/);
  // AtLogOn needs elevation on member PCs (0x80070005); the registrar must not use it.
  assert.doesNotMatch(text, /-AtLogOn/); assert.match(text, /-LogonType Interactive -RunLevel Limited/); assert.match(text, /-MultipleInstances IgnoreNew/);
  assert.match(text, /ExecutionTimeLimit \(New-TimeSpan -Minutes 10\)/);
  assert.ok(text.indexOf('Start-ScheduledTask') > text.indexOf('Register-ScheduledTask -TaskName'));
});

test('50件を超える会話でもkim返信を見落とさない', async t => {
  const f = fixture(t, { after: cursor => cursor === '100'
    ? Array.from({ length: 50 }, (_, i) => message({ id: String(101 + i) }))
    : [kim({ id: '151' })] });
  const result = await runOnce(f.options);
  assert.equal(result.skipped.kim_replied, 1); assert.equal(f.posts().length, 0);
  assert.ok(f.calls.some(c => c.query.get('after') === '150'));
});
test('knowledge全文・rules全文・直近30件の正負例をプロンプトに渡す', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file('knowledge.md'), '追記事実'); fs.writeFileSync(f.file('rules.md'), '- 学習ルール\n');
  fs.writeFileSync(f.file('corrections.jsonl'), Array.from({ length: 40 }, (_, i) => JSON.stringify({ msgId: String(i), outcome: i % 2 ? 'corrected' : 'confirmed', rule: null })).join('\n'));
  await runOnce(f.options);
  const input = f.llmCalls[0].input;
  assert.equal(input.knowledge, '追記事実'); assert.equal(input.rules, '- 学習ルール\n');
  assert.equal(input.corrections.length, 30); assert.equal(input.corrections[0].msgId, '10');
  assert.equal(input.corrections[0].outcome, 'confirmed');
});
test('同じruleは重複追記しない', async t => {
  const f = fixture(t, { messages: [], reply: [prior()], after: [kim()],
    llmResult: { is_correction: true, is_confirmation: false, rule: '締切は木曜', fact: null } });
  fs.writeFileSync(f.file('rules.md'), '- 締切は木曜\n');
  await runOnce(f.options); assert.equal(fs.readFileSync(f.file('rules.md'), 'utf8'), '- 締切は木曜\n');
});
test('同一起動runtimeではusers/@meは1回だけ', async t => {
  const f = fixture(t, { messages: [] }), runtime = {};
  await runOnce({ ...f.options, runtime }); await runOnce({ ...f.options, runtime });
  assert.equal(f.calls.filter(c => c.path.endsWith('/users/@me')).length, 1);
});
test('LLMは既存envとfallbackを使い返信textと利用記録を返す', async t => {
  const f = fixture(t, { messages: [] });
  for (const [name, key] of [['groq', 'GROQ_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY'], ['deepseek', 'DEEPSEEK_API_KEY']]) {
    fs.writeFileSync(path.join(f.home, '.claude', `${name}.env`), `${key}=test-key\n`);
  }
  const requests = [];
  const llm = createLlm({ home: f.home, fetchImpl: async (url, init) => {
    const payload = JSON.parse(init.body); requests.push(payload);
    assert.ok(!/anthropic/i.test(url)); assert.ok(!/claude/i.test(payload.model));
    return json({ choices: [{ message: { content: JSON.stringify(decision) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
  } });
  assert.deepEqual(JSON.parse(await llm({ category: 'jp_reply', system: '方針', input: { question: '質問' } })), decision);
  assert.equal(requests.length, 1); assert.equal(requests[0].messages[0].content, '方針');
  const usage = JSON.parse(fs.readFileSync(path.join(f.home, '.claude', 'executor-usage.jsonl'), 'utf8'));
  assert.equal(usage.tool, 'discord-autoreply'); assert.equal(usage.in, 10); assert.equal(usage.out, 20);
});

const LOG_NAMES = ['run.log', 'log.jsonl'];
const logLines = (f, name) => fs.readFileSync(f.file(name), 'utf8').trim().split('\n');

test('静穏パス2連続はログ1行、lastRunTsは毎回保存', async t => {
  const f = fixture(t, { messages: [] });
  await runOnce(f.options);
  await runOnce({ ...f.options, now: () => NOW + 20000 });
  for (const name of LOG_NAMES) assert.equal(logLines(f, name).length, 1);
  assert.equal(f.readState().lastQuietLogTs, NOW);
  assert.equal(f.readState().lastRunTs, NOW + 20000);
});
test('静穏ログは1時間未満を省略し、ちょうど1時間後に2行目', async t => {
  const f = fixture(t, { messages: [] });
  await runOnce(f.options);
  await runOnce({ ...f.options, now: () => NOW + 3600000 - 1 });
  for (const name of LOG_NAMES) assert.equal(logLines(f, name).length, 1);
  await runOnce({ ...f.options, now: () => NOW + 3600000 });
  for (const name of LOG_NAMES) assert.equal(logLines(f, name).length, 2);
  assert.equal(f.readState().lastQuietLogTs, NOW + 3600000);
  assert.equal(JSON.parse(logLines(f, 'log.jsonl')[1]).ts, NOW + 3600000);
});
test('静穏直後でも返信は記録し静穏ログ時刻を動かさない', async t => {
  const messages = [], f = fixture(t, { messages });
  await runOnce(f.options);
  messages.push(message());
  const result = await runOnce({ ...f.options, now: () => NOW + 20000 });
  assert.equal(result.replied, 1);
  for (const name of LOG_NAMES) assert.equal(logLines(f, name).length, 2);
  assert.equal(JSON.parse(logLines(f, 'log.jsonl')[1]).replied, 1);
  assert.equal(f.readState().lastQuietLogTs, NOW);
});
test('1MB超の各ログを1世代へローテーションし既存の.1を上書き', async t => {
  const f = fixture(t, { messages: [] });
  const previous = 'x'.repeat(1_048_577);
  for (const name of LOG_NAMES) fs.writeFileSync(f.file(name), previous);
  const first = await runOnce(f.options);
  assert.equal(first.ok, true);
  for (const name of LOG_NAMES) {
    assert.equal(fs.readFileSync(f.file(name + '.1'), 'utf8'), previous);
    assert.equal(logLines(f, name).length, 1);
    fs.writeFileSync(f.file(name), 'y'.repeat(1_048_577));
  }
  const second = await runOnce({ ...f.options, now: () => NOW + 3600000 });
  assert.equal(second.ok, true);
  for (const name of LOG_NAMES) {
    assert.equal(fs.readFileSync(f.file(name + '.1'), 'utf8'), 'y'.repeat(1_048_577));
    assert.equal(logLines(f, name).length, 1);
    assert.equal(fs.existsSync(f.file(name + '.2')), false);
  }
});
for (const outcome of ['corrected', 'confirmed', 'expired']) {
  test(`静穏直後でも学習 ${outcome} を記録`, async t => {
    const f = fixture(t, { messages: [], after: outcome === 'expired' ? [] : [kim()],
      llmResult: { is_correction: outcome === 'corrected', is_confirmation: outcome === 'confirmed', rule: null, fact: null } });
    await runOnce(f.options);
    const state = f.readState();
    state.replies = [prior({ ts: outcome === 'expired' ? NOW - 72 * 3600000 : NOW - 10000 })];
    fs.writeFileSync(f.file('state.json'), JSON.stringify(state));
    const result = await runOnce({ ...f.options, now: () => NOW + 20000 });
    assert.equal(result.learned[outcome], 1);
    assert.equal(result.errors.length, 0);
    for (const name of LOG_NAMES) assert.equal(logLines(f, name).length, 2);
    assert.equal(JSON.parse(logLines(f, 'log.jsonl')[1]).learned[outcome], 1);
    assert.equal(f.readState().lastQuietLogTs, NOW);
  });
}
test('静穏直後でもエラーを記録', async t => {
  const f = fixture(t, { messages: [] });
  await runOnce(f.options);
  const result = await runOnce({ ...f.options, now: () => NOW + 20000,
    fetchImpl: async () => { throw new Error('fake network failure'); } });
  assert.equal(result.ok, false);
  for (const name of LOG_NAMES) assert.equal(logLines(f, name).length, 2);
  assert.match(JSON.parse(logLines(f, 'log.jsonl')[1]).errors[0], /fake network failure/);
  assert.equal(f.readState().lastQuietLogTs, NOW);
});
test('1MBちょうどではローテーションしない', async t => {
  const f = fixture(t, { messages: [] });
  for (const name of LOG_NAMES) fs.writeFileSync(f.file(name), 'x'.repeat(1_048_576));
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  for (const name of LOG_NAMES) {
    assert.equal(fs.existsSync(f.file(name + '.1')), false);
    assert.ok(fs.statSync(f.file(name)).size > 1_048_576);
  }
});
test('dry-runは1MB超ログも時刻も変更しない', async t => {
  const f = fixture(t, { messages: [] });
  await runOnce(f.options);
  for (const name of LOG_NAMES) fs.writeFileSync(f.file(name), 'x'.repeat(1_048_577));
  const before = fs.readFileSync(f.file('state.json'), 'utf8');
  const result = await runOnce({ ...f.options, dryRun: true, now: () => NOW + 3600000 });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(f.file('state.json'), 'utf8'), before);
  for (const name of LOG_NAMES) {
    assert.equal(fs.existsSync(f.file(name + '.1')), false);
    assert.equal(fs.readFileSync(f.file(name), 'utf8'), 'x'.repeat(1_048_577));
  }
});

test('メンション検索は人間の投稿だけを対象にし、25件ちょうどなら次のページも取る', async t => {
  const many = Array.from({ length: 25 }, (_, i) => message({ id: String(1000 + i), content: `報告です <@${KIM}>` }));
  const f = fixture(t, { messages: many, llmResult: { needs_reply: false, needs_kim_decision: false, answer: '', confidence: 0.9 } });
  await runOnce(f.options);
  const searches = f.calls.filter(c => c.path.endsWith('/messages/search'));
  assert.ok(searches.length >= 2);
  assert.equal(searches[0].query.get('author_type'), 'user');
  assert.equal(searches[0].query.get('offset'), null);
  assert.equal(searches[1].query.get('offset'), '25');
});

test('権限はeveryoneと所属roleのみをBigIntでORする', () => {
  const roles = [{ id: 'guild', permissions: '1024' }, { id: 'bot', permissions: String((1n << 60n) | 8n) }, { id: 'other', permissions: '16' }];
  assert.equal(combinePermissions('guild', { roles: ['bot'] }, roles), (1n << 60n) | 1032n);
  assert.equal(combinePermissions('guild', { roles: [] }, roles), 1024n);
  assert.throws(() => combinePermissions('guild', {}, roles), /invalid/);
});
function withoutAdmin(f) {
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = (url, init) => new URL(url).pathname.endsWith('/roles')
    ? Promise.resolve(json([{ id: '715211007307284530', permissions: '0' }, { id: 'bot-role', permissions: '1024' }]))
    : fetchImpl(url, init);
}
test('権限確認は1時間ごと、喪失DMは24時間ごと（境界を含む）', async t => {
  const f = fixture(t, { messages: [] }); withoutAdmin(f);
  for (const delta of [0, 3600000 - 1, 3600000, 23 * 3600000, 24 * 3600000 - 1, 24 * 3600000]) {
    await runOnce({ ...f.options, now: () => NOW + delta });
    assert.equal(f.notifications.length, delta < 24 * 3600000 ? 1 : 2);
    if (delta < 3600000) assert.equal(f.calls.filter(c => c.path.endsWith('/members/self')).length, 1);
  }
  assert.match(f.notifications[0], /orgiast を選んで認証/);
  assert.match(f.notifications[0], /client_id=1511684767546871818&scope=bot&permissions=8/);
});
test('通知失敗は成功時刻を保存せず、次の権限確認で再試行', async t => {
  const f = fixture(t, { messages: [] }); withoutAdmin(f);
  f.options.notifyKimImpl = async () => ({ delivered: 'none' });
  assert.equal((await runOnce(f.options)).ok, false);
  assert.equal(f.readState().lastPermNotifyTs, undefined);
  f.options.notifyKimImpl = async text => { f.notifications.push(text); return { delivered: 'dm' }; };
  await runOnce({ ...f.options, now: () => NOW + 3600000 });
  assert.equal(f.notifications.length, 1);
});
test('部分エラーでもok=falseを両ログに記録、3連続で通知し24h間引く', async t => {
  const f = fixture(t, { messages: [], reply: [prior()] });
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = (url, init) => new URL(url).searchParams.has('after')
    ? Promise.resolve(new Response('', { status: 403 })) : fetchImpl(url, init);
  for (let i = 0; i < 4; i++) {
    const result = await runOnce({ ...f.options, now: () => NOW + i * 20000 });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(f.notifications.length, i < 2 ? 0 : 1);
  }
  assert.match(f.notifications[0], /3 サイクル連続/);
  assert.equal(JSON.parse(logLines(f, 'log.jsonl')[0]).ok, false);
  assert.match(logLines(f, 'run.log')[0], /ok=false/);
  await runOnce({ ...f.options, now: () => NOW + 40000 + 24 * 3600000 });
  assert.equal(f.notifications.length, 2);
  f.options.fetchImpl = fetchImpl;
  await runOnce(f.options);
  assert.equal(f.readState().consecutiveErrorCycles, 0);
});
test('致命的ネットワークエラーも連続サイクル通知の対象', async t => {
  const f = fixture(t, { messages: [] });
  f.options.fetchImpl = async () => { throw new Error('offline'); };
  for (let i = 0; i < 3; i++) await runOnce(f.options);
  assert.equal(f.readState().consecutiveErrorCycles, 3);
  assert.equal(f.notifications.length, 1);
});
test('権限API失敗はエラーとして記録し、1時間未満は再確認しない', async t => {
  const f = fixture(t, { messages: [] });
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = (url, init) => new URL(url).pathname.endsWith('/members/self')
    ? Promise.resolve(new Response('', { status: 403 })) : fetchImpl(url, init);
  assert.equal((await runOnce(f.options)).ok, false);
  assert.equal((await runOnce({ ...f.options, now: () => NOW + 1000 })).ok, true);
});
test('権限喪失でもdry-runは通知・state更新をしない', async t => {
  const f = fixture(t, { messages: [] }); withoutAdmin(f);
  const before = fs.readFileSync(f.file('state.json'), 'utf8');
  await runOnce({ ...f.options, dryRun: true });
  assert.equal(f.notifications.length, 0);
  assert.equal(fs.readFileSync(f.file('state.json'), 'utf8'), before);
});

test('gap-check: 対象メッセージ数とキュー登録数を返す', async t => {
  const f = fixture(t, { messages: [
    message({ id: '101', content: `<@${KIM}> 質問1`, timestamp: new Date(NOW - 1000).toISOString() }),
    message({ id: '102', content: `<@${KIM}> 質問2`, timestamp: new Date(NOW - 2000).toISOString() }),
    message({ id: '103', content: `<@${KIM}> 質問3`, timestamp: new Date(NOW - 10 * 86400000).toISOString() }),
  ] });
  const queueDir = path.join(f.home, '.claude', 'reply-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const queueItems = {};
  for (const id of ['101', '102']) {
    queueItems[`rq-${id}`] = {
      id: `rq-${id}`, key: `discord:channel:${id}`,
      channel: 'discord', thread: 'channel', message: id,
      from: { name: '田中', id: 'member', external: false },
      body: 'test', state: 'queued',
    };
  }
  fs.writeFileSync(path.join(queueDir, 'queue.json'), JSON.stringify({ version: 1, items: queueItems }, null, 2));

  const out = [];
  await main(['gap-check', '--days', '7'], { ...f.options, print: v => out.push(v) });
  assert.equal(out.length, 1);
  assert.equal(out[0].targets, 2);
  assert.equal(out[0].enqueued, 2);
});

test('inventedAmounts: 会話に無い金額を検出', () => {
  assert.deepEqual(inventedAmounts('30,000円で対応可能です', '質問文'), [30000]);
});
test('inventedAmounts: 質問文にある金額は検出しない', () => {
  assert.deepEqual(inventedAmounts('330,000円で対応可能です', '330,000円'), []);
});
test('inventedAmounts: 3万円と30,000円は同一扱い', () => {
  assert.deepEqual(inventedAmounts('3万円で対応可能です', '30,000円'), []);
});
test('inventedAmounts: 金額なしは空配列', () => {
  assert.deepEqual(inventedAmounts('対応可能です', ''), []);
});
test('会話に無い金額を含む回答は送信せず判断待ち', async t => {
  const items = [];
  const f = fixture(t, { llmResult: { ...decision, answer: '30,000円で対応可能です' },
    addItemImpl: async (_home, item) => { items.push(item); return { id: 'ask' }; } });
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(f.posts().length, 0);
  assert.equal(f.readState().handled['100'].reason, 'decision');
  assert.deepEqual(items.map(i => i.kind), ['ask']);
});
test('質問文にある金額を回答で引用しても送信される', async t => {
  const f = fixture(t, { messages: [message({ content: '<@715210673642012733> 330,000円の見積もりをお願いします' })],
    llmResult: { ...decision, answer: '330,000円で承りました。' } });
  f.state.baselineTs = NOW - 10000; f.writeState();
  const result = await runOnce(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.replied, 1);
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0].body.content, /330,000円/);
});


test('新規IPv4接続を毎回使い本文読み込みの停止にも期限を適用', async t => {
  const requests = [];
  const url = 'https://discord.test';
  const requestImpl = (url, options, callback) => {
    assert.equal(options.family, 4); assert.equal(options.agent, false);
    const req = new EventEmitter(); requests.push(req);
    req.end = () => {
      const res = new EventEmitter(); res.statusCode = 200;
      callback(res);
      res.emit('data', Buffer.from('{"ok":true}'));
      if (!url.endsWith('/hang')) res.emit('end');
      else options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true });
    };
    return req;
  };
  for (let i = 0; i < 2; i++) {
    const res = await discordRequest(url, { signal: AbortSignal.timeout(2000) }, { requestImpl });
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.equal(new Set(requests).size, 2, 'requests must not be reused across iterations');
  const controller = new AbortController();
  const hanging = discordRequest(url + '/hang', { signal: controller.signal }, { requestImpl });
  controller.abort();
  await assert.rejects(hanging, /abort/i);
});

test('一時的な読取失敗は短い待ちで復旧し各試行の期限を更新', async () => {
  const signals = [], waits = [];
  const api = createDiscord({ token: 'test', sleepImpl: async ms => waits.push(ms), fetchImpl: async (_url, init) => {
    signals.push(init.signal);
    if (signals.length === 1) throw new Error('ECONNRESET');
    return new Response('{"id":"ok"}');
  } });
  assert.deepEqual(await api('/users/@me'), { id: 'ok' });
  assert.deepEqual(waits, [250]); assert.notEqual(signals[0], signals[1]);
});

test('POSTの応答不明・5xxは二重送信を防ぐため再送しない', async () => {
  for (const failure of ['network', 'server']) {
    let calls = 0;
    const api = createDiscord({ token: 'test', sleepImpl: async () => assert.fail('must not retry'), fetchImpl: async () => {
      calls++;
      if (failure === 'network') throw new DOMException('aborted', 'TimeoutError');
      return new Response('', { status: 502 });
    } });
    await assert.rejects(api('/channels/x/messages', { method: 'POST', body: { content: 'test' } }), /timeout|HTTP 502/);
    assert.equal(calls, 1);
  }
});

test('GETの5xxは再試行し429は一度だけretry_afterを尊重', async () => {
  const waits = [];
  const responses = [new Response('', { status: 503 }), new Response('{"retry_after":0.01}', { status: 429 }), new Response('{"ok":true}')];
  const api = createDiscord({ token: 'test', sleepImpl: async ms => waits.push(ms), fetchImpl: async () => responses.shift() });
  assert.deepEqual(await api('/users/@me'), { ok: true });
  assert.deepEqual(waits, [250, 10]);
});


test('Windowsのタスク優先度を通常に戻しUnixでは優先度を変更しない', () => {
  const calls = [];
  const setPriority = (...args) => calls.push(args);
  ensureTaskPriority({ platform: 'win32', setPriority });
  ensureTaskPriority({ platform: 'linux', setPriority });
  assert.deepEqual(calls, [[0, os.constants.priority.PRIORITY_NORMAL]]);
  assert.throws(() => ensureTaskPriority({ platform: 'win32', setPriority: () => { throw new Error('priority failed'); } }), /priority failed/);
});

test('Windows: CLIは通信の前に優先度を戻す', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t, { messages: [] }), events = [];
  const fetchImpl = f.options.fetchImpl;
  const exit = await main(['once', '--dry-run'], { ...f.options, print: () => {},
    setPriorityImpl: (...args) => { events.push('priority'); assert.deepEqual(args, [0, os.constants.priority.PRIORITY_NORMAL]); },
    fetchImpl: (...args) => { events.push('request'); return fetchImpl(...args); },
  });
  assert.equal(exit, 0); assert.equal(events[0], 'priority'); assert.ok(events.includes('request'));
});

test('Windows: BelowNormalの子プロセスはmain実行前の読み込み中にNormalへ戻る', { skip: process.platform !== 'win32' }, () => {
  const url = new URL('./discord-autoreply.mjs', import.meta.url).href;
  const script = `import os from 'node:os';
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    await import(${JSON.stringify(url)});
    console.log(os.getPriority());`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(Number(output.trim()), os.constants.priority.PRIORITY_NORMAL);
});
