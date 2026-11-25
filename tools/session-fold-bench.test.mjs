import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusReport, costReport, measureCase, recallReport, splitSegments, SYNTHETIC_PATH } from './session-fold-bench.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUESTIONS_PATH = path.resolve('tests/fixtures/session-fold/holdout-questions-synthetic-v1.json');
const JA_FIXTURE_PATH = path.resolve('tests/fixtures/session-fold/synthetic-booth-spec-ja.md');
const JA_QUESTIONS_PATH = path.resolve('tests/fixtures/session-fold/holdout-questions-synthetic-v2.json');

function whitespaceOnlySearch(session, query, { k }) {
  const needles = [...new Set(query.normalize('NFKC').toLocaleLowerCase('und').match(/[\p{L}\p{N}]+/gu) ?? [])];
  return session.index.filter(entry => entry.state === 'folded').map(entry => {
    const haystack = `${entry.summary} ${session.store[entry.id]}`.normalize('NFKC').toLocaleLowerCase('und');
    return { id: entry.id, score: needles.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

test('corpus reports metadata for at least 30 synthetic segments without body text', () => {
  const report = corpusReport({ synthetic: true });
  assert.ok(report.total.segments >= 30);
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /northwest corner|Northstar Example/);
});

test('cost table has every turns by hit-rate cell and all assumptions', () => {
  const output = costReport({ synthetic: true, turns: [2, 4], hitRates: [.05, .2], keepRecent: 3, k: 2 });
  assert.equal((output.match(/^\| (?:2|4) \|/gm) ?? []).length, 4);
  for (const expected of ['input $1/Mtok', 'cache read coefficient 0.1', 'cache write coefficient 1.25', 'Fetched: 2026-11-10', 'Turns: 2, 4', 'Hit rates: 5.0%, 20.0%', '71.1%']) assert.match(output, new RegExp(expected.replace(/[.$]/g, '\\$&')));
});

test('cost output is deterministic', () => {
  const options = { synthetic: true, turns: [5], hitRates: [.2], keepRecent: 4, k: 3 };
  assert.equal(costReport(options), costReport(options));
});

test('no-op fold calibration produces less than one percent input reduction', () => {
  const count = splitSegments(fs.readFileSync(SYNTHETIC_PATH, 'utf8')).length;
  const output = costReport({ synthetic: true, turns: [10], hitRates: [0], keepRecent: count, k: 3 });
  const reduction = Number(output.match(/\| 10 \| 0\.0% \| (-?[\d.]+)%/)[1]);
  assert.ok(Math.abs(reduction) < 1, reduction);
});

test('100 percent hit rate lowers savings monotonically', () => {
  const output = costReport({ synthetic: true, turns: [10], hitRates: [0, .5, 1], keepRecent: 2, k: 1 });
  const values = [...output.matchAll(/\| 10 \| [\d.]+% \| (-?[\d.]+)%/g)].map(x => Number(x[1]));
  assert.equal(values.length, 3);
  assert.ok(values[0] >= values[1] && values[1] >= values[2], values);
});

test('missing files and negative turns fail explicitly', () => {
  assert.throws(() => corpusReport({ files: ['definitely-missing.md'] }), /file not found/);
  assert.throws(() => costReport({ synthetic: true, turns: [-1], hitRates: [.2] }), /turns must contain positive integers/);
});

test('foldEvery=1 preserves the previous default calculation', () => {
  const segments = splitSegments(fs.readFileSync(SYNTHETIC_PATH, 'utf8'));
  const options = { turns: 20, hitRate: .2, keepRecent: 4, k: 2 };
  const previousResult = {
    inputReduction: -0.12623763659477022,
    costReduction: -5.47722658887576,
    baselineInputTokens: 12128,
    foldInputTokens: 13659.010056621373,
    baselineCost: 0.0025353000000000003,
    foldCost: 0.016421712570776716,
  };
  assert.deepEqual(measureCase(segments, options), previousResult);
  assert.deepEqual(measureCase(segments, { ...options, foldEvery: 1 }), previousResult);
});

test('batching folds improves cost reduction for the synthetic corpus', () => {
  const segments = splitSegments(fs.readFileSync(SYNTHETIC_PATH, 'utf8'));
  const options = { turns: 100, hitRate: .05, keepRecent: 3, k: 1 };
  const everyTurn = measureCase(segments, { ...options, foldEvery: 1 });
  const batched = measureCase(segments, { ...options, foldEvery: 20 });
  assert.ok(batched.costReduction > everyTurn.costReduction, { everyTurn, batched });
});

test('foldEvery rejects zero and fractional values', () => {
  const options = { turns: 2, hitRate: 0, keepRecent: 0, k: 0 };
  assert.throws(() => measureCase(['one'], { ...options, foldEvery: 0 }), /fold-every must be a positive integer/);
  assert.throws(() => measureCase(['one'], { ...options, foldEvery: 1.5 }), /fold-every must be a positive integer/);
  assert.throws(() => costReport({ synthetic: true, foldEvery: 0 }), /fold-every must be a positive integer/);
});

test('recall report measures the synthetic v1 question set', () => {
  const output = recallReport({ synthetic: true, questionsFile: QUESTIONS_PATH, keepRecent: 10, k: [1, 3, 5] });
  assert.match(output, /questionSet: synthetic-v1/);
  const questionCount = Number(output.match(/questions: (\d+)/)[1]);
  assert.ok(questionCount >= 20);
  const recalls = [...output.matchAll(/^- recall@\d+: ([\d.]+)$/gm)].map(match => Number(match[1]));
  assert.equal(recalls.length, 3);
  assert.ok(recalls.every(value => value >= 0 && value <= 1));
  assert.match(output, /adoption: (?:NG|OK)/);
  assert.match(output, /measured=計算モデルではなく search 関数の実出力/);
});

test('recall calibration detects broken and oracle search functions', () => {
  const broken = recallReport({ synthetic: true, questionsFile: QUESTIONS_PATH, searchFn: () => [] });
  assert.match(broken, /recall@3: 0\.000000/);
  assert.match(broken, /adoption: NG \(miss rate > 10%\)/);

  const answers = new Map(JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8')).questions.map(item => [item.q, item.answer]));
  const oracle = recallReport({
    synthetic: true,
    questionsFile: QUESTIONS_PATH,
    searchFn: (_session, query) => answers.get(query).map(id => ({ id, score: 1 })),
  });
  assert.match(oracle, /recall@3: 1\.000000/);
  assert.match(oracle, /adoption: OK \(miss rate <= 10%\)/);
});

test('Japanese fixture recall passes with CJK bi-grams and rejects whitespace-only calibration', () => {
  const options = { fixture: JA_FIXTURE_PATH, questionsFile: JA_QUESTIONS_PATH, keepRecent: 10, k: [3] };
  const actual = recallReport(options);
  assert.match(actual, /questionSet: synthetic-v2/);
  assert.match(actual, /adoption: OK \(miss rate <= 10%\)/);

  const broken = recallReport({ ...options, searchFn: whitespaceOnlySearch });
  assert.match(broken, /adoption: NG \(miss rate > 10%\)/);
});

test('recall errors explicitly for missing files, unknown answers, and small sets', () => {
  assert.throws(() => recallReport({ synthetic: true, questionsFile: 'definitely-missing.json' }), /questions file not found/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fold-recall-'));
  const unknown = path.join(dir, 'unknown.json');
  const small = path.join(dir, 'small.json');
  fs.writeFileSync(unknown, JSON.stringify({ id: 'bad', questions: Array.from({ length: 20 }, (_, i) => ({ q: `q${i}`, answer: ['seg-9999'] })) }));
  fs.writeFileSync(small, JSON.stringify({ id: 'small', questions: [{ q: 'q', answer: ['seg-0001'] }] }));
  assert.throws(() => recallReport({ synthetic: true, questionsFile: unknown }), /unknown answer segment ID: seg-9999/);
  assert.throws(() => recallReport({ synthetic: true, questionsFile: small }), /at least 20 entries/);
});
