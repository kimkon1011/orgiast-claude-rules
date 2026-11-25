#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERIFY = new Set(['primary', 'media', 'assumed', 'unknown']);
const QUALITY = new Set(['none', 'low', 'medium', 'high']);
const FALLBACK_TARGETS = new Set(['llm', 'diffusion']);
const ASSUMPTION_KEYS = ['vramBytesPerElement', 'runtimeOverheadRatio', 'usableVramRatio', 'osVramReserveGB', 'diffusionOverheadRatio', 'vaeTileThresholdGB', 'offloadSpeedPenaltyMin', 'offloadSpeedPenaltyMax', 'fp8VramRatio', 'nf4VramRatio'];
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const valueOf = (assumptions, key) => assumptions[key]?.value ?? assumptions[key];
const one = (value) => Number(value).toFixed(1);
const maxImpact = (values) => ['none', 'low', 'medium', 'high'].reduce((max, item) => values.includes(item) ? item : max, 'none');

export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog はオブジェクトでなければなりません'];
  if (catalog.version !== 1) errors.push('version は 1 でなければなりません');
  if (!nonEmpty(catalog.updatedAt) || !/^\d{4}-\d{2}-\d{2}$/u.test(catalog.updatedAt)) errors.push('updatedAt は YYYY-MM-DD 形式でなければなりません');
  const arrayKeys = ['quants', 'gpus', 'models', 'diffusionModels', 'qualityFallbacks', 'sources'];
  for (const key of arrayKeys) if (!Array.isArray(catalog[key])) errors.push(`${key} は配列でなければなりません`);
  if (arrayKeys.some((key) => !Array.isArray(catalog[key]))) return errors;
  const ids = (items, label, check) => {
    const seen = new Set();
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label}[${index}] はオブジェクトでなければなりません`); return; }
      if (!nonEmpty(item.id)) errors.push(`${label}[${index}].id は非空文字列でなければなりません`);
      else if (seen.has(item.id)) errors.push(`${label} id が重複しています: ${item.id}`);
      else seen.add(item.id);
      check(item, index);
    });
  };
  ids(catalog.quants, 'quant', (item, index) => {
    if (!nonEmpty(item.label)) errors.push(`quant[${index}].label は非空文字列でなければなりません`);
    if (!positive(item.bitsPerWeight)) errors.push(`quant[${index}].bitsPerWeight は正の数でなければなりません`);
    if (!QUALITY.has(item.qualityImpact)) errors.push(`quant[${index}].qualityImpact は既知の区分でなければなりません`);
    if (!VERIFY.has(item.verify)) errors.push(`quant[${index}].verify は既知の出典区分でなければなりません`);
  });
  ids(catalog.gpus, 'gpu', (item, index) => {
    if (!nonEmpty(item.name)) errors.push(`gpu[${index}].name は非空文字列でなければなりません`);
    if (typeof item.vramGB !== 'number' || !Number.isFinite(item.vramGB) || item.vramGB < 0) errors.push(`gpu[${index}].vramGB は0以上の数でなければなりません`);
    if (!VERIFY.has(item.specVerify)) errors.push(`gpu[${index}].specVerify は既知の出典区分でなければなりません`);
  });
  ids(catalog.models, 'model', (item, index) => {
    if (!nonEmpty(item.name) || !positive(item.paramsB)) errors.push(`model[${index}] のname/paramsBが不正です`);
    if (!(item.activeParamsB === null || positive(item.activeParamsB))) errors.push(`model[${index}].activeParamsB はnullまたは正の数でなければなりません`);
    for (const key of ['layers', 'kvHeads', 'headDim', 'nativeContextTokens']) if (!Number.isInteger(item[key]) || item[key] <= 0) errors.push(`model[${index}].${key} は正の整数でなければなりません`);
    if (!VERIFY.has(item.shapeVerify)) errors.push(`model[${index}].shapeVerify は既知の出典区分でなければなりません`);
  });
  ids(catalog.diffusionModels, 'diffusionModel', (item, index) => {
    if (!nonEmpty(item.name) || !positive(item.baseVramGB) || !positive(item.vramPerMegapixelGB)) errors.push(`diffusionModel[${index}] のname/VRAM係数が不正です`);
    if (!Array.isArray(item.precisionOptions) || !item.precisionOptions.includes('fp16')) errors.push(`diffusionModel[${index}].precisionOptions はfp16を含む配列でなければなりません`);
    if (!VERIFY.has(item.verify)) errors.push(`diffusionModel[${index}].verify は既知の出典区分でなければなりません`);
  });
  ids(catalog.qualityFallbacks, 'qualityFallback', (item, index) => {
    if (!QUALITY.has(item.qualityImpact)) errors.push(`qualityFallback[${index}].qualityImpact は既知の区分でなければなりません`);
    if (!VERIFY.has(item.verify)) errors.push(`qualityFallback[${index}].verify は既知の出典区分でなければなりません`);
    if (!Array.isArray(item.appliesTo) || item.appliesTo.length === 0) errors.push(`qualityFallback[${index}].appliesTo は非空配列でなければなりません`);
    else {
      if (item.appliesTo.some((target) => !FALLBACK_TARGETS.has(target))) errors.push(`qualityFallback[${index}].appliesTo は既知値のみでなければなりません`);
      if (new Set(item.appliesTo).size !== item.appliesTo.length) errors.push(`qualityFallback[${index}].appliesTo に重複があります`);
    }
  });
  ids(catalog.sources, 'source', (item, index) => { if (!VERIFY.has(item.verify)) errors.push(`source[${index}].verify は既知の出典区分でなければなりません`); });
  if (!catalog.assumptions || typeof catalog.assumptions !== 'object' || Array.isArray(catalog.assumptions)) errors.push('assumptions はオブジェクトでなければなりません');
  else for (const key of ASSUMPTION_KEYS) {
    const entry = catalog.assumptions[key];
    if (!entry || typeof entry !== 'object' || entry.verify !== 'assumed') { errors.push(`assumptions.${key}.verify は assumed でなければなりません`); continue; }
    const value = entry.value;
    const valid = key === 'vaeTileThresholdGB' ? value === null || positive(value) : key.endsWith('Ratio') || key.startsWith('offloadSpeedPenalty') ? positive(value) && value <= 1 : positive(value);
    if (!valid) errors.push(`assumptions.${key}.value は有効な値でなければなりません`);
  }
  return errors;
}

export function llmVramGB(gpu, model, quant, contextTokens, assumptions) {
  const weightGB = model.paramsB * quant.bitsPerWeight / 8;
  const kvGB = 2 * model.layers * model.kvHeads * model.headDim * valueOf(assumptions, 'vramBytesPerElement') * contextTokens / 1e9;
  const overheadGB = weightGB * valueOf(assumptions, 'runtimeOverheadRatio') + valueOf(assumptions, 'osVramReserveGB');
  const requiredGB = weightGB + kvGB + overheadGB;
  const usableVRAMGB = Math.max(0, gpu.vramGB * valueOf(assumptions, 'usableVramRatio') - valueOf(assumptions, 'osVramReserveGB'));
  return { weightGB, kvGB, overheadGB, requiredGB, usableVRAMGB, fits: requiredGB <= usableVRAMGB, shortfallGB: Math.max(0, requiredGB - usableVRAMGB) };
}

export function pickFallbacks(gpu, model, quant, contextTokens, assumptions, qualityFallbacks) {
  const initial = llmVramGB(gpu, model, quant, contextTokens, assumptions);
  const llmFallbacks = new Map(qualityFallbacks.filter((item) => item.appliesTo.includes('llm')).map((item) => [item.id, item]));
  const speedPenalty = { low: valueOf(assumptions, 'offloadSpeedPenaltyMin'), high: valueOf(assumptions, 'offloadSpeedPenaltyMax') };
  if (initial.fits) return { fits: true, applied: [], qualityImpact: 'none', effectiveQuantId: quant.id, degradesQuality: false, speedPenalty };
  const applied = llmFallbacks.has('cpu-offload') ? ['cpu-offload'] : [];
  // requiredGBはモデル全体の要件のまま。offload後はGPU常駐が必要なKV+overheadだけで収容可否を判定する。
  if (initial.kvGB + initial.overheadGB <= initial.usableVRAMGB && gpu.vramGB > 0) return { fits: true, applied, qualityImpact: 'none', effectiveQuantId: quant.id, degradesQuality: false, speedPenalty };
  const candidates = [
    { id: 'precision-downgrade-fp8', quantId: 'q8_0', ratio: 0.6, impact: 'low' },
    { id: 'precision-downgrade-nf4', quantId: 'nf4', ratio: 0.45, impact: 'high' }
  ];
  for (const candidate of candidates) {
    if (!llmFallbacks.has(candidate.id)) continue;
    applied.push(candidate.id);
    if ((initial.weightGB * candidate.ratio + initial.kvGB + initial.overheadGB * candidate.ratio) <= initial.usableVRAMGB) return { fits: true, applied, qualityImpact: candidate.impact, effectiveQuantId: candidate.quantId, degradesQuality: true, speedPenalty };
  }
  const finalFallback = llmFallbacks.get('context-reduction');
  if (finalFallback) applied.push(finalFallback.id);
  return { fits: gpu.vramGB > 0, applied, qualityImpact: finalFallback?.qualityImpact ?? maxImpact(applied.map((id) => llmFallbacks.get(id)?.qualityImpact).filter(Boolean)), effectiveQuantId: 'nf4', degradesQuality: true, speedPenalty };
}

export function diffusionVramGB(diffusionModel, megapixels, precision, batch, assumptions) {
  const ratio = precision === 'fp8' ? valueOf(assumptions, 'fp8VramRatio') : precision === 'nf4' ? valueOf(assumptions, 'nf4VramRatio') : 1;
  return (diffusionModel.baseVramGB + diffusionModel.vramPerMegapixelGB * megapixels * batch) * (1 + valueOf(assumptions, 'diffusionOverheadRatio')) * ratio + valueOf(assumptions, 'osVramReserveGB');
}

function diffusionFallback(gpu, model, megapixels, assumptions) {
  const usable = Math.max(0, gpu.vramGB * valueOf(assumptions, 'usableVramRatio') - valueOf(assumptions, 'osVramReserveGB'));
  const fp16 = diffusionVramGB(model, megapixels, 'fp16', 1, assumptions);
  if (fp16 <= usable) return { degradesQuality: false, fallbackId: null };
  // tiling/slicing/offloadでピークを概算55%まで下げられる場合は画質不変とする（推定モデル）。
  if (gpu.vramGB > 0 && fp16 * 0.55 <= usable) return { degradesQuality: false, fallbackId: 'cpu-offload' };
  if (model.precisionOptions.includes('fp8') && diffusionVramGB(model, megapixels, 'fp8', 1, assumptions) <= usable) return { degradesQuality: true, fallbackId: 'precision-downgrade-fp8' };
  if (model.precisionOptions.includes('nf4') && diffusionVramGB(model, megapixels, 'nf4', 1, assumptions) <= usable) return { degradesQuality: true, fallbackId: 'precision-downgrade-nf4' };
  return { degradesQuality: true, fallbackId: 'resolution-downscale' };
}

export function detectQualityThreshold(gpu, diffusionModel, assumptions, options = {}) {
  const start = options.startPixels || 512;
  const end = options.endPixels || 2048;
  const step = options.stepPixels || 128;
  let lastSafe = null;
  for (let pixels = start; pixels <= end; pixels += step) {
    const result = diffusionFallback(gpu, diffusionModel, pixels * pixels / 1e6, assumptions);
    if (result.degradesQuality) {
      if (pixels === start) return { thresholdMegapixels: null, thresholdPixels: null, maxQualitySafePixels: null, firstDegradingFallbackId: result.fallbackId, confidence: 'estimated', reason: '走査開始の512pxから画質劣化を伴う退避が必要' };
      return { thresholdMegapixels: pixels * pixels / 1e6, thresholdPixels: pixels, maxQualitySafePixels: lastSafe, firstDegradingFallbackId: result.fallbackId, confidence: 'estimated' };
    }
    lastSafe = pixels;
  }
  return { thresholdMegapixels: null, thresholdPixels: null, maxQualitySafePixels: lastSafe, firstDegradingFallbackId: null, confidence: 'estimated', reason: '2048pxまで画質劣化を伴う退避なし' };
}

export function buildReport(catalog) {
  const llmMatrix = [];
  for (const gpu of catalog.gpus) for (const model of catalog.models) for (const quant of catalog.quants.filter((item) => item.id !== 'nf4')) {
    const vram = llmVramGB(gpu, model, quant, model.nativeContextTokens, catalog.assumptions);
    const required8kGB = llmVramGB(gpu, model, quant, 8192, catalog.assumptions).requiredGB;
    llmMatrix.push({ gpuId: gpu.id, modelId: model.id, quantId: quant.id, ...vram, required8kGB, fallback: pickFallbacks(gpu, model, quant, model.nativeContextTokens, catalog.assumptions, catalog.qualityFallbacks) });
  }
  const diffusionFootprints = [];
  for (const model of catalog.diffusionModels) for (const pixels of [512, 1024, 1536, 2048]) for (const precision of model.precisionOptions) diffusionFootprints.push({ modelId: model.id, pixels, precision, estimatedGB: diffusionVramGB(model, pixels * pixels / 1e6, precision, 1, catalog.assumptions) });
  const thresholds = catalog.gpus.flatMap((gpu) => catalog.diffusionModels.map((model) => ({ gpuId: gpu.id, modelId: model.id, ...detectQualityThreshold(gpu, model, catalog.assumptions) })));
  return { llmMatrix, fallbacks: catalog.qualityFallbacks, diffusionFootprints, thresholds };
}

export function renderMarkdown(catalog, report) {
  const lines = [
    '# ローカルLLMのメモリ使用とGPU負荷・画質低下閾値（P-0112）', '',
    '> このファイルは生成物。手で編集しない。再生成: `node tools/local-llm-vram-bench.mjs --write`',
    `> 台帳: \`tools/local-llm-vram-catalog.json\`（更新: ${catalog.updatedAt}）`,
    '> 出典区分: `primary`=一次情報 / `media`=二次情報 / `assumed`=仮定 / `unknown`=未取得',
    '> **全数値は推定モデルであり、このセッションでGPU実測はしていない。**', '',
    '## 結論', '',
    '- LLMの推論VRAMは「重み + KVキャッシュ + ランタイムoverhead」で決まり、負荷（消費電力・使用率）はVRAM量を変えない。',
    '- VRAM不足時のCPU offload、attention slicing、sequential offload、VAE tilingは画質に影響せず、遅くなるだけである。',
    '- 画質に影響するのは精度降格（fp16→fp8→NF4）、解像度切下げ、ステップ削減、バッチ分割によるシード再生成である。',
    '- **GPU負荷（使用率・温度）は画質を落とさない。画質が落ちるのは精度降格・解像度切下げ・ステップ削減であり、その境界はVRAM量で決まる。**',
    '- 「画質低下の閾値」は `必要VRAM(解像度・精度・バッチ) > 実効VRAM(GPU VRAM × 使用率係数)` となり、画質劣化を伴う退避が初めて必要になる境界として推定する。',
    '- GPUを占有する実測はこのセッションでは行わず、以下は推定モデル・閾値検出器・再現可能な実測手順である。', '',
    '## 前提値（assumed）', '', '| 項目 | 値 | 検証状態 | 注記 |', '|---|---:|---|---|',
    ...ASSUMPTION_KEYS.map((key) => `| ${key} | ${catalog.assumptions[key].value ?? 'null'} | assumed（実測ではない） | ${catalog.assumptions[key].note} |`), '',
    '## GPU台帳', '', '| id | 名称 | VRAM GB | specVerify | 注記 |', '|---|---|---:|---|---|',
    ...catalog.gpus.map((gpu) => `| ${gpu.id} | ${gpu.name} | ${gpu.vramGB} | ${gpu.specVerify} | ${gpu.note} |`), '',
    '## LLM 実行可能性マトリクス', '',
    '必要GB は各モデルの**ネイティブ文脈長**（例: Llama-3.1-8B は 131,072 tokens）で計算している。KVキャッシュが支配的なため、実運用の文脈長（例 8,192 tokens）に落とすと必要GBは大きく下がる。右端の列に 8,192 tokens での必要GB を併記する。', ''
  ];
  for (const model of catalog.models) {
    lines.push(`### ${model.name}`, '', '| GPU | 量子化 | 必要GB | 実効GB | 直接収容 | 退避後 | 推定tok/s | 必要GB(8k文脈) |', '|---|---|---:|---:|---|---|---:|---:|');
    for (const row of report.llmMatrix.filter((item) => item.modelId === model.id)) {
      const gpu = catalog.gpus.find((item) => item.id === row.gpuId);
      const quant = catalog.quants.find((item) => item.id === row.quantId);
      lines.push(`| ${gpu.name} | ${quant.label} | ${one(row.requiredGB)} | ${one(row.usableVRAMGB)} | ${row.fits ? '収容可' : '収容不可'} | ${row.fallback.applied.join(' → ') || '-'} | - | ${one(row.required8kGB)} |`);
    }
    lines.push('');
  }
  lines.push('収容不可の行は、実測していない速度（tok/s）を表示しない。CPU offload適用後も元の必要VRAM値は変えず、GPU常駐量だけが減る意味論で判定する。', '',
    '## 退避動作と画質への影響', '', '| 動作 | 画質影響 | 速度影響 | 発動条件 |', '|---|---|---|---|',
    ...catalog.qualityFallbacks.map((item) => `| ${item.label} | ${item.qualityImpact === 'none' ? 'none（画質不変）' : `**${item.qualityImpact}（画質低下）**`} | ${item.speedImpact} | ${item.trigger} |`), '',
    '## 画像生成のVRAMフットプリント', '', '| モデル | 解像度 | 精度 | 推定VRAM GB |', '|---|---:|---|---:|',
    ...report.diffusionFootprints.map((row) => `| ${catalog.diffusionModels.find((item) => item.id === row.modelId).name} | ${row.pixels}×${row.pixels} | ${row.precision} | ${one(row.estimatedGB)}（推定） |`), '',
    '## 画質低下の閾値', '', '| GPU | 画像モデル | 閾値px（推定） | 直前の安全px | 最初の劣化退避 | 備考 |', '|---|---|---:|---:|---|---|',
    ...report.thresholds.map((row) => `| ${catalog.gpus.find((item) => item.id === row.gpuId).name} | ${catalog.diffusionModels.find((item) => item.id === row.modelId).name} | ${row.thresholdPixels ?? '-'} | ${row.maxQualitySafePixels ?? '-'} | ${row.firstDegradingFallbackId ?? '-'} | 推定（${row.reason ?? 'estimated'}） |`), '',
    '## 実測手順（次回以降に実測するための手順）', '',
    '1. `nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv -l 1` でVRAM使用量とGPU使用率を1秒間隔で記録する。',
    '2. llama.cppは同一モデル・量子化・プロンプトで `--n-gpu-layers` を段階的に変え、VRAM、生成速度、CPU offload境界を記録する。',
    '3. diffusersは同一モデル・同一seedで通常実行、`enable_model_cpu_offload()`、`enable_sequential_cpu_offload()`、`enable_attention_slicing()` を個別に比較し、必要ならVAE tilingも比較する。',
    '4. fp16、fp8、NF4、解像度、ステップ数を一要因ずつ変え、ピークVRAMと実行時間を記録する。',
    '5. **画質が落ちたかどうかは主観で判定せず、同一シードの画素差分（PSNR/SSIM）で判定する。** バッチ分割でseed対応が変わった場合は別試行として記録する。',
    '6. 推定閾値の前後（128px刻み）を重点測定し、初めてPSNR/SSIMが変化する設定を実測閾値として台帳へ反映する。', '',
    '## 未実測（実測が必要なもの）', '',
    '- GPU別・バックエンド別の実効VRAM比率とランタイムoverhead',
    '- CPU/sequential offload、attention slicing、VAE tilingの実速度低下',
    '- fp8/NF4のVRAM削減率とPSNR/SSIMへの影響',
    '- モデル・解像度・バッチごとのピークVRAMと画質低下閾値',
    '- GPU温度・使用率と速度低下（画質低下ではない）の関係', '',
    '## 出典', '', '### 一次', '', '- 取得済み一次URLなし。', '', '### 二次', '', '- 取得済み二次URLなし。', '', '### 未取得', '',
    ...catalog.sources.map((source) => `- ${source.label}: 出典未取得（${source.note}）`),
    ...catalog.models.map((model) => `- ${model.name} shape: 出典未取得（${model.shapeVerify}）`),
    ...catalog.gpus.map((gpu) => `- ${gpu.name}: 出典未取得（${gpu.specVerify}）`), '');
  return `${lines.join('\n')}\n`;
}

export function runBench(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'local-llm-vram-catalog.json');
  const docPath = options.docPath || path.join(repo, 'docs', 'local-llm-vram-bench.md');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  if ([options.write, options.check, options.json].filter(Boolean).length > 1 || options.invalidArgs) {
    stderr.write('使用法: node tools/local-llm-vram-bench.mjs [--write|--check|--json]\n不正な引数です\n');
    return 1;
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(errors.join('\n'));
    const report = buildReport(catalog);
    const markdown = renderMarkdown(catalog, report);
    if (options.check) {
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/local-llm-vram-bench.md が古い。node tools/local-llm-vram-bench.mjs --write で再生成');
    } else if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (options.write) {
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      fs.writeFileSync(docPath, markdown.replace(/\r\n/gu, '\n'), 'utf8');
    } else stdout.write(markdown);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--write', '--check', '--json']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length || args.length > 1) {
    process.stderr.write(`使用法: node tools/local-llm-vram-bench.mjs [--write|--check|--json]\n不正な引数です: ${unknown.join(', ') || 'モードは1つだけ指定してください'}\n`);
    process.exitCode = 1;
  } else process.exitCode = runBench({ write: args.includes('--write'), check: args.includes('--check'), json: args.includes('--json') });
}
