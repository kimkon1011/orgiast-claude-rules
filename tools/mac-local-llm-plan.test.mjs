import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeEconomics, computeFit, estimateThroughput, round1, runPlan, validateCatalog } from './mac-local-llm-plan.mjs';

const REAL_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_CATALOG = JSON.parse(fs.readFileSync(path.join(REAL_REPO, 'tools', 'mac-local-llm-catalog.json'), 'utf8'));

function clone(value) { return structuredClone(value); }

function createRepo(catalog = REAL_CATALOG) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-local-llm-plan-'));
  const catalogPath = path.join(repo, 'tools', 'mac-local-llm-catalog.json');
  const docPath = path.join(repo, 'docs', 'mac-local-llm-plan.md');
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
  return { repo, catalogPath, docPath };
}

function invoke(paths, options = {}) {
  let out = '';
  let err = '';
  const code = runPlan({ ...paths, ...options, stdout: { write: (value) => { out += value; } }, stderr: { write: (value) => { err += value; } } });
  return { code, out, err };
}

const assumptions = REAL_CATALOG.assumptions;
const q4 = REAL_CATALOG.quants.find((item) => item.id === 'q4_k_m');
const llama = REAL_CATALOG.models.find((item) => item.id === 'llama-3.3-70b');
const m64 = REAL_CATALOG.machines.find((item) => item.maxMemoryGB === 64);
const m128 = REAL_CATALOG.machines.find((item) => item.maxMemoryGB === 128);

test('70B Q4_K_M の重みは 42GB', () => {
  assert.equal(round1(computeFit(m128, { ...llama, nativeContextTokens: 0 }, q4, { ...assumptions, osOverheadGB: Number.MIN_VALUE, computeOverheadRatio: 0 }).weightGB), 42);
});

test('Llama 70B の 32768 context KV は 10.7GB', () => {
  const fit = computeFit(m128, { ...llama, nativeContextTokens: 32768 }, q4, assumptions);
  assert.equal(round1(fit.kvGB), 10.7);
});

test('Llama 70B Q4 32768 context は128GB機に64.9GB必要で収容できる', () => {
  // 仕様の64.9はネイティブ131072ではなく、このケースで明記された32768 contextで再計算すると64.937...。
  const fit = computeFit(m128, { ...llama, nativeContextTokens: 32768 }, q4, assumptions);
  assert.equal(round1(fit.requiredGB), 64.9);
  assert.equal(round1(fit.usableGB), 96);
  assert.equal(fit.fits, true);
});

test('Llama 70B Q4 32768 context は64GB機に収容できない', () => {
  const fit = computeFit(m64, { ...llama, nativeContextTokens: 32768 }, q4, assumptions);
  assert.equal(round1(fit.usableGB), 48);
  assert.equal(fit.fits, false);
});

test('Llama 70B Q4 の614GB/s機は8.0–11.0 tok/s', () => {
  const throughput = estimateThroughput(m128, llama, q4, assumptions);
  assert.deepEqual([round1(throughput.low), round1(throughput.high)], [8, 11]);
});

test('419800円機の経済性を仕様どおり算出する', () => {
  // 月625円は624.96、月次12286円は12286.07...。仕様記載の3年442300円は再計算すると
  // 419800 + 624.96 * 36 = 442298.56 なので、Math.round の正しい期待値は442299円。
  const result = computeEconomics(m128, assumptions);
  assert.equal(Math.round(result.electricityYenPerMonth), 625);
  assert.equal(Math.round(result.monthlyOwnershipYen), 12286);
  assert.equal(Math.round(result.threeYearYen), 442299);
  assert.equal(result.breakEvenMtokPerMonth, null);
});

test('validateCatalog は重複id・未知のpriceVerify・0メモリを弾く', () => {
  const catalog = clone(REAL_CATALOG);
  catalog.machines[1].id = catalog.machines[0].id;
  catalog.machines[1].priceVerify = 'guess';
  catalog.machines[1].maxMemoryGB = 0;
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /id が重複/u);
  assert.match(errors, /priceVerify/u);
  assert.match(errors, /maxMemoryGB/u);
});

test('実リポジトリの生成docにdriftがない', () => {
  const result = invoke({ repo: REAL_REPO }, { check: true });
  assert.equal(result.code, 0, result.err);
});

test('docを書き換えるとcheckがdriftで失敗する', (t) => {
  const paths = createRepo();
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  assert.equal(invoke(paths, { write: true }).code, 0);
  fs.appendFileSync(paths.docPath, '改変\n', 'utf8');
  const result = invoke(paths, { check: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /drift:/u);
});

test('CRLFの生成docもcheckに通る', (t) => {
  const paths = createRepo();
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  invoke(paths, { write: true });
  fs.writeFileSync(paths.docPath, fs.readFileSync(paths.docPath, 'utf8').replace(/\n/gu, '\r\n'), 'utf8');
  assert.equal(invoke(paths, { check: true }).code, 0);
});

test('--json相当の出力はmachines・models・fitsを持つJSON', () => {
  const result = invoke({ repo: REAL_REPO }, { json: true });
  assert.equal(result.code, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.ok(Array.isArray(parsed.machines));
  assert.ok(Array.isArray(parsed.models));
  assert.ok(Array.isArray(parsed.fits));
});

test('モデル別verdictと機種別fitsは仕様どおり', () => {
  const result = JSON.parse(invoke({ repo: REAL_REPO }, { json: true }).out);
  assert.equal(result.verdicts.find((item) => item.modelId === 'qwen3-8b').verdict, '対話可');
  const llamaFits = result.fits.filter((item) => item.modelId === 'llama-3.3-70b' && item.quantId === 'q4_k_m');
  assert.equal(llamaFits.find((item) => item.machineId === 'mac-studio-m5-max-128').fits, false);
  assert.equal(llamaFits.find((item) => item.machineId === 'mac-studio-m5-ultra-512').fits, true);
  assert.equal(result.verdicts.find((item) => item.modelId === 'llama-3.3-70b').verdict, '対話可');
});

test('判定表の動く機械列はLlama 70Bを収容できる機械だけを示す', () => {
  const result = invoke({ repo: REAL_REPO });
  assert.equal(result.code, 0, result.err);
  const markdown = result.out;
  assert.match(markdown, /\| モデル \| verdict \| 動く機械（推定tok\/s上限） \|/u);
  const row = markdown.split('\n').find((line) => line.startsWith('| Llama-3.3-70B-Instruct |'));
  assert.ok(row);
  assert.match(row, /Mac Studio \(M5 Ultra\) 21\.4/u);
  assert.doesNotMatch(row, /Mac mini \(M6\)/u);
  assert.equal(row, '| Llama-3.3-70B-Instruct | 対話可 | Mac Studio (M5 Ultra) 21.4 |');
  assert.ok(markdown.includes('| Qwen3-8B | 対話可 | Mac mini (M6) 26.6 / Mac mini (M5 Pro) 48.0 / Mac Studio (M5 Max) 95.9 / Mac Studio (M5 Ultra) 187.5 |'));
  // 仕様(b)の判定表は価格順に並べ直さず、カタログの順序を維持する。
  assert.ok(markdown.includes('| Qwen3-32B | 対話可 | Mac mini (M5 Pro) 12.0 / Mac Studio (M5 Max) 24.0 / Mac Studio (M5 Ultra) 46.9 |'));
});

test('結論は最安の動く機械を示し、単独候補にはのみと推定上限を併記する', (t) => {
  const catalog = clone(REAL_CATALOG);
  catalog.machines.reverse();
  const paths = createRepo(catalog);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const result = invoke(paths);
  assert.equal(result.code, 0, result.err);
  const conclusion = result.out.split('\n').find((line) => line.startsWith('- モデル別判定:'));
  assert.equal(conclusion, '- モデル別判定: Qwen3-8B「対話可」（Mac mini (M6) 以上）、Qwen3-32B「対話可」（Mac mini (M5 Pro) 以上）、Llama-3.3-70B-Instruct「対話可」（Mac Studio (M5 Ultra) のみ・推定上限 21.4 tok/s）、Qwen2.5-72B-Instruct「対話可」（Mac Studio (M5 Max) 以上）。');
  // 仕様(b)の判定表は価格順に並べ直さず、カタログの順序を維持する。
  assert.ok(result.out.includes('| Qwen3-8B | 対話可 | Mac Studio (M5 Ultra) 187.5 / Mac Studio (M5 Max) 95.9 / Mac mini (M5 Pro) 48.0 / Mac mini (M6) 26.6 |'));
  assert.ok(result.out.includes('- つまり 70B 級を動かすには 21.4 tok/s 推定・94.98 万円〜の Mac Studio M5 Ultra しか選択肢がなく、「開発チームに配備してスピード向上」の費用対効果はこの 1 点で決まる。'));
});

test('動かない行のtok/sセルは-で、動く行だけ推定帯を出す', () => {
  // 仕様(a): 収容不能な構成に理論帯域値を併記すると「その速度で動く」と誤読されるため、動かない行は「-」にする。
  const result = invoke({ repo: REAL_REPO });
  assert.equal(result.code, 0, result.err);
  const markdown = result.out;
  assert.match(markdown, /\| 動かない \| -73\.1 \| - \|/u);
  const matrix = markdown.split('## 実行可能性マトリクス\n')[1].split('## 経済性\n')[0];
  const rows = matrix.split('\n').filter((line) => line.startsWith('| Mac '));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    const verdict = cells[5];
    const throughput = cells[7];
    if (verdict === '動かない') assert.equal(throughput, '-', row);
    else assert.match(throughput, /^\d+\.\d–\d+\.\d（推定）$/u, row);
  }
});

test('判定表の動く機械列はLlama 70Bを収容できる機械だけを示す', () => {
  // 仕様(b): モデル単位の verdict だけでは「4モデル全部がどの機でも動く」と誤読されるため、動く機械を必ず併記する。
  const result = invoke({ repo: REAL_REPO });
  assert.equal(result.code, 0, result.err);
  const markdown = result.out;
  assert.match(markdown, /\| モデル \| verdict \| 動く機械（推定tok\/s上限） \|/u);
  const row = markdown.split('\n').find((line) => line.startsWith('| Llama-3.3-70B-Instruct |'));
  assert.ok(row);
  assert.match(row, /Mac Studio \(M5 Ultra\)/u);
  assert.doesNotMatch(row, /Mac mini \(M6\)/u);
  assert.equal(row, '| Llama-3.3-70B-Instruct | 対話可 | Mac Studio (M5 Ultra) 21.4 |');
});

test('Q4_K_Mで収容できなければ他の量子化が動いても動く機械なしと表示する', (t) => {
  const catalog = clone(REAL_CATALOG);
  catalog.quants.find((quant) => quant.id === 'q4_k_m').bitsPerWeight = 1000;
  const paths = createRepo(catalog);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const result = invoke(paths);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes('| Qwen3-8B | 対話可 | 動く機械なし |'));
  assert.ok(result.out.includes('Qwen3-8B「対話可」（動く機械なし）'));
});
