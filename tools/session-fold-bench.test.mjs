import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusReport, costReport, splitSegments, SYNTHETIC_PATH } from './session-fold-bench.mjs';
import fs from 'node:fs';

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
