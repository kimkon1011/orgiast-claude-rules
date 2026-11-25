import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gradeRequired, parseMissed, detectionFor, summarize, verdictFor, renderMarkdown, parseArgs, buildPrompt, callProvider, runCli } from './model-relay.mjs';

// Any accidental real network access fails, including future additions to this module.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('ネットワーク禁止'); };
test.after(() => { globalThis.fetch = originalFetch; });
const required = [{ id: 'a', label: '税', any: ['税込', 'TAX'] }, { id: 'b', label: '期限', any: ['金曜'] }, { id: 'c', label: '宛名', any: ['田中'] }];
const task = { id: 't', title: '試験', system: '担当者', brief: '依頼本文', deliverable: '返信', max: 800, required };
const catalog = { assumptions: { note: '実測ではない', tasksPerMonth: 100 }, lanes: { a: 'genspark:claude-sonnet-5', b: 'genspark:gpt-5.6-luna' }, tasks: [task] };
const critique = JSON.stringify({ missed: [{ label: '金曜', why: '期限抜け' }, { label: '税込', why: '税抜け' }], verdict: 'insufficient' });
const stage = (text, costUsd = 1) => ({ status: 'ok', text, costUsd, ms: 10 });
const row = () => ({ taskId: 't', status: 'ok', stage1: stage('税込'), stage2: stage(critique), stage3: stage('税込 金曜 田中') });
const results = (tasks = [row()]) => ({ runs: [{ lanes: catalog.lanes, t: '2026-09-25', tasks }] });
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'model-relay-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'tools')); fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'tools', 'model-relay-catalog.json'), JSON.stringify(catalog));
  const output = { stdout: '', stderr: '' };
  return { repo, output, stdout: { write: (s) => { output.stdout += s; } }, stderr: { write: (s) => { output.stderr += s; } } };
}

test('gradeRequired: 手計算・大文字小文字・全半角', () => {
  assert.deepEqual(gradeRequired(required, 'tax 金曜'), { total: 3, hit: ['a', 'b'], missed: ['c'], recall: 2 / 3 });
  assert.equal(gradeRequired(required, 'ＴＡＸ').recall, 0);
  assert.equal(gradeRequired(required, '税込金曜田中').recall, 1);
});
test('parseMissed: フェンス、前後文章、文字列中の括弧、壊れたJSONと不正schema', () => {
  for (const text of [critique, `説明\n\`\`\`json\n${critique}\n\`\`\`\n終わり`, `前文${critique}後文`]) assert.equal(parseMissed(text).missed.length, 2);
  assert.equal(parseMissed('{"missed":[{"label":"}","why":"\\\"{"}],"verdict":"ok"}').invalid, false);
  for (const text of ['{oops', '{}', '{"missed":[null],"verdict":"ok"}', '{"missed":[],"verdict":"bad"}']) assert.deepEqual(parseMissed(text), { missed: [], invalid: true });
});
test('検出精度: TP/FP、重複、空分母、invalid', () => {
  const d = detectionFor(required, '税込', critique);
  assert.deepEqual(d.actuallyMissed, ['b', 'c']); assert.equal(d.truePositive, 1); assert.equal(d.falsePositive, 1);
  assert.equal(d.detectionRecall, 0.5); assert.equal(d.detectionPrecision, 0.5);
  assert.equal(detectionFor(required, '税込金曜田中', critique).detectionRecall, null);
  assert.equal(detectionFor(required, '', '{"missed":[],"verdict":"ok"}').detectionPrecision, null);
  assert.equal(detectionFor(required, '', 'broken').detectionRecall, null);
  assert.equal(detectionFor(required, '', JSON.stringify({ missed: [{ label: '金曜 金曜', why: '金曜' }], verdict: 'insufficient' })).truePositive, 1);
});
test('summarize: lift、費用倍率、時間、error除外、未知費用', () => {
  const a = summarize(results(), catalog);
  assert.equal(a.recall1Avg, 1 / 3); assert.equal(a.recall2Avg, 1); assert.equal(a.liftAvg, 1 - 1 / 3);
  assert.equal(a.costMultiplier, 3); assert.equal(a.tasks[0].msTotal, 30); assert.equal(a.detectionRecallAvg, 0.5);
  const failed = { ...row(), status: 'error', stage3: { status: 'error', costUsd: null } };
  const b = summarize(results([row(), failed]), catalog);
  assert.equal(b.errors, 1); assert.equal(b.n, 1); assert.equal(b.liftAvg, a.liftAvg);
  const unknown = row(); unknown.stage2.costUsd = null;
  assert.equal(summarize(results([unknown]), catalog).costMultiplier, null);
  const zero = row(); zero.stage1.costUsd = 0;
  assert.equal(summarize(results([zero]), catalog).costMultiplier, null);
  assert.equal(summarize(results([failed]), catalog).verdict, '未実測');
});
test('summarize: 反復数の異なるタスクでもタスク平均', () => {
  const c = { ...catalog, tasks: [task, { ...task, id: 'u' }] };
  const u = { ...row(), taskId: 'u', stage1: stage('税込金曜田中') };
  const a = summarize(results([row(), row(), u]), c);
  assert.equal(a.recall1Avg, (1 / 3 + 1) / 2);
  assert.equal(a.liftAvg, (1 - 1 / 3) / 2);
});
test('verdictFor: 指定された5分岐と境界・優先順位', () => {
  const a = { measured: true, liftAvg: 0.2, costMultiplier: 3, detectionRecallAvg: 0.5 };
  assert.deepEqual(verdictFor({ ...a, measured: false }), { verdict: '未実測', reason: '実測runなし' });
  for (const liftAvg of [0, -0.1]) assert.deepEqual(verdictFor({ ...a, liftAvg }), { verdict: 'リレー効果なし', reason: '見落としの回復が0以下' });
  assert.deepEqual(verdictFor({ ...a, costMultiplier: 3.01, detectionRecallAvg: null }), { verdict: '条件付きで有効', reason: '品質は上がるがコストが3倍超' });
  assert.deepEqual(verdictFor({ ...a, detectionRecallAvg: null }), { verdict: '条件付きで有効', reason: '見落とし検出の実測が無い' });
  assert.deepEqual(verdictFor(a), { verdict: 'リレー有効', reason: '見落としを回復しコスト増は3倍以内' });
  assert.equal(verdictFor({ ...a, costMultiplier: null }).verdict, 'リレー有効');
});
test('Markdown: 結論の実数・未実測・指定見出し', () => {
  const md = renderMarkdown(results(), catalog);
  assert.match(md, /単発 33\.3% → 統合 100\.0%、lift 66\.7%/);
  assert.match(renderMarkdown(null, catalog), /\*\*未実測\*\*/);
  assert.match(renderMarkdown(null, catalog), /--live/);
  for (const title of ['結論', '実測結果', '見落とし検出の精度', 'コスト', '前提値（assumed）', '未検証', '出典']) assert.ok(md.includes(`## ${title}`));
});
test('--check: 一時repo内のdriftと一致を確認', async (t) => {
  const f = fixture(t);
  assert.equal(await runCli({ ...f, check: true }), 1);
  assert.equal(f.output.stderr, 'drift: docs/model-relay.md が古い。node tools/model-relay.mjs --write で再生成\n');
  fs.writeFileSync(path.join(f.repo, 'docs', 'model-relay.md'), renderMarkdown(null, catalog));
  assert.equal(await runCli({ ...f, check: true }), 0);
  fs.appendFileSync(path.join(f.repo, 'docs', 'model-relay.md'), 'drift');
  assert.equal(await runCli({ ...f, check: true }), 1);
});
test('parseArgs: モード重複、不正引数、数値、レーン', () => {
  for (const args of [['--live', '--json'], ['--write', '--write'], ['--bad'], ['--repeat'], ['--live', '--repeat', '0'], ['--live', '--limit', '-1'], ['--live', '--limit', '1.2'], ['--live', '--lane-a', 'bad:m'], ['--live', '--lane-b', 'genspark:'], ['--json', '--limit', '2'], ['--live', '--repeat', '2', '--repeat', '3']]) assert.throws(() => parseArgs(args));
  const a = parseArgs(['--live', '--repeat', '2', '--limit', '1', '--lane-a', 'openrouter:vendor/model']);
  assert.equal(a.repeat, 2); assert.equal(a.limit, 1); assert.equal(a.laneA, 'openrouter:vendor/model');
  assert.equal(parseArgs([]).repeat, 1);
});
test('stage2へrequiredを漏らさず本文と初回回答を渡す', () => {
  const prompt = buildPrompt({ ...task, required: [{ id: 'SECRET', any: ['SECRET'] }] }, 2, 'FIRST');
  assert.ok(prompt.user.includes(task.brief)); assert.ok(prompt.user.includes('FIRST')); assert.ok(!JSON.stringify(prompt).includes('SECRET'));
});
test('provider: 429/5xxを1/2/4秒で再試行しOpenAI形式を読む（模擬のみ）', async () => {
  const delays = []; let calls = 0;
  const x = await callProvider('openrouter:vendor/model', { system: 'sys', user: 'u' }, 321, { key: 'test-key', sleep: async (ms) => delays.push(ms), fetch: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers['X-Title'], 'orgiast-model-relay'); assert.equal(JSON.parse(options.body).max_tokens, 321);
    return ++calls <= 3 ? { ok: false, status: calls === 1 ? 429 : 503 } : { ok: true, json: async () => ({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.02 } }) };
  } });
  assert.deepEqual(delays, [1000, 2000, 4000]); assert.equal(x.status, 'ok'); assert.equal(x.costUsd, 0.02); assert.equal(x.inTok, 10);
});
test('provider: anthropic形式・費用未取得・認証値反射の伏字', async () => {
  const x = await callProvider('anthropic:test', { system: 'sys', user: 'u' }, undefined, { key: 'secret-test-key', fetch: async (url, options) => {
    assert.equal(options.headers['x-api-key'], 'secret-test-key'); assert.equal(options.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(options.body); assert.equal(body.system, 'sys'); assert.equal(body.max_tokens, 800); assert.equal(body.messages.length, 1);
    return { ok: true, json: async () => ({ content: [{ text: 'secret-test-key' }], usage: { input_tokens: 12, output_tokens: 3 } }) };
  } });
  assert.equal(x.text, '[REDACTED]'); assert.equal(x.inTok, 12); assert.equal(x.outTok, 3); assert.equal(x.costUsd, null);
});
test('provider: 400は再試行せず、再試行上限・例外もerrorで返す', async () => {
  let calls = 0;
  const options = { key: 'secret', sleep: async () => {}, fetch: async () => { calls++; return { ok: false, status: 400 }; } };
  assert.equal((await callProvider('genspark:m', { user: 'x' }, 800, options)).status, 'error'); assert.equal(calls, 1);
  calls = 0; options.fetch = async () => { calls++; return { ok: false, status: 503 }; };
  assert.equal((await callProvider('genspark:m', { user: 'x' }, 800, options)).status, 'error'); assert.equal(calls, 4);
  options.fetch = async () => { throw new Error('secret'); };
  assert.ok(!JSON.stringify(await callProvider('genspark:m', { user: 'x' }, 800, options)).includes('secret'));
});
test('模擬リレー: A/B/A、上書き保存、API失敗後も次タスクへ進む', async (t) => {
  const f = fixture(t), target = path.join(f.repo, 'tools', 'model-relay.results.json');
  const other = { lanes: { a: 'anthropic:other', b: catalog.lanes.b }, tasks: [] };
  fs.writeFileSync(target, JSON.stringify({ runs: [...results().runs, other] }));
  const models = []; let count = 0;
  const transport = { key: 'test-secret', fetch: async (url, options) => {
    const body = JSON.parse(options.body); models.push(body.model); count++;
    if (count === 4) return { ok: false, status: 400 };
    return { ok: true, json: async () => ({ choices: [{ message: { content: count === 2 ? critique : '税込 金曜 田中' } }], usage: { cost: 1 } }) };
  } };
  assert.equal(await runCli({ ...f, live: true, repeat: 3, transport }), 0);
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(saved.runs.length, 2); assert.deepEqual(saved.runs[0], other);
  const rows = saved.runs[1].tasks; assert.equal(rows.length, 3); assert.equal(rows[1].status, 'error'); assert.equal(rows[2].status, 'ok');
  assert.deepEqual(models.slice(0, 3), ['claude-sonnet-5', 'gpt-5.6-luna', 'claude-sonnet-5']);
  assert.match(f.output.stdout, /PASS t/); assert.match(f.output.stdout, /FAIL t/);
});
test('実カタログ: 6件、4〜6要件、カテゴリと既定レーン', () => {
  const c = JSON.parse(fs.readFileSync(new URL('./model-relay-catalog.json', import.meta.url), 'utf8'));
  assert.equal(c.tasks.length, 6); assert.deepEqual(c.lanes, catalog.lanes);
  assert.equal(new Set(c.tasks.map((t) => t.id)).size, 6);
  assert.deepEqual(new Set(c.tasks.map((t) => t.category)), new Set(['reply', 'extract', 'minutes', 'estimate']));
  for (const t of c.tasks) { assert.ok(t.required.length >= 4 && t.required.length <= 6); assert.equal(new Set(t.required.map((r) => r.id)).size, t.required.length); for (const r of t.required) assert.ok(r.any.length && r.any.every((k) => k.length > 0)); }
});
