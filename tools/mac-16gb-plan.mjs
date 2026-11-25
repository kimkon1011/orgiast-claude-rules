#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeEconomics, computeFit, estimateThroughput, round1, validateCatalog } from './mac-local-llm-plan.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSUMPTION_KEYS = ['kvBytesPerElement', 'osOverheadGB', 'computeOverheadRatio', 'usableMemoryRatio', 'bandwidthEfficiencyMin', 'bandwidthEfficiencyMax', 'depreciationMonths', 'electricityYenPerKWh', 'loadWatts', 'hoursPerDay', 'daysPerMonth'];
const one = (value) => round1(value).toFixed(1);
const yen = (value) => value === null ? '-' : Math.round(value).toLocaleString('ja-JP');

export function computeMaxContext(machine, model, quant, assumptions) {
  const usableGB = machine.maxMemoryGB * assumptions.usableMemoryRatio;
  const weightsGB = model.paramsB * quant.bitsPerWeight / 8;
  const availGB = usableGB - assumptions.osOverheadGB - weightsGB * (1 + assumptions.computeOverheadRatio);
  const kvPerTokenGB = 2 * model.layers * model.kvHeads * model.headDim * assumptions.kvBytesPerElement / 1e9;
  if (availGB <= 0) return null;
  const maxContextTokens = Math.min(model.nativeContextTokens, Math.floor(availGB / kvPerTokenGB));
  return { maxContextTokens, fitsAtNative: maxContextTokens >= model.nativeContextTokens, kvPerTokenGB };
}

function buildReport(catalog) {
  const configurations = [];
  for (const machine of catalog.machines) for (const model of catalog.models) for (const quant of catalog.quants) {
    configurations.push({ machineId: machine.id, modelId: model.id, quantId: quant.id, fit: computeFit(machine, model, quant, catalog.assumptions), maxContext: computeMaxContext(machine, model, quant, catalog.assumptions), throughput: estimateThroughput(machine, model, quant, catalog.assumptions) });
  }
  const economics = catalog.machines.map((machine) => ({ machineId: machine.id, ...computeEconomics(machine, catalog.assumptions, catalog.cloudReferences[0]) }));
  return { machines: catalog.machines, models: catalog.models, quants: catalog.quants, configurations, economics };
}

function renderMarkdown(catalog, report) {
  const runnable = report.configurations.filter((item) => item.maxContext !== null);
  const q4 = runnable.filter((item) => item.quantId === 'q4_k_m');
  const modelName = (id) => catalog.models.find((item) => item.id === id).name;
  const machineName = (id) => catalog.machines.find((item) => item.id === id).name;
  const quantName = (id) => catalog.quants.find((item) => item.id === id).label;
  const lines = [
    '# 16GB Mac ローカルLLM実行可能性・ベンチマーク見積り（P-0120）', '',
    '> このファイルは生成物。手で編集しない。再生成: `node tools/mac-16gb-plan.mjs --write`',
    `> 台帳: \`tools/mac-16gb-catalog.json\`（更新: ${catalog.updatedAt}）`,
    '> 出典区分: `primary`=一次情報で確認 / `media`=報道または既存台帳 / `assumed`=前提値 / `unknown`=未取得',
    '> **tok/s・価格は推定または取得時点の値であり、実機での性能・現在の実売価格を断定するものではない。**', '',
    '## 結論', '',
    `- 16GB Macでは、この前提下でQ4_K_Mの ${new Set(q4.map((item) => item.modelId)).size} モデルが文脈を短縮すれば収容可能。特にQwen3-1.7BとQwen2.5-3B-Instructは軽量なため実用候補である。`,
    '- 既に手元に16GB Macがあり、下表の推定tok/sと最大文脈で足りる分類・抽出・要約・オフライン処理なら、P-0114の94.98万円〜のMac Studioを買わずに済む可能性がある。これは理論見積りであり、購入判断前に実測が必要。',
    '- 長文脈や8B以上、フロンティアモデル相当の品質が必要な用途の代替とはみなさない。新品購入では、モデル品質・必要文脈・実測速度とクラウド費用を比較してから判断する。', '',
    '## 16GBで動く構成の一覧', '',
    '| 機種 | モデル | 量子化 | 最大文脈token | ネイティブ文脈 | 推定tok/s帯 |', '|---|---|---|---:|---|---:|',
    ...runnable.map((item) => `| ${machineName(item.machineId)} | ${modelName(item.modelId)} | ${quantName(item.quantId)} | ${item.maxContext.maxContextTokens.toLocaleString('ja-JP')} | ${item.fit.fits ? '収まる' : '収まらない'} | ${one(item.throughput.low)}–${one(item.throughput.high)}（推定） |`), '',
    '## 文脈長テーブル', '',
    '| 機種 | モデル | 量子化 | 最大文脈token | ネイティブで収まるか（computeFit） | 推定tok/s帯 |', '|---|---|---|---:|---|---:|',
    ...report.configurations.map((item) => `| ${machineName(item.machineId)} | ${modelName(item.modelId)} | ${quantName(item.quantId)} | ${item.maxContext ? item.maxContext.maxContextTokens.toLocaleString('ja-JP') : '-'} | ${item.fit.fits ? 'はい' : 'いいえ'} | ${item.maxContext ? `${one(item.throughput.low)}–${one(item.throughput.high)}（推定）` : '-'} |`), '',
    '## 前提値（assumed）', '',
    '| 項目 | 値 | 検証状態 |', '|---|---:|---|',
    ...ASSUMPTION_KEYS.map((key) => `| ${key} | ${catalog.assumptions[key]} | assumed（実測ではない） |`), '',
    `- **結論を支配する前提:** usableMemoryRatio=${catalog.assumptions.usableMemoryRatio} により16GB中の実効上限を12GBとし、さらに osOverheadGB=${catalog.assumptions.osOverheadGB} を差し引くため、重みとKVキャッシュに使えるのは4GB弱からである。OS実使用量が過大・過小なら最大文脈と収容判定は大きく変わる。`, '',
    '## ハードウェア台帳', '',
    '| id | 名称 | チップ | メモリGB | 帯域GB/s | 価格円 | specVerify | priceVerify | 出典 |', '|---|---|---|---:|---:|---:|---|---|---|',
    ...catalog.machines.map((item) => `| ${item.id} | ${item.name} | ${item.chip} | ${item.maxMemoryGB} | ${item.memoryBandwidthGBs} | ${yen(item.priceYen)} | ${item.specVerify} | ${item.priceVerify} | ${item.specSource} / ${item.priceSource} |`), '',
    '## モデル台帳', '',
    '| id | 名称 | params B | 層 | KVヘッド | head_dim | ネイティブ文脈 | shapeVerify | 出典 |', '|---|---|---:|---:|---:|---:|---:|---|---|',
    ...catalog.models.map((item) => `| ${item.id} | ${item.name} | ${item.paramsB} | ${item.layers} | ${item.kvHeads} | ${item.headDim} | ${item.nativeContextTokens.toLocaleString('ja-JP')} | ${item.shapeVerify} | ${item.shapeSource} |`), '',
    '## 経済性', '',
    '| 機種 | CAPEX円 | 電気代/月円 | 月次保有円 | 3年TCO円 | 損益分岐M token/月 |', '|---|---:|---:|---:|---:|---:|',
    ...catalog.machines.map((machine) => { const e = report.economics.find((item) => item.machineId === machine.id); return `| ${machine.name} | ${yen(machine.priceYen)} | ${yen(e.electricityYenPerMonth)} | ${yen(e.monthlyOwnershipYen)} | ${yen(e.threeYearYen)} | - |`; }), '',
    '- **クラウド単価未取得のため損益分岐は算出不能**。推測では補完しない。手元の16GB機を再利用する場合、追加CAPEXは0円だが、表は各機の取得価格を使う。', '',
    '## 未検証（実測が必要なもの）', '',
    '- 実機・実ランタイム・実プロンプトでのtok/sと出力品質',
    '- 現在の新品・中古実売価格',
    '- `osOverheadGB: 8` と `usableMemoryRatio: 0.75`（実効12GBのうちOSに8GBを割り当てる支配的な仮定）',
    '- クラウド出力単価と実際の月間token量',
    '- Gemma 3 4Bはconfig.jsonが未認証取得で401となったため台帳から除外。M1 AirはApple一次情報で帯域を確認できなかったため除外。', '',
    '## 出典', '', '### 一次', '',
    '- Apple「Mac mini (2024) 技術仕様」: https://support.apple.com/ja-jp/121555',
    '- Apple「M4搭載Mac mini発表」: https://www.apple.com/jp/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/',
    '- Apple「MacBook Air (13-inch, M4, 2025) 技術仕様」: https://support.apple.com/ja-jp/122209',
    '- Apple「M4搭載MacBook Air発表」: https://www.apple.com/jp/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/',
    ...catalog.models.map((item) => `- ${item.name}: ${item.shapeSource}`), '',
    '### 二次・既存台帳', '',
    '- M6 Mac miniの価格・帯域: `tools/mac-local-llm-catalog.json`（P-0114で検証済みの値を踏襲）', ''
  ];
  return `${lines.join('\n')}\n`;
}

export function runPlan(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'mac-16gb-catalog.json');
  const docPath = options.docPath || path.join(repo, 'docs', 'mac-16gb-plan.md');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(errors.join('\n'));
    const report = buildReport(catalog);
    const markdown = renderMarkdown(catalog, report);
    if (options.check) {
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/mac-16gb-plan.md が古い。node tools/mac-16gb-plan.mjs --write で再生成');
    } else if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (options.write) { fs.mkdirSync(path.dirname(docPath), { recursive: true }); fs.writeFileSync(docPath, markdown.replace(/\r\n/gu, '\n'), 'utf8'); }
    else stdout.write(markdown);
    return 0;
  } catch (error) { stderr.write(`${error.message}\n`); return 1; }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--write', '--check', '--json']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length || args.length > 1) { process.stderr.write(`使用法: node tools/mac-16gb-plan.mjs [--write|--check|--json]\n不正な引数です: ${unknown.join(', ') || 'モードは1つだけ指定してください'}\n`); process.exitCode = 1; }
  else process.exitCode = runPlan({ write: args.includes('--write'), check: args.includes('--check'), json: args.includes('--json') });
}
