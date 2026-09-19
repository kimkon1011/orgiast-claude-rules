import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from './mac-local-llm-plan.mjs';
import { computeMaxContext, runPlan } from './mac-16gb-plan.mjs';

const REAL_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CATALOG = JSON.parse(fs.readFileSync(path.join(REAL_REPO, 'tools', 'mac-16gb-catalog.json'), 'utf8'));
const machine = CATALOG.machines[0];
const q4 = CATALOG.quants[0];

function invoke(options = {}) {
  let out = ''; let err = '';
  const code = runPlan({ repo: REAL_REPO, ...options, stdout: { write: (value) => { out += value; } }, stderr: { write: (value) => { err += value; } } });
  return { code, out, err };
}

test('カタログは既存validateCatalogを通る', () => {
  assert.deepEqual(validateCatalog(CATALOG), []);
});

test('重みだけで実効メモリを超える場合はnull', () => {
  const model = { ...CATALOG.models[0], paramsB: 100 };
  assert.equal(computeMaxContext(machine, model, q4, CATALOG.assumptions), null);
});

test('文脈を削れば載る場合は正の整数', () => {
  const model = CATALOG.models.find((item) => item.id === 'qwen3-4b');
  const result = computeMaxContext(machine, model, q4, CATALOG.assumptions);
  assert.ok(Number.isInteger(result.maxContextTokens));
  assert.ok(result.maxContextTokens > 0);
  assert.ok(result.maxContextTokens < model.nativeContextTokens);
  assert.equal(result.fitsAtNative, false);
});

test('十分なメモリではnativeContextTokensで頭打ちになる', () => {
  const model = CATALOG.models[0];
  const result = computeMaxContext({ ...machine, maxMemoryGB: 128 }, model, q4, CATALOG.assumptions);
  assert.equal(result.maxContextTokens, model.nativeContextTokens);
  assert.equal(result.fitsAtNative, true);
});

test('--checkは実リポジトリの生成物と一致する', () => {
  const result = invoke({ check: true });
  assert.equal(result.code, 0, result.err);
});

test('--jsonは妥当な構造を返す', () => {
  const result = invoke({ json: true });
  assert.equal(result.code, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.ok(Array.isArray(parsed.machines));
  assert.ok(Array.isArray(parsed.models));
  assert.ok(Array.isArray(parsed.quants));
  assert.ok(Array.isArray(parsed.configurations));
  assert.ok(Array.isArray(parsed.economics));
  assert.ok(parsed.configurations.every((item) => 'fit' in item && 'maxContext' in item && 'throughput' in item));
});

test('改変された生成物はdriftとして検出する', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-16gb-plan-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools', 'mac-16gb-catalog.json'), JSON.stringify(CATALOG), 'utf8');
  assert.equal(runPlan({ repo, write: true }), 0);
  fs.appendFileSync(path.join(repo, 'docs', 'mac-16gb-plan.md'), '改変\n', 'utf8');
  let err = '';
  assert.equal(runPlan({ repo, check: true, stderr: { write: (value) => { err += value; } } }), 1);
  assert.match(err, /drift:/u);
});
