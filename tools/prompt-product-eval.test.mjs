import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPrompts, extractJson, grade, parseArgs, renderMarkdown, runCli, summarize, verdictFor } from './prompt-product-eval.mjs';

const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'prompt-product-catalog.json'), 'utf8'));
function syntheticResults() { const variant = (n, pass, costUsd = 0.1, outTok = 100) => ({ n, pass, errors: 0, inTok: 200, outTok, costUsd, msAvg: 50 }); return { updatedAt: '2026-09-20T00:00:00Z', runs: [{ provider: 'test', model: 'fixed', t: '2026-09-20T00:00:00Z', repeat: 1, byVariant: { plain: variant(10, 2), pack: variant(10, 4), workflow: variant(10, 8) }, tasks: [] }] }; }

test('buildPromptsは3変種を作りpackへ業務仕様を混ぜない', () => { const task = catalog.tasks[0], prompts = buildPrompts(task, catalog); assert.deepEqual(Object.keys(prompts), ['plain', 'pack', 'workflow']); assert.equal(prompts.pack.user.includes(task.workflowSpec), false); assert.match(prompts.workflow.user, /出力契約/); });

test('extractJsonはフェンス・前後文章・壊れたJSONを扱う', () => { assert.equal(extractJson('```json\n{"a":[1]}\n```'), '{"a":[1]}'); assert.equal(extractJson('前置き ["}",2] 後置き'), '["}",2]'); assert.throws(() => extractJson('前 {"a":1'), /閉じ括弧/); });

test('gradeは全typeの正常系と異常系を決定論的に採点する', () => {
  assert.equal(grade({ type: 'json_path', value: { a: 1 } }, '説明 {"a":1}'), true); assert.equal(grade({ type: 'json_path', value: { a: 2 } }, '{"a":1}'), false);
  assert.equal(grade({ type: 'enum', equal: '請求' }, '```\n請求\n```'), true); assert.equal(grade({ type: 'enum', equal: '請求' }, '請求です'), false);
  assert.equal(grade({ type: 'exact_lines', value: ['a', 'b'] }, ' a\n\nb '), true); assert.equal(grade({ type: 'exact_lines', value: ['b', 'a'] }, 'a\nb'), false);
  assert.equal(grade({ type: 'constraints', maxChars: 5, containsAll: ['ab'], noNewline: true }, 'abc'), true); assert.equal(grade({ type: 'constraints', maxChars: 5, containsAll: ['ab'], noNewline: true }, 'ab\nc'), false);
  assert.throws(() => grade({ type: 'mystery' }, ''), /未知/);
});

test('summarizeはlift・節約・損益分岐を手計算どおり返す', () => { const s = summarize(syntheticResults(), catalog).runs[0]; assert.equal(s.lift.pack, 0.2); assert.equal(s.lift.workflow, 0.6000000000000001); assert.ok(Math.abs(s.monthlySavingYen.pack - 3000) < 1e-9); assert.ok(Math.abs(s.breakEvenPriceYen.pack - 9000) < 1e-9); assert.equal(s.selfWriteCostYen, 500); assert.equal(s.variants.plain.costPerTaskYen, 1.5); assert.equal(s.variants.plain.avgOutTok, 10); });

test('verdictForは4分岐を踏む', () => { const base = { lift: { pack: 0.1 }, breakEvenPriceYen: { pack: 5000 }, noiseBand: 0.1, selfWriteCostYen: 500 }; assert.equal(verdictFor({ variant: 'pack', priceYen: 100 }, base).verdict, '購入価値なし'); const lifted = { ...base, lift: { pack: 0.2 } }; assert.equal(verdictFor({ variant: 'pack', priceYen: 6000 }, lifted).reason, '価格が損益分岐を上回る'); assert.equal(verdictFor({ variant: 'pack', priceYen: 1000 }, lifted).verdict, '条件付きで価値あり'); assert.equal(verdictFor({ variant: 'pack', priceYen: 500 }, lifted).verdict, '購入価値あり'); });

test('renderMarkdownの結論に実測値が入る', () => { const md = renderMarkdown(syntheticResults(), catalog); assert.match(md, /## 結論/); assert.match(md, /plain 20\.0%/); assert.match(md, /workflow 80\.0%/); });

test('--checkは一時docのdriftを検出する', async (t) => { const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-product-eval-')); t.after(() => fs.rmSync(repo, { recursive: true, force: true })); fs.mkdirSync(path.join(repo, 'tools')); fs.mkdirSync(path.join(repo, 'docs')); fs.copyFileSync(path.join(import.meta.dirname, 'prompt-product-catalog.json'), path.join(repo, 'tools', 'prompt-product-catalog.json')); fs.writeFileSync(path.join(repo, 'tools', 'prompt-product-eval.results.json'), JSON.stringify(syntheticResults())); fs.writeFileSync(path.join(repo, 'docs', 'prompt-product-eval.md'), '古い'); let error = ''; const code = await runCli({ repo, check: true, stderr: { write: (x) => { error += x; } } }); assert.equal(code, 1); assert.match(error, /drift:/); });

test('isEntry経由CLIは不明引数と複数モードを拒否する', () => { const tool = path.join(import.meta.dirname, 'prompt-product-eval.mjs'); for (const args of [['--unknown'], ['--write', '--json']]) { const run = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' }); assert.equal(run.status, 1); assert.match(run.stderr, /使用法:/); } assert.throws(() => parseArgs(['--run']), /provider/); });
