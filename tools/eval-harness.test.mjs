import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isUnmeasurable, paretoClassification, recommendations, resultRecord, suspiciousTasks } from './eval-harness.mjs';

// Run the real CLI with isolated home/config/results and a fetch stub; --all also
// writes a routing table, so copy its modules rather than touching the checkout.
function runHarness(t, { cooldown = {}, tasks, responses = [], args = ['--provider', 'openrouter'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cooldown-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tools = path.join(home, 'tools'), evalDir = path.join(home, '.claude', 'eval');
  fs.mkdirSync(path.join(tools, 'lib'), { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });
  for (const file of ['eval-harness.mjs', 'eval-exec-checks.mjs', 'is-entry.mjs', 'routing-table.mjs', 'llm-fallback.mjs', 'lib/provider-daily-cooldown.mjs']) {
    fs.copyFileSync(new URL(file, import.meta.url), path.join(tools, file));
  }
  const seed = tasks || [{ id: 'one', category: 'classification', prompt: 'test', expect: { type: 'contains', value: 'ok' } }];
  fs.writeFileSync(path.join(tools, 'eval-tasks.seed.jsonl'), seed.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(tools, 'eval-providers.json'), JSON.stringify([{ provider: 'groq', model: 'test' }, { provider: 'openrouter', model: 'test' }]));
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify(cooldown));
  const preload = path.join(home, 'mock-fetch.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (url) => {
      fs.appendFileSync(${JSON.stringify(path.join(home, 'fetch.jsonl'))}, JSON.stringify(String(url)) + '\\n');
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return new Response(response.body, { status: response.status || 200, headers: response.headers });
    };
  `);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(tools, 'eval-harness.mjs'), ...args], {
    cwd: home, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, USERPROFILE: home, GROQ_API_KEY: 'test', OPENROUTER_API_KEY: 'test' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const readLines = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {
    ...result,
    calls: readLines(path.join(home, 'fetch.jsonl')),
    results: readLines(path.join(home, '.claude', 'eval-results.jsonl')),
    runs: fs.readdirSync(path.join(evalDir, 'runs')),
    cooldown: JSON.parse(fs.readFileSync(path.join(home, '.claude', 'provider-cooldown.json'), 'utf8')),
  };
}

const activeCooldown = () => ({ until: Date.now() + 3600000, reason: 'daily_limit' });
const success = { body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) };

test('call skips a cooled-down judge without fetching', (t) => {
  const result = runHarness(t, {
    cooldown: { groq: activeCooldown() }, responses: [success],
    tasks: [{ id: 'judge', category: 'classification', prompt: 'test', expect: { type: 'judge' } }],
  });
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /openrouter/);
  assert.match(result.stderr, /ERROR judge: SKIP groq: cooldown中 \(daily_limit, 残り\d+分\)/);
  assert.equal(result.results[0].errors, 1);
});

test('--all skips all tasks for a cooled-down provider and runs the next provider', (t) => {
  const result = runHarness(t, { cooldown: { groq: activeCooldown() }, responses: [success], args: ['--all'] });
  assert.match(result.stdout, /SKIP groq: cooldown中 \(daily_limit, 残り\d+分\)/);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /openrouter/);
  assert.deepEqual(result.results.map((row) => row.provider), ['openrouter']);
  assert.equal(result.results[0].pass, 1);
  assert.equal(result.runs.length, 1);
  assert.match(result.runs[0], /openrouter/);
  assert.doesNotMatch(result.stderr, /ERROR/);
});

test('single-provider run skips before executing any tasks or fetching', (t) => {
  const result = runHarness(t, { cooldown: { openrouter: activeCooldown() } });
  assert.match(result.stdout, /SKIP openrouter: cooldown中/);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.runs, []);
});

test('OpenRouter daily quota records OpenRouter and call skips the next task without fetching', (t) => {
  const groq = activeCooldown();
  const result = runHarness(t, {
    cooldown: { groq }, responses: [{ status: 429, body: 'Requests per day (RPD) exceeded' }],
    tasks: ['one', 'two', 'three'].map((id) => ({ id, category: 'classification', prompt: 'test', expect: { type: 'contains', value: 'ok' } })),
  });
  assert.equal(result.calls.length, 1);
  assert.match(result.stderr, /ERROR one: 429:/);
  assert.match(result.stderr, /ERROR two: SKIP openrouter: cooldown中/);
  assert.match(result.stderr, /ERROR three: SKIP openrouter: cooldown中/);
  assert.doesNotMatch(result.stderr, /RETRY/);
  assert.deepEqual(result.cooldown.groq, groq);
  const recorded = result.cooldown.openrouter;
  assert.equal(recorded.reason, 'daily_limit');
  const when = new Date(recorded.recordedAt);
  assert.equal(recorded.until, Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate() + 1));
});

for (const status of [429, 503]) {
  test(`ordinary HTTP ${status} still retries three times without marking cooldown`, (t) => {
    const result = runHarness(t, {
      responses: [...Array.from({ length: 3 }, () => ({ status, body: 'temporary overload', headers: { 'retry-after': '0' } })), success],
    });
    assert.equal(result.calls.length, 4);
    assert.equal((result.stderr.match(/RETRY openrouter/g) || []).length, 3);
    assert.deepEqual(result.cooldown, {});
    assert.equal(result.results[0].pass, 1);
  });
}

test('expired cooldown allows HTTP and normal task execution', (t) => {
  const result = runHarness(t, { cooldown: { openrouter: { until: Date.now() - 1000, reason: 'daily_limit' } }, responses: [success] });
  assert.equal(result.calls.length, 1);
  assert.equal(result.results[0].pass, 1);
  assert.doesNotMatch(result.stdout, /SKIP/);
});

function task(id, category, status, extra = {}) {
  return { id, category, status, pass: status === 'pass', costUsd: 0.001, ms: 10, ...extra };
}

test('attemptedRate は pass/n、既存 rate は pass/graded のまま', () => {
  const r = resultRecord('p', 'm', [task('a', 'cat', 'pass'), task('b', 'cat', 'fail'), task('c', 'cat', 'error')], '2026-08-26T00:00:00Z');
  assert.equal(r.attemptedRate, 1 / 3);
  assert.equal(r.rate, 1 / 2);
  assert.deepEqual(r.tasks, [
    { id: 'a', category: 'cat', pass: true, status: 'pass' },
    { id: 'b', category: 'cat', pass: false, status: 'fail' },
    { id: 'c', category: 'cat', pass: false, status: 'error' }
  ]);
});

test('errors + truncated が n の1割超なら計測不能で推薦されない', () => {
  const bad = resultRecord('quota', 'flash', [task('ok', 'cat', 'pass'), ...Array.from({ length: 8 }, (_, i) => task(`p${i}`, 'cat', 'pass')), task('e1', 'cat', 'error'), task('e2', 'cat', 'truncated')]);
  const good = resultRecord('stable', 'model', Array.from({ length: 11 }, (_, i) => task(`g${i}`, 'cat', i ? 'pass' : 'fail')));
  assert.equal(isUnmeasurable(bad), true);
  assert.equal(paretoClassification(bad), '🚫計測不能 (エラー1件・切断1件)');
  const output = recommendations([bad, good]).join('\n');
  assert.doesNotMatch(output, /quota\/flash/);
  assert.match(output, /stable\/model/);
});

test('半数以上が fail/error のタスクは警告され推薦根拠から外れる', () => {
  const rows = [
    resultRecord('a', 'm', [task('rep-03', 'jp_reply', 'fail'), task('good', 'jp_reply', 'pass')]),
    resultRecord('b', 'm', [task('rep-03', 'jp_reply', 'error'), task('good', 'jp_reply', 'pass')]),
    resultRecord('c', 'm', [task('rep-03', 'jp_reply', 'pass'), task('good', 'jp_reply', 'pass')])
  ];
  assert.deepEqual(suspiciousTasks(rows), [{ id: 'rep-03', participants: 3, failed: 2 }]);
  const output = recommendations(rows).join('\n');
  assert.match(output, /タスク rep-03: 3プロバイダ中2で失敗/);
  assert.match(output, /成功率 100%/);
});
