import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCollect, runCli, parseArgs, estimateCost, canonicalUrl, weeklySummary, validateConfig, validateState, classifyApiError, callOpenRouterGrok } from './x-ai-tips-collect.mjs';
const defaults = JSON.parse(fs.readFileSync(new URL('../config/x-ai-tips-topics.json', import.meta.url)));
const now = new Date('2026-11-03T12:00:00Z');
const item = { url: 'https://x.com/test/status/123?s=20', author: '@test', title: 'キャッシュを使う', summary: '固定部分を共通化', steps: '共通の指示を先頭に置き、usageを比較する', purpose: 'cost', category: 'cost', postedAt: '2026-11-03T10:00:00Z', likes: 20 };
const response = (items = [item], usage = { cost_in_usd_ticks: 100000000 }) => ({ ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }], usage }) });
function setup(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x-ai-tips-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const options = { home, key: 'fake-key', now, log: () => {}, config: { ...defaults, topics: defaults.topics.slice(0, 1) }, fetchFn: async () => response(), ...extra };
  return { options, base, file: name => path.join(base, name), records: () => fs.readFileSync(path.join(base, 'ai-news-proposals.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
test('正しいResponses APIで取得し、triage互換スキーマとusageを追記', async t => {
  const ctx = setup(t); let request;
  ctx.options.fetchFn = async (url, init) => { assert.equal(url, 'https://api.x.ai/v1/responses'); request = JSON.parse(init.body); return response(); };
  const result = await runCollect(ctx.options);
  assert.equal(result.status, 'ok:取得1件 追加1件 重複0件 費用$0.01');
  assert.equal(request.model, 'grok-4.6'); assert.equal(request.tools[0].type, 'x_search');
  assert.equal(request.tools[0].from_date, '2026-11-01'); assert.match(request.input[0].content, /宣伝だけ/);
  const [record] = ctx.records();
  assert.equal(record.id, 'X-0001'); assert.equal(record.status, 'pending'); assert.equal(record.category, 'cost');
  assert.equal(record.purpose, 'cost'); assert.equal(record.source, 'x'); assert.match(record.evidence, /https:\/\/x.com\//);
  assert.equal(record.action, item.steps); assert.equal(record.author, '@test');
  const run = JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/runs.jsonl')));
  assert.equal(run.costUsd, .01); assert.equal(run.estimated, false);
});
test('URL正規化・内容ハッシュ・処理済みタイトル・連番・再実行', async t => {
  const ctx = setup(t);
  fs.mkdirSync(ctx.base);
  fs.writeFileSync(ctx.file('ai-news-proposals.jsonl'), JSON.stringify({ id: 'X-0042', title: '既存タイトル', status: 'done' }));
  ctx.options.fetchFn = async () => response([item, { ...item, url: 'https://twitter.com/other/status/123', title: '別名' }, { ...item, url: 'https://x.com/a/status/124', title: '内容同じ' }, { ...item, url: 'https://x.com/a/status/125', title: '既存タイトル', steps: '異なる内容' }]);
  const first = await runCollect(ctx.options); assert.equal(first.added, 1); assert.equal(first.duplicates, 3);
  assert.equal(ctx.records()[1].id, 'X-0043');
  const second = await runCollect(ctx.options); assert.equal(second.added, 0); assert.equal(second.duplicates, 4);
  const state = JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/state.json')));
  assert.equal(state.urls.length, 3); assert.equal(state.night.calls, 2);
});
test('不足・古い投稿・未来・反応数不足・他ドメインを除外', async t => {
  const ctx = setup(t, { fetchFn: async () => response([
    { ...item, author: '' }, { ...item, postedAt: '2026-10-30' }, { ...item, postedAt: '2026-11-04' }, { ...item, likes: 9 }, { ...item, url: 'https://example.com/a/status/1' }, { ...item, purpose: 'site' }, null,
  ]) });
  assert.equal((await runCollect(ctx.options)).added, 0);
});
test('dry-run は提案候補を表示し、ディレクトリ・state・log・通知を書かない', async t => {
  const logs = []; const ctx = setup(t, { dryRun: true, log: x => logs.push(x), notifyFn: () => assert.fail('送信禁止') });
  assert.equal((await runCollect(ctx.options)).added, 1);
  assert.match(logs[0], /X-0001/); assert.equal(fs.existsSync(ctx.base), false);
});
test('キー未設定・停止設定はAPIも書き込みもしない、CLI最終行', async t => {
  const logs = []; const ctx = setup(t, { key: '', fetchFn: () => assert.fail('API禁止'), log: x => logs.push(x) });
  assert.equal(await runCli([], ctx.options), 0); assert.equal(logs.at(-1), 'skip:キー未設定'); assert.equal(fs.existsSync(ctx.base), false);
  ctx.options.config.enabled = false;
  assert.equal((await runCollect(ctx.options)).status, 'skip:設定で停止中');
});
test('API回数上限は同日再実行でも維持、翌日リセット', async t => {
  const ctx = setup(t); ctx.options.config.maxCalls = 1;
  await runCollect(ctx.options);
  ctx.options.fetchFn = () => assert.fail('上限後API禁止');
  assert.match((await runCollect(ctx.options)).status, /^ok:.*打ち切り:夜間API回数上限/);
  ctx.options.now = new Date(+now + 86400000); ctx.options.fetchFn = async () => response([]);
  assert.equal((await runCollect(ctx.options)).calls, 1);
});
test('費用予約で次のAPI呼び出しを止める', async t => {
  const ctx = setup(t); ctx.options.config.maxCostUsd = .3; ctx.options.config.reservePerCallUsd = .25; ctx.options.config.topics = [defaults.topics[0], defaults.topics[0]];
  ctx.options.fetchFn = async () => response([], { cost_in_usd_ticks: 1000000000 });
  const result = await runCollect(ctx.options);
  assert.match(result.status, /^ok:.*打ち切り:夜間費用上限/); assert.equal(result.calls, 1);
});
test('実費が上限超過したら提案保存せず打ち切り、費用は保存', async t => {
  const ctx = setup(t, { fetchFn: async () => response([item], { cost_in_usd_ticks: 30000000000 }) });
  const result = await runCollect(ctx.options); assert.match(result.status, /error:夜間費用上限超過/); assert.equal(result.added, 0);
  assert.equal(JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/state.json'))).night.costUsd, 3);
});
for (const status of [401, 429]) test(`HTTP ${status} 即時打ち切り・予約維持・再試行なし`, async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics;
  ctx.options.fetchFn = async () => ({ ok: false, status });
  const result = await runCollect(ctx.options);
  assert.equal(result.calls, 1); assert.equal(result.status, `error:API HTTP ${status}`);
  const run = JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/runs.jsonl'), 'utf8').trim().split('\n')[0]); assert.equal(run.reserved, true);
});
test('x.ai 403 は OpenRouter grok へフォールバックして成功する', async t => {
  const errors = []; const calls = [];
  const ctx = setup(t, { openRouterKey: 'or-test', errorLog: line => errors.push(line), fetchFn: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url === 'https://api.x.ai/v1/responses') return { ok: false, status: 403, text: async () => 'insufficient credits' };
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [item] }) } }], usage: { cost: .02 } }));
  } });
  const result = await runCollect(ctx.options);
  assert.match(result.status, /^ok:/); assert.equal(result.added, 1);
  assert.equal(calls[1].body.model, 'x-ai/grok-4.6');
  // OpenRouter は迂回経路なので緩い条件（isFallback=true）、x.ai は本経路なので厳格な条件（isFallback=false）
  assert.match(calls[0].body.input[0].content, /likes が 10 未満または確認不能/);
  assert.match(calls[1].body.messages[1].content, /likes が確認できない場合は likes を省略してよい/);
  assert.deepEqual(errors, ['[LANE-FALLBACK] x.ai -> openrouter grok (reason: HTTP 403 credit/quota response)']);
});

test('x.ai 401 は OpenRouter へフォールバックせず失敗する', async t => {
  let calls = 0; const errors = [];
  const ctx = setup(t, { openRouterKey: 'or-test', errorLog: line => errors.push(line), fetchFn: async () => {
    calls++; return { ok: false, status: 401, text: async () => 'invalid api key' };
  } });
  assert.equal(await runCli([], ctx.options), 1);
  assert.equal(calls, 1); assert.deepEqual(errors, []);
});

test('OpenRouterも失敗した残高切れはweb-searchへ進み、予約を維持してskip statusを出す', async t => {
  const logs = []; let calls = 0;
  const ctx = setup(t, { openRouterKey: 'or-unavailable', log: line => logs.push(line), errorLog: () => {}, fetchFn: async url => {
    if (url.includes('x.ai')) calls++;
    return { ok: false, status: 403, text: async () => JSON.stringify({ code: 'permission-denied', error: 'credits exhausted' }) };
  } });
  ctx.options.config.topics = defaults.topics;
  assert.equal(await runCli([], ctx.options), 0);
  assert.equal(calls, 1);
  assert.deepEqual(logs.slice(0, 3), ['x-ai-tips-collect: fallback → web-search grounding', 'x-ai-tips-collect: fallback も失敗', creditBlockedMessage]);
  assert.equal(logs[3], 'skip:支払い待ち（x.ai 残高切れ・2026-11-03から）');
  assert.equal(readState(ctx).creditBlockedAt, now.toISOString());
  assert.equal(readState(ctx).night.calls, 1);
  assert.equal(readState(ctx).night.costUsd, defaults.reservePerCallUsd);
  const [run] = readRuns(ctx);
  assert.equal(run.status, 'skip:支払い待ち');
  assert.equal(run.reserved, true);
  assert.equal(run.costUsd, defaults.reservePerCallUsd);
  assert.equal(fs.existsSync(ctx.file('x-ai-tips/collect.lock')), false);
});

const creditBlockedMessage = 'x.ai チームの残高切れ・月次上限のためスキップしました（支払いの承認待ち）。鍵は正常です。';
for (const [label, status, body, expected] of [
  ['JSONの残高切れ', 403, '{"code":"permission-denied","error":"...credits..."}', 'credit-blocked'],
  ['非JSONの月次上限', 403, 'Your team has reached its monthly spending limit.', 'credit-blocked'],
  ['code単独', 403, '{"code":"permission-denied"}', 'credit-blocked'],
  ['403は本文によらず対象', 403, '{"code":"invalid-api-key"}', 'credit-blocked'],
  ['サーバーエラー', 500, 'oops', 'fatal'],
  ['空本文の403', 403, '', 'credit-blocked'],
  ['本文の残高文言', 500, '{"code":"permission-denied","error":"credits"}', 'credit-blocked'],
  ['JSONのnullでも403', 403, 'null', 'credit-blocked'],
  ['壊れたJSONの大文字CREDITS', 403, '{broken CREDITS', 'credit-blocked'],
]) test(`classifyApiError: ${label}`, () => {
  assert.equal(classifyApiError(status, body), expected);
});

test('validateStateはcreditBlockedAtの文字列・undefinedを受理し数値を拒否', () => {
  for (const state of [{}, { creditBlockedAt: undefined }, { creditBlockedAt: now.toISOString() }]) {
    assert.equal(validateState(state), state);
  }
  assert.throws(() => validateState({ creditBlockedAt: 123 }), /state形式不正: creditBlockedAt/);
});

test('同日JSTの再実行はfallback失敗を捕捉し予算・通知・実行記録を更新しない', async t => {
  const logs = [];
  const ctx = setup(t, { now: new Date('2026-11-02T00:00:00Z'), log: line => logs.push(line),
    fetchFn: () => assert.fail('API禁止'), notifyFn: () => assert.fail('通知禁止') });
  fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
  const saved = JSON.stringify({ creditBlockedAt: '2026-11-01T15:00:00Z', night: { date: '2026-11-02', calls: defaults.maxCalls, costUsd: defaults.maxCostUsd } });
  fs.writeFileSync(ctx.file('x-ai-tips/state.json'), saved);
  assert.equal(await runCli([], ctx.options), 0);
  assert.deepEqual(logs.slice(0, 3), ['x-ai-tips-collect: fallback → web-search grounding', 'x-ai-tips-collect: fallback も失敗', creditBlockedMessage]);
  assert.equal(logs[3], 'skip:支払い待ち（x.ai 残高切れ・2026-11-02から）');
  const state = readState(ctx);
  assert.equal(state.night.calls, defaults.maxCalls);
  assert.equal(state.night.costUsd, defaults.maxCostUsd);
  assert.equal(state.nextTopicIndex, 0);
  assert.equal(fs.existsSync(ctx.file('x-ai-tips/runs.jsonl')), false);
  assert.equal(fs.existsSync(ctx.file('x-ai-tips/collect.lock')), false);
});

test('JSTの翌日には収集を再開し、不正な日時文字列でも永続停止しない', async t => {
  for (const creditBlockedAt of ['2026-11-03T14:59:59Z', 'invalid-date']) {
    let calls = 0;
    const ctx = setup(t, { now: new Date('2026-11-03T15:00:00Z'), fetchFn: async () => { calls++; return response([]); } });
    fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
    fs.writeFileSync(ctx.file('x-ai-tips/state.json'), JSON.stringify({ creditBlockedAt, night: { date: '2026-11-03', calls: defaults.maxCalls, costUsd: defaults.maxCostUsd } }));
    assert.match((await runCollect(ctx.options)).status, /^ok:/);
    assert.equal(calls, 1);
    assert.equal(readState(ctx).night.calls, 1);
  }
});

test('通常の403はOpenRouterへフォールバックし、秘密値を記録しない', async t => {
  const logs = [], errors = [], calls = [];
  const ctx = setup(t, { openRouterKey: 'or-test-secret', log: line => logs.push(line), errorLog: line => errors.push(line), fetchFn: async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    if (url.includes('api.x.ai')) return { ok: false, status: 403, text: async () => JSON.stringify({ code: 'invalid-api-key', error: 'fake-key', Authorization: 'Bearer fake-key', private: 'private-marker' }) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [item] }) } }], usage: { cost: .02 } }));
  } });
  assert.equal(await runCli([], ctx.options), 0);

  assert.deepEqual(calls.map(call => call.url), ['https://api.x.ai/v1/responses', 'https://openrouter.ai/api/v1/chat/completions']);
  const persisted = JSON.stringify({ logs, errors, runs: readRuns(ctx) });
  assert.doesNotMatch(persisted, /fake-key|or-test-secret|Authorization|private-marker/);
});

test('長い残高切れ応答もOpenRouterへフォールバックし、本文と認証情報を記録しない', async t => {
  const logs = [], errors = [];
  const ctx = setup(t, { openRouterKey: 'or-long-secret', log: line => logs.push(line), errorLog: line => errors.push(line), fetchFn: async url => {
    if (url.includes('api.x.ai')) return { ok: false, status: 403, text: async () => JSON.stringify({ private: 'private-marker'.repeat(200), code: 'permission-denied', error: 'fake-key', Authorization: 'Bearer fake-key' }) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }], usage: { cost: .02 } }));
  } });
  assert.equal(await runCli([], ctx.options), 0);
  assert.doesNotMatch(JSON.stringify({ logs, errors, runs: readRuns(ctx) }), /fake-key|or-long-secret|Authorization|private-marker/);
});

test('残高切れdry-runもOpenRouterへフォールバックし、stateと実行記録を書かない', async t => {
  let calls = 0;
  const ctx = setup(t, { dryRun: true, openRouterKey: 'or-dry-run', fetchFn: async url => {
    calls++;
    if (url.includes('api.x.ai')) return { ok: false, status: 403, text: async () => 'credits exhausted' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [item] }) } }], usage: { cost: .02 } }));
  } });
  assert.match((await runCollect(ctx.options)).status, /^ok:/);
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(ctx.base), false);
});

test('後続の残高切れはOpenRouterへ切り替え、先行成果と費用を保持する', async t => {
  let xaiCalls = 0;
  const second = { ...item, url: 'https://x.com/test/status/124', title: '二件目', summary: '別の成果', steps: '別の手順' };
  const ctx = setup(t, { openRouterKey: 'or-second', fetchFn: async url => {
    if (url.includes('api.x.ai')) return ++xaiCalls === 1 ? response() : { ok: false, status: 403, text: async () => 'spending limit' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [second] }) } }], usage: { cost: .02 } }));
  } });
  ctx.options.config.topics = [defaults.topics[0], defaults.topics[0]];
  const result = await runCollect(ctx.options);

  assert.match(result.status, /^ok:/);
  assert.equal(result.added, 2);
  assert.equal(ctx.records().length, 2);
  assert.equal(readState(ctx).night.costUsd, .03);
  assert.deepEqual(readRuns(ctx).map(run => [run.status, run.costUsd]), [['ok', .01], ['ok', .02]]);
});

test('エラーcodeに混入した鍵は実行記録でも伏せる', async t => {
  const logs = [];
  const ctx = setup(t, { log: line => logs.push(line), fetchFn: async () => ({ ok: false, status: 401, text: async () => '{"code":"invalid-fake-key"}' }) });
  assert.equal(await runCli([], ctx.options), 1);
  assert.doesNotMatch(JSON.stringify({ logs, runs: readRuns(ctx) }), /fake-key/);
});
test('HTTP 401 は応答本文の code だけをエラー文に付加', async t => {
  const ctx = setup(t, { fetchFn: async () => ({ ok: false, status: 401, text: async () => '{"code":"unauthenticated"}' }) });
  assert.equal((await runCollect(ctx.options)).status, 'error:API HTTP 401 (unauthenticated)');
});
test('usage不足・タイムアウトが成功扱いにならない', async t => {
  for (const fetchFn of [async () => response([], {}), async () => { throw new Error('timeout'); }]) {
    const ctx = setup(t, { fetchFn }); assert.match((await runCollect(ctx.options)).status, /^error:/);
  }
});

test('JSON破損は例外で落ちず解析不能としてスキップ', async t => {
  const errors = [];
  const ctx = setup(t, { errorLog: line => errors.push(line), fetchFn: async () => ({ ok: true, json: async () => ({ output_text: 'invalid', usage: { cost_in_usd_ticks: 1 } }) }) });
  const result = await runCollect(ctx.options);
  assert.equal(result.added, 0);
  assert.match(result.status, /^skip:fallback応答がJSONでない/);
  assert.ok(errors.some(e => e.startsWith('[x-ai-tips] parse-failed')));
});
test('費用は請求ticks優先、fallbackはトークンと検索項目数を含む', () => {
  assert.equal(estimateCost({ cost_in_usd_ticks: 1e10 }, defaults.estimatedRates), 1);
  assert.equal(estimateCost({ input_tokens: 1e6, output_tokens: 1e6, server_side_tool_usage_details: { x_posts_fetched: 100, x_users_fetched: 10 } }, defaults.estimatedRates), 18.6);
  assert.throws(() => estimateCost({}, defaults.estimatedRates), /usage不足/);
});
test('月曜JSTだけ週1通、目的別集計と採用上位、配送予約の永続化', async t => {
  const monday = new Date('2026-11-01T16:00:00Z'); let sent = 0;
  const ctx = setup(t, { now: monday, fetchFn: async () => response([]), notifyFn: async (body, opts) => { sent++; assert.equal(opts.kind, 'info'); assert.equal(opts.plainJa, false); assert.match(body, /cost: 採用1 \/ 却下1 \/ 未処理1/); return { delivered: 'session-inbox' }; } });
  fs.mkdirSync(ctx.base);
  const rows = ['done', 'rejected', 'pending'].map((status, i) => ({ id: `X-000${i + 1}`, source: 'x', purpose: 'cost', title: '例', action: '手順', evidence: item.url, status, adopt: status === 'done', createdAt: '2026-10-31T00:00:00Z' }));
  rows.push({ ...rows[0], source: 'line' }, { ...rows[0], createdAt: '2026-10-01' });
  fs.writeFileSync(ctx.file('ai-news-proposals.jsonl'), rows.map(JSON.stringify).join('\n'));
  await runCollect(ctx.options); await runCollect(ctx.options); assert.equal(sent, 1);
  const state = JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/state.json'))); assert.equal(state.weekly.status, 'sent'); assert.ok(state.weekly.sentAt);
  assert.equal((weeklySummary(Array.from({ length: 8 }, (_, i) => ({ ...rows[0], title: `採用${i}` })), monday).match(/\[cost\]/g) || []).length, 5);
});
test('週次配送失敗・送信中記録でも同じ週は重複配送しない', async t => {
  let sent = 0;
  const ctx = setup(t, { now: new Date('2026-11-02T12:00:00Z'), notifyFn: async () => { sent++; throw new Error('配送不明'); } });
  assert.match((await runCollect(ctx.options)).status, /^error:/);
  await runCollect(ctx.options); assert.equal(sent, 1);
});
test('ロック・破損stateはフェイルクローズ', async t => {
  const ctx = setup(t, { fetchFn: () => assert.fail('API禁止') });
  fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true }); fs.writeFileSync(ctx.file('x-ai-tips/collect.lock'), '');
  assert.match((await runCollect(ctx.options)).status, /ロック/);
  fs.unlinkSync(ctx.file('x-ai-tips/collect.lock')); fs.writeFileSync(ctx.file('x-ai-tips/state.json'), 'bad');
  assert.match((await runCollect(ctx.options)).status, /^error:/); assert.equal(fs.existsSync(ctx.file('x-ai-tips/collect.lock')), false);
});
test('引数・URLと夜間順序・ヘルス設定', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--limit', '1']), { dryRun: true, limit: 1 });
  for (const args of [['--limit'], ['--limit', '-1'], ['--limit', '1.5'], ['--unknown']]) assert.throws(() => parseArgs(args));
  assert.equal(canonicalUrl('https://twitter.com/a/status/123?s=1'), canonicalUrl(item.url));
  const batch = fs.readFileSync(new URL('./nightly-batch.ps1', import.meta.url), 'utf8');
  assert.ok(batch.indexOf("'tools\\x-ai-tips-collect.mjs'") < batch.indexOf("'tools\\ai-news-triage.mjs'"));
  assert.match(batch, /Write-NightlyLog 'x-ai-tips-collect'/);
  const health = JSON.parse(fs.readFileSync(new URL('./nightly-health-expectations.json', import.meta.url)));
  assert.equal(health.find(r => r.log === 'x-ai-tips-collect.log').maxAgeHours, 26);
});
test('欠けた予算stateで上限を迂回できない', async t => {
  const ctx = setup(t, { fetchFn: () => assert.fail('API禁止') });
  fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
  fs.writeFileSync(ctx.file('x-ai-tips/state.json'), JSON.stringify({ night: { date: '2026-11-03', calls: 0 } }));
  assert.match((await runCollect(ctx.options)).status, /error:state形式不正/);
});
test('--limit は呼び出し数を制限し、最終行は必ずサマリー', async t => {
  const logs = []; const ctx = setup(t, { log: x => logs.push(x), dryRun: true });
  ctx.options.config.topics = defaults.topics;
  let calls = 0; ctx.options.fetchFn = async () => { calls++; return response(); };
  assert.equal(await runCli(['--dry-run', '--limit', '1'], ctx.options), 0);
  assert.equal(calls, 1); assert.match(logs.at(-1), /^ok:取得1件 追加1件 重複0件 費用\$0.01$/);
});

const readState = ctx => JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/state.json')));
const readRuns = ctx => fs.readFileSync(ctx.file('x-ai-tips/runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const requestQuery = init => JSON.parse(init.body).input[0].content.split('\n')[0].replace('Search X for: ', '');

for (const name of ['TimeoutError', 'AbortError']) test(`${name} 後も次テーマへ進み失敗ログと予約費用を残す`, async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics.slice(0, 2);
  let calls = 0;
  ctx.options.fetchFn = async () => {
    if (++calls === 1) throw new DOMException('The operation was aborted', name);
    return response([]);
  };
  const result = await runCollect(ctx.options);
  assert.equal(calls, 2); assert.equal(result.calls, 2); assert.match(result.status, /^error:テーマ失敗1件/);
  const runs = readRuns(ctx);
  assert.match(runs[0].status, /^error:The operation was aborted/); assert.equal(runs[0].reserved, true);
  assert.equal(runs[0].costUsd, defaults.reservePerCallUsd); assert.equal(runs[1].status, 'ok');
  assert.equal(readState(ctx).night.costUsd, defaults.reservePerCallUsd + .01);
  assert.equal(result.cost, defaults.reservePerCallUsd + .01);
});
for (const status of [500, 503, 599]) test(`HTTP ${status} 後も次テーマへ進み予約を維持`, async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics.slice(0, 2);
  let calls = 0;
  ctx.options.fetchFn = async () => ++calls === 1 ? { ok: false, status } : response([]);
  const result = await runCollect(ctx.options);
  assert.equal(calls, 2); assert.match(result.status, /^error:テーマ失敗1件/);
  const runs = readRuns(ctx);
  assert.equal(runs[0].status, `error:API HTTP ${status}`); assert.equal(runs[0].reserved, true);
  assert.equal(runs[1].status, 'ok'); assert.equal(readState(ctx).night.costUsd, defaults.reservePerCallUsd + .01);
});
test('timeoutMs は未指定時300000、設定値をsignalに渡し、不正値は拒否', async t => {
  const config = { ...defaults }; delete config.timeoutMs;
  assert.equal(validateConfig(config).timeoutMs, 300000);
  for (const timeoutMs of [0, -1, 1.5, null, '300000', 2147483648]) assert.throws(() => validateConfig({ ...config, timeoutMs }), /timeoutMs/);
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', ms => { durations.push(ms); return new AbortController().signal; });
  const ctx = setup(t); ctx.options.config.timeoutMs = 12345;
  await runCollect(ctx.options);
  delete ctx.options.config.timeoutMs;
  await runCollect(ctx.options);
  assert.deepEqual(durations, [12345, 300000]);
});
test('全テーマを回った翌夜も開始テーマが1つずれる', async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics;
  const queries = [];
  ctx.options.fetchFn = async (_url, init) => { queries.push(requestQuery(init)); return response([]); };
  await runCollect(ctx.options);
  assert.equal(readState(ctx).nextTopicIndex, 1);
  ctx.options.now = new Date(+now + 86400000);
  await runCollect(ctx.options);
  const expected = defaults.topics.map(t => t.query);
  assert.deepEqual(queries, [...expected, ...expected.slice(1), expected[0]]);
  assert.equal(readState(ctx).nextTopicIndex, 2);
});
test('回数上限で未実行のテーマから翌夜再開し、2晩で全テーマを回る', async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics; ctx.options.config.maxCalls = 3;
  const queries = [];
  ctx.options.fetchFn = async (_url, init) => { queries.push(requestQuery(init)); return response([]); };
  await runCollect(ctx.options);
  assert.equal(readState(ctx).nextTopicIndex, 3);
  ctx.options.now = new Date(+now + 86400000);
  await runCollect(ctx.options);
  assert.deepEqual(queries, defaults.topics.map(t => t.query));
  assert.equal(readState(ctx).nextTopicIndex, 0);
});
test('429 で打ち切った翌夜は次の未実行テーマから再開', async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics;
  ctx.options.fetchFn = async () => ({ ok: false, status: 429 });
  assert.equal((await runCollect(ctx.options)).calls, 1);
  assert.equal(readState(ctx).nextTopicIndex, 1);
  ctx.options.now = new Date(+now + 86400000); ctx.options.limit = 1;
  ctx.options.fetchFn = async (_url, init) => { assert.equal(requestQuery(init), defaults.topics[1].query); return response([]); };
  assert.equal((await runCollect(ctx.options)).calls, 1);
});
test('失敗時の予約費用でも上限を守り未実行テーマの位置を維持', async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics; ctx.options.config.maxCostUsd = defaults.reservePerCallUsd;
  ctx.options.fetchFn = async () => ({ ok: false, status: 503 });
  const result = await runCollect(ctx.options);
  assert.equal(result.calls, 1); assert.match(result.status, /^ok:.*打ち切り:夜間費用上限/);
  assert.equal(readState(ctx).night.costUsd, defaults.reservePerCallUsd);
  assert.equal(readState(ctx).nextTopicIndex, 1);
});
// ----- fallback web-search 系テスト -----

test('当日credit-blocked済みなら現在トピック1件をfallback収集し提案を追加', async t => {
  const ctx = setup(t);
  ctx.options.config.topics = defaults.topics.slice(0, 2);
  fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
  fs.writeFileSync(ctx.file('x-ai-tips/state.json'), JSON.stringify({ creditBlockedAt: now.toISOString(), nextTopicIndex: 1 }));
  let searchCalled = 0;
  ctx.options.searchImpl = async query => {
    searchCalled++;
    assert.equal(query, defaults.topics[1].query);
    return { answer: 'AI活用例 https://example.com/tip', urls: ['https://example.com/tip'], provider: 'gemini' };
  };
  ctx.options.fetchFn = async url => {
    assert.notEqual(url, 'https://api.x.ai/v1/responses');
    return { ok: true, status: 200 };
  };
  const result = await runCollect(ctx.options);
  assert.equal(searchCalled, 1);
  assert.equal(result.status, 'skip:支払い待ち（x.ai 残高切れ・2026-11-03から）(fallback)');
  assert.ok(ctx.records().length >= 1);
  assert.equal(ctx.records()[0].source, 'fallback:gemini');
  assert.equal(readState(ctx).nextTopicIndex, 0);
  assert.equal(result.calls, 0);
  assert.equal(result.cost, 0);
  assert.equal(readState(ctx).night, undefined);
});

test('当日credit-blocked済みのfallbackではx.ai fetchを一度も呼ばない', async t => {
  const ctx = setup(t);
  fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
  fs.writeFileSync(ctx.file('x-ai-tips/state.json'), JSON.stringify({ creditBlockedAt: now.toISOString() }));
  let fetchCalls = 0;
  ctx.options.fetchFn = async () => { fetchCalls++; return { ok: true, status: 200 }; };
  ctx.options.searchImpl = async () => ({ answer: 'URLなし', urls: [], provider: 'gemini' });
  const result = await runCollect(ctx.options);
  assert.equal(fetchCalls, 0);
  assert.equal(result.status, 'skip:支払い待ち（x.ai 残高切れ・2026-11-03から）');
});

test('当日credit-blocked済みでもfallback nullなら検索せず従来status', async t => {
  const ctx = setup(t);
  ctx.options.config.fallback = null;
  fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
  fs.writeFileSync(ctx.file('x-ai-tips/state.json'), JSON.stringify({ creditBlockedAt: now.toISOString() }));
  ctx.options.fetchFn = () => assert.fail('x.ai API禁止');
  ctx.options.searchImpl = () => assert.fail('検索禁止');
  assert.equal((await runCollect(ctx.options)).status, 'skip:支払い待ち（x.ai 残高切れ・2026-11-03から）');
});

test('verifyUrls: HEAD 2xx/3xx を通し、404 を除外、403 は GET 再確認', async t => {
  const heads = [];
  const fetchFn = async (url, init) => {
    heads.push({ url, method: init?.method || 'GET' });
    if (url.includes('/valid')) return { ok: true, status: 200 };
    if (url.includes('/redirect')) return { ok: false, status: 301 };
    if (url.includes('/not-found')) return { ok: false, status: 404 };
    // HEAD 403 → GET で 200 を返す
    if (url.includes('/forbidden')) {
      const method = init?.method || 'GET';
      if (method === 'HEAD') return { ok: false, status: 403 };
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 403 };
  };
  const { verifyUrls } = await import('./x-ai-tips-collect.mjs');
  const result = await verifyUrls(['https://example.com/valid', 'https://example.com/not-found', 'https://example.com/redirect', 'https://example.com/forbidden'], { fetchFn });
  assert.deepEqual(result, ['https://example.com/valid', 'https://example.com/redirect', 'https://example.com/forbidden']);
  assert.equal(heads.filter(h => h.method === 'GET').length, 1); // /forbidden: HEAD 403 → GET 1回
  assert.equal(heads.filter(h => h.method === 'HEAD').length, 4); // 4 URL を HEAD
});

test('verifyUrls: 403 は GET で再確認、2xx なら通す', async t => {
  let tries = 0;
  const fetchFn = async (url, init) => {
    tries++;
    const method = init?.method || 'GET';
    if (method === 'HEAD') return { ok: false, status: 403 };
    return { ok: true, status: 200, url };
  };
  const { verifyUrls } = await import('./x-ai-tips-collect.mjs');
  const result = await verifyUrls(['https://example.com/test'], { fetchFn });
  assert.deepEqual(result, ['https://example.com/test']);
  assert.equal(tries, 2);
});

test('verifyUrls: タイムアウトはスキップ、残りは通す', async t => {
  const fetchFn = async (url) => {
    if (url.includes('/timeout')) throw new Error('timeout');
    return { ok: true, status: 200 };
  };
  const { verifyUrls } = await import('./x-ai-tips-collect.mjs');
  const result = await verifyUrls(['https://example.com/ok', 'https://example.com/timeout'], { fetchFn });
  assert.deepEqual(result, ['https://example.com/ok']);
});

test('verifyUrls: 最大10件まで', async t => {
  let count = 0;
  const fetchFn = async () => { count++; return { ok: true, status: 200 }; };
  const { verifyUrls } = await import('./x-ai-tips-collect.mjs');
  const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`);
  const result = await verifyUrls(urls, { fetchFn });
  assert.equal(result.length, 10);
  assert.equal(count, 10);
});

test('x.ai 403はOpenRouterを先に試し、その失敗後にweb-searchへ落ちる', async t => {
  const ctx = setup(t);
  ctx.options.config.topics = defaults.topics.slice(0, 1);
  ctx.options.openRouterKey = 'or-priority';
  const order = [];
  ctx.options.searchImpl = async () => {
    order.push('web-search');
    return { answer: '最新のAIコスト削減手法については https://example.com/cost-tips を参照', urls: [{ url: 'https://example.com/cost-tips', title: 'コスト削減' }], provider: 'gemini', model: 'gemini-3.6-flash', elapsedMs: 100, failures: [] };
  };
  ctx.options.fetchFn = async (url, init) => {
    if (url.includes('api.x.ai')) { order.push('x.ai'); return { ok: false, status: 403, text: async () => 'credits exhausted' }; }
    if (url.includes('openrouter.ai')) { order.push('openrouter'); return new Response('wallet empty', { status: 402 }); }
    // URL 実在確認用 — すべて 200
    return { ok: true, status: 200 };
  };
  const result = await runCollect(ctx.options);
  assert.deepEqual(order, ['x.ai', 'openrouter', 'web-search']);
  assert.ok(result.added >= 1);
  const records = ctx.records();
  const fallbackRecords = records.filter(r => r.source?.startsWith('fallback:'));
  assert.ok(fallbackRecords.length >= 1);
});

test('x.ai 403 → search は返るが全 URL が 404 → 項目0件・例外なし', async t => {
  const ctx = setup(t);
  ctx.options.config.topics = defaults.topics.slice(0, 1);
  const logs = [];
  ctx.options.searchImpl = async () => {
    return { answer: '調査結果', urls: [{ url: 'https://example.com/article' }], provider: 'gemini', model: 'gemini-3.6-flash', elapsedMs: 100, failures: [] };
  };
  ctx.options.fetchFn = async (url) => {
    if (url.includes('x.ai')) return { ok: false, status: 403 };
    // URL 実在確認: 全部 404
    return { ok: false, status: 404 };
  };
  const result = await runCollect({ ...ctx.options, log: x => logs.push(x) });
  assert.equal(result.added, 0);
  assert.equal(result.status, 'skip:支払い待ち（x.ai 残高切れ・2026-11-03から）');
});

test('x.ai 429 → fallback search を呼ばない', async t => {
  const ctx = setup(t);
  let searchCalled = false;
  let xaiCalled = false;
  ctx.options.fetchFn = async (url) => {
    if (url.includes('x.ai')) { xaiCalled = true; return { ok: false, status: 429 }; }
    searchCalled = true;
    return { ok: true, status: 200 };
  };
  await runCollect(ctx.options);
  assert.ok(xaiCalled);
  assert.ok(!searchCalled);
});

test('x.ai 500 → fallback search を呼ばない', async t => {
  const ctx = setup(t);
  let searchCalled = false;
  ctx.options.fetchFn = async (url) => {
    if (url.includes('x.ai')) return { ok: false, status: 500 };
    searchCalled = true;
    return { ok: true, status: 200 };
  };
  await runCollect(ctx.options);
  assert.ok(!searchCalled);
});

test('config fallback null → 403 でも search を呼ばない', async t => {
  const ctx = setup(t);
  ctx.options.config.fallback = null;
  let searchCalled = false;
  ctx.options.fetchFn = async (url) => {
    if (url.includes('x.ai')) return { ok: false, status: 403 };
    searchCalled = true;
    return { ok: true, status: 200 };
  };
  await runCollect(ctx.options);
  assert.ok(!searchCalled);
});

test('config fallback 不正値は validateConfig で拒否', () => {
  assert.throws(() => validateConfig({ ...defaults, fallback: 'invalid' }), /fallback/);
  const withNull = validateConfig({ ...defaults, fallback: null });
  assert.equal(withNull.fallback, null);
  const withWebSearch = validateConfig({ ...defaults, fallback: 'web-search' });
  assert.equal(withWebSearch.fallback, 'web-search');
});

test('nextTopicIndex が範囲外・欠落・不正型なら0から再開', async t => {
  for (const nextTopicIndex of [-1, defaults.topics.length, 999, 1.5, '2', null, undefined]) {
    const ctx = setup(t); ctx.options.config.topics = defaults.topics; ctx.options.limit = 1;
    fs.mkdirSync(ctx.file('x-ai-tips'), { recursive: true });
    fs.writeFileSync(ctx.file('x-ai-tips/state.json'), JSON.stringify({ nextTopicIndex }));
    ctx.options.fetchFn = async (_url, init) => { assert.equal(requestQuery(init), defaults.topics[0].query); return response([]); };
    assert.equal((await runCollect(ctx.options)).calls, 1);
    assert.equal(readState(ctx).nextTopicIndex, 1);
  }
});

test('OpenRouter fallback 応答が JSON でない場合も例外で落ちない', async t => {
  const errors = [];
  const ctx = setup(t, { openRouterKey: 'or-nonjson', errorLog: line => errors.push(line), fetchFn: async url => {
    if (url.includes('x.ai')) return { ok: false, status: 403, text: async () => 'insufficient credits' };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'X検索を実行し、指定された内容について情報を収集し、報告します。AI活用例は見つかりませんでした。' } }], usage: { cost: .02 } }));
  } });
  const result = await runCollect(ctx.options);
  assert.equal(result.added, 0);
  assert.match(result.status, /^skip:fallback応答がJSONでない/);
  assert.ok(errors.some(e => e.startsWith('[x-ai-tips] parse-failed')));
  assert.equal(await runCli([], ctx.options), 0);
});

test('OpenRouter fallback 応答が前置き文＋JSONを含む場合は抽出できる', async t => {
  const preambleItem = { ...item, title: '前置き付きJSON' };
  const ctx = setup(t, { openRouterKey: 'or-preamble', fetchFn: async url => {
    if (url.includes('x.ai')) return { ok: false, status: 403, text: async () => 'credits exhausted' };
    return new Response(JSON.stringify({ choices: [{ message: { content: `以下は検索結果です。\n${JSON.stringify({ items: [preambleItem] })}\n以上です。` } }], usage: { cost: .02 } }));
  } });
  const result = await runCollect(ctx.options);
  assert.equal(result.added, 1);
  assert.match(result.status, /^ok:取得1件/);
  assert.equal(ctx.records()[0].title, '前置き付きJSON');
});

test('callOpenRouterGrok の body に web 検索プラグインを含む', async t => {
  let sentBody;
  const fetchFn = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{items:[]}' } }], usage: {} }));
  };
  await callOpenRouterGrok('test prompt', { key: 'test-key', fetchFn });
  assert.ok(sentBody, 'body が送信された');
  assert.ok(Array.isArray(sentBody.plugins), 'plugins が配列');
  assert.equal(sentBody.plugins[0].id, 'web');
  assert.equal(sentBody.plugins[0].engine, 'native');
  assert.equal(sentBody.plugins[0].max_results, 5);
});