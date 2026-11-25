import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify, parseClassification, generateSamples, evaluate, createCaller, execute } from './confidence-classifier.mjs';

const answer = (confidence = 0.95, extra = {}) => JSON.stringify({
  lead_qualified: true, urgency: 'high', type: 'custom',
  lead_confidence: confidence, urgency_confidence: confidence, type_confidence: confidence, ...extra,
});
for (const [confidence, expected] of [
  [0.9, ['groq']], [0.899, ['groq', 'gemini']], [0.3, ['groq', 'gemini']], [0.299, ['groq', 'genspark']],
]) {
  test('confidence boundary ' + confidence, async () => {
    const calls = [];
    const result = await classify('問い合わせ', { call: async provider => {
      calls.push(provider); return answer(provider === 'groq' ? confidence : 0.96);
    } });
    assert.deepEqual(calls, expected);
    assert.equal(result.escalated, expected.length > 1);
    assert.equal(result.classifications.length, 3);
  });
}
test('minimum dimension confidence and uncertain trigger escalation', () => {
  assert.equal(parseClassification(answer(0.99, { type_confidence: 0.1 })).confidence, 0.1);
  assert.equal(parseClassification(answer(0.99, { reason: 'uncertain' })).confidence, 0);
  assert.equal(parseClassification('```json\n' + answer() + '\n```').confidence, 0.95);
  for (const raw of ['{}', 'not json', answer('0.9'), answer(-1), answer(1.1), answer(1, { urgency: 'urgent' }), answer(1, { lead_qualified: 'yes' })]) {
    assert.throws(() => parseClassification(raw));
  }
});
test('invalid cheap response falls back to DeepSeek', async () => {
  const calls = [];
  await classify('test', { call: async p => { calls.push(p); return p === 'groq' ? '{}' : answer(); } });
  assert.deepEqual(calls, ['groq', 'deepseek']);
});
test('medium outage or low confidence upgrades to high; unresolved result needs review', async () => {
  for (const fail of [true, false]) {
    const calls = [];
    const result = await classify('test', { call: async p => {
      calls.push(p);
      if (fail && p === 'gemini') throw Error('outage');
      return answer(0.5);
    } });
    assert.deepEqual(calls, ['groq', 'gemini', 'genspark']);
    assert.equal(result.needs_review, true);
  }
});
test('total outage is an error, not a fabricated classification', async () => {
  const calls = [];
  await assert.rejects(classify('test', { call: async p => { calls.push(p); throw Error('offline'); } }), /分類できません/);
  assert.deepEqual(calls, ['groq', 'deepseek', 'genspark']);
});
test('sample dates, labels and four variants per project are reproducible', () => {
  const samples = generateSamples();
  assert.deepEqual(samples, generateSamples());
  assert.equal(samples.length, 12);
  assert.equal(new Set(samples.map(s => s.project_id)).size, 3);
  for (const s of samples) {
    const days = (Date.parse(s.event_date) - Date.parse(s.reference_date)) / 86400000;
    assert.equal(s.labels.urgency, days <= 14 ? 'high' : days <= 60 ? 'medium' : 'low');
    assert.ok(s.text.includes(s.event_date));
  }
});
test('evaluation counts errors, all dimensions and only this run costs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-eval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cost-log.jsonl'), [
    { run_id: 'other', usd: 100 }, { run_id: 'current', usd: 0.01 }, { run_id: 'current', usd: null },
  ].map(JSON.stringify).join('\n'));
  const samples = generateSamples(2);
  const metrics = await evaluate(samples, { outputDir: dir, runId: 'current', call: async (p, text) => {
    if (text === samples[1].text) throw Error('offline');
    return answer(0.95, samples[0].labels);
  } });
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.exact_accuracy, 0.5);
  assert.deepEqual(metrics.dimension_accuracy, { lead_qualified: 0.5, urgency: 0.5, type: 0.5 });
  assert.equal(metrics.known_usd, 0.01);
  assert.equal(metrics.total_usd, null);
  assert.equal(metrics.usd_per_1000, null);
  assert.equal(metrics.escalation_rate, 0.5);
});
test('real llm-ask subprocess with mock transport writes isolated usage and preserves prompt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock.mjs');
  const text = '日本語 --provider bad "quotes"';
  fs.writeFileSync(mock, `
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (!url.includes('groq') || body.model !== 'openai/gpt-oss-120b') throw Error('wrong route');
      const inquiry = JSON.parse(body.messages.at(-1).content).inquiry;
      if (inquiry !== ${JSON.stringify(text)}) throw Error('prompt changed');
      return new Response(JSON.stringify({ choices: [{ message: { content: ${JSON.stringify(answer())} } }], usage: {prompt_tokens: 10, completion_tokens: 20, cost: 0.001} }));
    };
  `);
  const exec = (file, args, options) => execute(file, ['--import', pathToFileURL(mock).href, ...args], {
    ...options, env: { ...process.env, ORGIAST_HOME: dir, GROQ_API_KEY: 'test-only' },
  });
  const call = createCaller({ outputDir: dir, runId: 'integration', exec });
  assert.equal((await classify(text, { call })).confidence, 0.95);
  const rows = fs.readFileSync(path.join(dir, 'cost-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens, 30);
  assert.equal(rows[0].usd, 0.001);
  assert.equal(rows[0].run_id, 'integration');
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});
