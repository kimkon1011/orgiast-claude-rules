import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runOnce, main, createDiscord, createLlm, contentFor, parseJson } from './discord-autoreply.mjs';

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
    llm: async input => { llmCalls.push(input); return JSON.stringify(llmResult); },
    fetchImpl: async (url, init) => {
      const u = new URL(url); calls.push({ path: u.pathname, query: u.searchParams, ...init, body: init.body && JSON.parse(init.body) });
      assert.equal(init.headers['User-Agent'], 'DiscordBot (orgiast-autoreply, 1.0)');
      assert.equal(init.headers.Authorization, 'Bot test-token');
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

test('baselineより古い投稿、24h超、bot、kim、自分、除外chを除外', async t => {
  const f = fixture(t, { messages: [
    message({ id: '1', timestamp: new Date(NOW - 3000).toISOString() }),
    message({ id: '2', timestamp: new Date(NOW - 25 * 3600000).toISOString() }),
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
  assert.ok(body.content.startsWith('【Claude自動返信】\n'));
  assert.deepEqual(body.message_reference, { message_id: '100' });
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: true });
  assert.equal(f.readState().replies[0].replyId, '200');
  assert.equal(f.readState().hourly.length, 1); assert.ok(fs.existsSync(f.file('run.log')));
  assert.equal(f.llmCalls[0].category, 'jp_reply');
  await runOnce(f.options); assert.equal(f.posts().length, 1);
});
test('判断待ちはnotifyKimに1回', async t => {
  const f = fixture(t, { llmResult: { ...decision, needs_kim_decision: true } });
  await runOnce(f.options); await runOnce(f.options);
  assert.equal(f.notifications.length, 1); assert.match(f.notifications[0], /判断待ち: #相談/);
  assert.match(f.notifications[0], /https:\/\/discord.com\/channels\//);
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
  assert.match(f.patches()[0].body.content, /^【Claude自動返信・kimが訂正済み/);
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
  assert.equal(result.wouldSend.length, 1); assert.match(result.wouldSend[0].content, /^【Claude自動返信】/);
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
test('メンション検索はauthor_type=userでbotを除外しoffsetでページングする', async t => {
  const f = fixture(t, { messages: [] });
  await runOnce(f.options);
  const searches = f.calls.filter(c => c.path.endsWith('/messages/search'));
  assert.ok(searches.length >= 1);
  for (const call of searches) {
    assert.equal(call.query.get('author_type'), 'user');
    assert.equal(call.query.get('mentions'), KIM);
    assert.equal(call.query.get('limit'), '25');
  }
  assert.deepEqual(searches.map(c => c.query.get('offset')), ['0']);
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
