import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCollect, runCli, parseArgs, estimateCost, canonicalUrl, weeklySummary, validateConfig } from './x-ai-tips-collect.mjs';
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
  assert.match((await runCollect(ctx.options)).status, /error:夜間API回数上限/);
  ctx.options.now = new Date(+now + 86400000); ctx.options.fetchFn = async () => response([]);
  assert.equal((await runCollect(ctx.options)).calls, 1);
});
test('費用予約で次のAPI呼び出しを止める', async t => {
  const ctx = setup(t); ctx.options.config.maxCostUsd = .3; ctx.options.config.topics = [defaults.topics[0], defaults.topics[0]];
  ctx.options.fetchFn = async () => response([], { cost_in_usd_ticks: 1000000000 });
  const result = await runCollect(ctx.options);
  assert.match(result.status, /error:夜間費用上限/); assert.equal(result.calls, 1);
});
test('実費が上限超過したら提案保存せず打ち切り、費用は保存', async t => {
  const ctx = setup(t, { fetchFn: async () => response([item], { cost_in_usd_ticks: 30000000000 }) });
  const result = await runCollect(ctx.options); assert.match(result.status, /error:夜間費用上限超過/); assert.equal(result.added, 0);
  assert.equal(JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/state.json'))).night.costUsd, 3);
});
for (const status of [401, 429]) test(`HTTP ${status} 即時打ち切り・予約維持・再試行なし`, async t => {
  const ctx = setup(t); ctx.options.config.topics = defaults.topics;
  ctx.options.fetchFn = async () => ({ ok: false, status });
  const result = await runCollect(ctx.options); assert.equal(result.calls, 1); assert.equal(result.status, `error:API HTTP ${status}`);
  assert.equal(JSON.parse(fs.readFileSync(ctx.file('x-ai-tips/runs.jsonl'))).reserved, true);
});
test('usage不足・JSON破損・タイムアウトが成功扱いにならない', async t => {
  for (const fetchFn of [async () => response([], {}), async () => ({ ok: true, json: async () => ({ output_text: 'invalid', usage: { cost_in_usd_ticks: 1 } }) }), async () => { throw new Error('timeout'); }]) {
    const ctx = setup(t, { fetchFn }); assert.match((await runCollect(ctx.options)).status, /^error:/);
  }
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
  assert.equal(result.calls, 1); assert.match(result.status, /error:夜間費用上限/);
  assert.equal(readState(ctx).night.costUsd, defaults.reservePerCallUsd);
  assert.equal(readState(ctx).nextTopicIndex, 1);
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
