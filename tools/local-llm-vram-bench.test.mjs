import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, detectQualityThreshold, diffusionVramGB, llmVramGB, pickFallbacks, renderMarkdown, runBench, validateCatalog } from './local-llm-vram-bench.mjs';

const REAL_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_CATALOG = JSON.parse(fs.readFileSync(path.join(REAL_REPO, 'tools', 'local-llm-vram-catalog.json'), 'utf8'));
const clone = (value) => structuredClone(value);
const model = REAL_CATALOG.models[0];
const quant = REAL_CATALOG.quants.find((item) => item.id === 'q4_k_m');
const gpu = REAL_CATALOG.gpus.find((item) => item.id === 'rtx-4090-24');

function invoke(options = {}) {
  let out = '';
  let err = '';
  const code = runBench({ ...options, stdout: { write: (value) => { out += value; } }, stderr: { write: (value) => { err += value; } } });
  return { code, out, err };
}

test('正常なcatalogを検証できる', () => assert.deepEqual(validateCatalog(REAL_CATALOG), []));

test('version、重複id、qualityImpact、負のVRAMを拒否する', () => {
  const catalog = clone(REAL_CATALOG);
  catalog.version = 2;
  catalog.gpus[1].id = catalog.gpus[0].id;
  catalog.qualityFallbacks[0].qualityImpact = 'zero';
  catalog.gpus[0].vramGB = -1;
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /version/u);
  assert.match(errors, /重複/u);
  assert.match(errors, /qualityImpact/u);
  assert.match(errors, /vramGB/u);
});

test('qualityFallbackのappliesToは非空・既知値・重複なしを要求する', () => {
  for (const appliesTo of [undefined, null, 'llm', [], ['unknown'], ['llm', 'llm']]) {
    const catalog = clone(REAL_CATALOG);
    catalog.qualityFallbacks[0].appliesTo = appliesTo;
    assert.match(validateCatalog(catalog).join('\n'), /appliesTo/u);
  }
});

test('KVキャッシュは文脈長に比例する', () => {
  const a = llmVramGB(gpu, model, quant, 4096, REAL_CATALOG.assumptions);
  const b = llmVramGB(gpu, model, quant, 8192, REAL_CATALOG.assumptions);
  assert.equal(b.kvGB, a.kvGB * 2);
});

test('8k文脈の必要GBはネイティブ文脈より小さい', () => {
  const native = llmVramGB(gpu, model, quant, model.nativeContextTokens, REAL_CATALOG.assumptions);
  const short = llmVramGB(gpu, model, quant, 8192, REAL_CATALOG.assumptions);
  assert.ok(short.requiredGB < native.requiredGB);
});

test('diffusion VRAMは解像度に対して単調増加し、NF4はfp16より小さい', () => {
  const diffusion = REAL_CATALOG.diffusionModels[1];
  const low = diffusionVramGB(diffusion, 512 ** 2 / 1e6, 'fp16', 1, REAL_CATALOG.assumptions);
  const high = diffusionVramGB(diffusion, 1024 ** 2 / 1e6, 'fp16', 1, REAL_CATALOG.assumptions);
  const nf4 = diffusionVramGB(diffusion, 1024 ** 2 / 1e6, 'nf4', 1, REAL_CATALOG.assumptions);
  assert.ok(high > low);
  assert.ok(nf4 < high);
});

test('直接収容可能ならfallbackなし・画質劣化なし', () => {
  const result = pickFallbacks({ ...gpu, vramGB: 128 }, model, quant, 4096, REAL_CATALOG.assumptions, REAL_CATALOG.qualityFallbacks);
  assert.equal(result.fits, true);
  assert.equal(result.degradesQuality, false);
  assert.deepEqual(result.applied, []);
});

test('直接収容不可でもCPU offloadだけで足りれば画質劣化なし', () => {
  const result = pickFallbacks({ ...gpu, vramGB: 6 }, model, quant, 4096, REAL_CATALOG.assumptions, REAL_CATALOG.qualityFallbacks);
  assert.equal(result.fits, true);
  assert.equal(result.degradesQuality, false);
  assert.deepEqual(result.applied, ['cpu-offload']);
});

test('LLMの退避にはdiffusion専用動作が混ざらない', () => {
  const result = pickFallbacks({ ...gpu, vramGB: 2 }, model, quant, model.nativeContextTokens, REAL_CATALOG.assumptions, REAL_CATALOG.qualityFallbacks);
  assert.equal(result.degradesQuality, true);
  assert.ok(result.applied.includes('context-reduction'));
  assert.equal(result.applied.includes('resolution-downscale'), false);
  assert.equal(result.applied.includes('vae-tiling'), false);
});

test('appliesToからllmを外した退避は選ばれない', () => {
  const smallGpu = { ...gpu, vramGB: 2 };
  const baseline = pickFallbacks(smallGpu, model, quant, model.nativeContextTokens, REAL_CATALOG.assumptions, REAL_CATALOG.qualityFallbacks);
  assert.equal(baseline.applied.at(-1), 'context-reduction');
  for (const id of baseline.applied) {
    const fallbacks = clone(REAL_CATALOG.qualityFallbacks);
    fallbacks.find((item) => item.id === id).appliesTo = ['diffusion'];
    const result = pickFallbacks(smallGpu, model, quant, model.nativeContextTokens, REAL_CATALOG.assumptions, fallbacks);
    assert.deepEqual(result.applied, baseline.applied.filter((item) => item !== id));
  }
});

test('閾値検出は512pxから走査して最初の劣化解像度を返す', () => {
  const result = detectQualityThreshold({ ...gpu, vramGB: 12 }, REAL_CATALOG.diffusionModels[1], REAL_CATALOG.assumptions);
  assert.equal(result.confidence, 'estimated');
  assert.ok(result.thresholdPixels === null || result.thresholdPixels >= 512);
  if (result.thresholdPixels) assert.equal(result.thresholdPixels % 128, 0);
});

test('走査範囲で劣化しなければnullと理由を返す', () => {
  const result = detectQualityThreshold({ ...gpu, vramGB: 256 }, REAL_CATALOG.diffusionModels[0], REAL_CATALOG.assumptions);
  assert.equal(result.thresholdPixels, null);
  assert.match(result.reason, /画質劣化/u);
  assert.equal(result.confidence, 'estimated');
});

test('Markdownは未実測と推定を明記する', () => {
  const report = buildReport(REAL_CATALOG);
  const markdown = renderMarkdown(REAL_CATALOG, report);
  assert.match(markdown, /未実測/u);
  assert.match(markdown, /推定/u);
  assert.match(markdown, /GPU負荷（使用率・温度）は画質を落とさない/u);
  assert.match(markdown, /ネイティブ文脈長/u);
  assert.match(markdown, /必要GB\(8k文脈\)/u);
  for (const row of report.llmMatrix) {
    const rowGpu = REAL_CATALOG.gpus.find((item) => item.id === row.gpuId);
    const rowModel = REAL_CATALOG.models.find((item) => item.id === row.modelId);
    const rowQuant = REAL_CATALOG.quants.find((item) => item.id === row.quantId);
    const expected = llmVramGB(rowGpu, rowModel, rowQuant, 8192, REAL_CATALOG.assumptions).requiredGB;
    assert.equal(row.required8kGB, expected);
    assert.ok(row.required8kGB < row.requiredGB);
    const section = markdown.split(`### ${rowModel.name}\n`)[1].split('\n### ')[0];
    const line = section.split('\n').find((item) => item.startsWith(`| ${rowGpu.name} | ${rowQuant.label} |`));
    assert.ok(line?.endsWith(`| ${expected.toFixed(1)} |`));
  }
});

test('--checkは実生成物と一致する', () => {
  const result = invoke({ repo: REAL_REPO, check: true });
  assert.equal(result.code, 0, result.err);
});

test('--checkはCRLFだけの差をdriftと判定しない', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-llm-vram-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const catalogPath = path.join(repo, 'tools', 'local-llm-vram-catalog.json');
  const docPath = path.join(repo, 'docs', 'local-llm-vram-bench.md');
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(REAL_CATALOG), 'utf8');
  const markdown = renderMarkdown(REAL_CATALOG, buildReport(REAL_CATALOG));
  fs.writeFileSync(docPath, markdown.replace(/\n/gu, '\r\n'), 'utf8');
  const result = invoke({ repo, check: true });
  assert.equal(result.code, 0, result.err);
});

test('不正引数相当はusageを出して1を返す', () => {
  const result = invoke({ repo: REAL_REPO, invalidArgs: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /使用法/u);
});
