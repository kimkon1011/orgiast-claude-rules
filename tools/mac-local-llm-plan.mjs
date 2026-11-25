#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERIFY = new Set(['primary', 'media', 'assumed', 'unknown']);
const ASSUMPTION_KEYS = ['kvBytesPerElement', 'osOverheadGB', 'computeOverheadRatio', 'usableMemoryRatio', 'bandwidthEfficiencyMin', 'bandwidthEfficiencyMax', 'depreciationMonths', 'electricityYenPerKWh', 'loadWatts', 'hoursPerDay', 'daysPerMonth'];

export const round1 = (value) => Math.round(value * 10) / 10;
const weightGB = (paramsB, bitsPerWeight) => paramsB * bitsPerWeight / 8;
const kvGB = (model, contextTokens, assumptions) => 2 * model.layers * model.kvHeads * model.headDim * assumptions.kvBytesPerElement * contextTokens / 1e9;
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const yen = (value) => value === null ? '-' : Math.round(value).toLocaleString('ja-JP');
const one = (value) => round1(value).toFixed(1);

export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog はオブジェクトでなければなりません'];
  if (catalog.version !== 1) errors.push('version は 1 でなければなりません');
  if (!nonEmpty(catalog.updatedAt) || !/^\d{4}-\d{2}-\d{2}$/u.test(catalog.updatedAt)) errors.push('updatedAt は YYYY-MM-DD 形式でなければなりません');
  for (const key of ['machines', 'models', 'quants', 'cloudReferences']) if (!Array.isArray(catalog[key])) errors.push(`${key} は配列でなければなりません`);
  if (errors.length) return errors;
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
  ids(catalog.machines, 'machine', (item, index) => {
    for (const key of ['name', 'chip']) if (!nonEmpty(item[key])) errors.push(`machine[${index}].${key} は非空文字列でなければなりません`);
    if (!positive(item.maxMemoryGB)) errors.push(`machine[${index}].maxMemoryGB は正の数でなければなりません`);
    if (!positive(item.memoryBandwidthGBs)) errors.push(`machine[${index}].memoryBandwidthGBs は正の数でなければなりません`);
    if (!(item.priceYen === null || positive(item.priceYen))) errors.push(`machine[${index}].priceYen は null または正の数でなければなりません`);
    for (const key of ['specVerify', 'priceVerify']) if (!VERIFY.has(item[key])) errors.push(`machine[${index}].${key} は既知の出典区分でなければなりません`);
  });
  ids(catalog.models, 'model', (item, index) => {
    if (!nonEmpty(item.name)) errors.push(`model[${index}].name は非空文字列でなければなりません`);
    if (!positive(item.paramsB)) errors.push(`model[${index}].paramsB は正の数でなければなりません`);
    for (const key of ['layers', 'kvHeads', 'headDim', 'nativeContextTokens']) if (!Number.isInteger(item[key]) || item[key] <= 0) errors.push(`model[${index}].${key} は正の整数でなければなりません`);
    if (!VERIFY.has(item.shapeVerify)) errors.push(`model[${index}].shapeVerify は既知の出典区分でなければなりません`);
  });
  ids(catalog.quants, 'quant', (item, index) => {
    if (!positive(item.bitsPerWeight)) errors.push(`quant[${index}].bitsPerWeight は正の数でなければなりません`);
  });
  if (!catalog.assumptions || typeof catalog.assumptions !== 'object' || Array.isArray(catalog.assumptions)) errors.push('assumptions はオブジェクトでなければなりません');
  else for (const key of ASSUMPTION_KEYS) {
    const value = catalog.assumptions[key];
    const valid = key === 'computeOverheadRatio' ? typeof value === 'number' && value >= 0 && value < 1 : key === 'usableMemoryRatio' ? typeof value === 'number' && value > 0 && value <= 1 : positive(value);
    if (!valid) errors.push(`assumptions.${key} は有効な正の数でなければなりません`);
  }
  return errors;
}

export function computeFit(machine, model, quant, assumptions) {
  const weights = weightGB(model.paramsB, quant.bitsPerWeight);
  const kv = kvGB(model, model.nativeContextTokens, assumptions);
  const requiredGB = weights * (1 + assumptions.computeOverheadRatio) + kv + assumptions.osOverheadGB;
  const usableGB = machine.maxMemoryGB * assumptions.usableMemoryRatio;
  return { weightGB: weights, kvGB: kv, requiredGB, usableGB, fits: requiredGB <= usableGB, headroomGB: usableGB - requiredGB };
}

export function estimateThroughput(machine, model, quant, assumptions) {
  const weights = weightGB(model.paramsB, quant.bitsPerWeight);
  return { low: machine.memoryBandwidthGBs * assumptions.bandwidthEfficiencyMin / weights, high: machine.memoryBandwidthGBs * assumptions.bandwidthEfficiencyMax / weights };
}

export function computeEconomics(machine, assumptions, reference = null) {
  const electricityYenPerMonth = assumptions.loadWatts / 1000 * assumptions.hoursPerDay * assumptions.daysPerMonth * assumptions.electricityYenPerKWh;
  if (machine.priceYen === null) return { electricityYenPerMonth, monthlyOwnershipYen: null, threeYearYen: null, breakEvenMtokPerMonth: null };
  const monthlyOwnershipYen = machine.priceYen / assumptions.depreciationMonths + electricityYenPerMonth;
  const unitPrice = reference?.yenPerMillionOutputTokens;
  return { electricityYenPerMonth, monthlyOwnershipYen, threeYearYen: machine.priceYen + electricityYenPerMonth * 36, breakEvenMtokPerMonth: positive(unitPrice) ? monthlyOwnershipYen / unitPrice : null };
}

function buildReport(catalog) {
  const fits = [];
  for (const model of catalog.models) for (const machine of catalog.machines) for (const quant of catalog.quants) {
    fits.push({ machineId: machine.id, modelId: model.id, quantId: quant.id, ...computeFit(machine, model, quant, catalog.assumptions), throughput: estimateThroughput(machine, model, quant, catalog.assumptions) });
  }
  const verdicts = catalog.models.map((model) => {
    const candidates = fits.filter((fit) => fit.modelId === model.id && fit.fits);
    const verdict = candidates.length === 0 ? '動かない' : candidates.every((fit) => fit.throughput.high < 20) ? 'バッチ向け' : '対話可';
    return { modelId: model.id, modelName: model.name, verdict };
  });
  const economics = catalog.machines.map((machine) => ({ machineId: machine.id, ...computeEconomics(machine, catalog.assumptions, catalog.cloudReferences[0]) }));
  return { machines: catalog.machines, models: catalog.models, fits, verdicts, economics };
}

function renderMarkdown(catalog, report) {
  const a = catalog.assumptions;
  const find = (machineId, modelId, quantId = 'q4_k_m') => report.fits.find((fit) => fit.machineId === machineId && fit.modelId === modelId && fit.quantId === quantId);
  // 判定表・結論の「動く機械」は Q4_K_M で収容できる組み合わせだけを対象にする（他の量子化で動いても実用構成の代表は Q4_K_M）。
  const q4Machines = (modelId) => catalog.machines
    .map((machine) => ({ machine, fit: find(machine.id, modelId) }))
    .filter(({ fit }) => fit?.fits === true);
  const runningMachines = (modelId) => {
    const candidates = q4Machines(modelId);
    return candidates.length === 0
      ? '動く機械なし'
      : candidates.map(({ machine, fit }) => `${machine.name} ${one(fit.throughput.high)}`).join(' / ');
  };
  const conclusionMachine = (modelId) => {
    const candidates = q4Machines(modelId);
    if (candidates.length === 0) return '動く機械なし';
    // 判定表はカタログ順のまま、結論の「以上」は価格が最も安い候補を起点にする。
    const { machine, fit } = candidates.reduce((cheapest, candidate) =>
      (candidate.machine.priceYen ?? Infinity) < (cheapest.machine.priceYen ?? Infinity) ? candidate : cheapest);
    // 最安候補が最上位機しかない場合は「のみ」と書き、その tok/s 上限も併記する（選択肢が1つしかないことを読み手に伝える）。
    return candidates.length === 1
      ? `${machine.name} のみ・推定上限 ${one(fit.throughput.high)} tok/s`
      : `${machine.name} 以上`;
  };
  const lines = [
    '# Mac ローカルLLM環境 導入可否評価（P-0114）', '',
    '> このファイルは生成物。手で編集しない。再生成: `node tools/mac-local-llm-plan.mjs --write`',
    `> 台帳: \`tools/mac-local-llm-catalog.json\`（更新: ${catalog.updatedAt}）`,
    '> 出典区分: `primary`=一次情報で確認 / `media`=報道ベース（二次） / `assumed`=前提値（要実測）',
    '> **実測していない値（tok/s・電気代・実売価格）は推定であり、断定ではない。**', '',
    '## 結論', '',
    `- モデル別判定: ${report.verdicts.map((item) => `${item.modelName}「${item.verdict}」（${conclusionMachine(item.modelId)}）`).join('、')}。`,
    '- つまり 70B 級を動かすには 21.4 tok/s 推定・94.98 万円〜の Mac Studio M5 Ultra しか選択肢がなく、「開発チームに配備してスピード向上」の費用対効果はこの 1 点で決まる。',
    '- 上記の「しか選択肢がなく」は Llama-3.3-70B-Instruct のネイティブ文脈長・Q4_K_M 条件を指す。Qwen2.5-72B-Instruct は文脈長が異なり、Mac Studio (M5 Max) でも収容可能という推定。',
    '- ネイティブ文脈長では、32B級Q4_K_Mは64GB以上、Llama-3.3-70B-Instruct Q4_K_Mはこの台帳上512GB機だけが収容可能という推定で、32GB機は8B級に限られる。',
    '- ローカル LLM は**フロンティアモデルの代替にはならない**。開発スピード向上に効く主用途は対話的なコーディングではなく、**大量バッチ処理・機密データ・オフライン**である。',
    '- tok/s、電気代、価格は未実測であり、購入前に候補機でのベンチマークと見積取得が必要。', '',
    '## サマリ表', '', '| 機械 | Qwen3-32B Q4_K_M | Llama-3.3-70B Q4_K_M |', '|---|---|---|',
    ...catalog.machines.map((machine) => `| ${machine.name} | ${summary(find(machine.id, 'qwen3-32b'))} | ${summary(find(machine.id, 'llama-3.3-70b'))} |`), '',
    '## 前提値（assumed）', '', '| 項目 | 値 | 検証状態 |', '|---|---:|---|',
    ...ASSUMPTION_KEYS.map((key) => `| ${key} | ${a[key]} | assumed（実測ではない） |`), '',
    '## ハードウェア台帳', '', '| id | 名称 | チップ | 最大メモリGB | 帯域GB/s | 価格円 | specVerify | priceVerify | availability |', '|---|---|---|---:|---:|---:|---|---|---|',
    ...catalog.machines.map((m) => `| ${m.id} | ${m.name} | ${m.chip} | ${m.maxMemoryGB} | ${m.memoryBandwidthGBs} | ${yen(m.priceYen)} | ${m.specVerify} | ${m.priceVerify} | ${m.availability} |`), '',
    '## モデル台帳', '', '| id | 名称 | パラメータ数B | 層 | KVヘッド | head_dim | ネイティブ文脈長 | shapeVerify | 出典 URL |', '|---|---|---:|---:|---:|---:|---:|---|---|',
    ...catalog.models.map((m) => `| ${m.id} | ${m.name} | ${m.paramsB} | ${m.layers} | ${m.kvHeads} | ${m.headDim} | ${m.nativeContextTokens} | ${m.shapeVerify} | ${m.shapeSource} |`), '',
    '## 実行可能性マトリクス', ''
  ];
  for (const model of catalog.models) {
    lines.push(`### ${model.name}`, '', '| 機械 | 量子化 | 必要メモリGB | 実効上限GB | 判定 | 余裕GB | 推定tok/s帯 |', '|---|---|---:|---:|---|---:|---:|');
    for (const machine of catalog.machines) for (const quant of catalog.quants) {
      const fit = find(machine.id, model.id, quant.id);
      // 収容できない構成に理論帯域値を併記すると「その速度で動く」と誤読されるため、動かない行は tok/s を出さない。
      lines.push(`| ${machine.name} | ${quant.label} | ${one(fit.requiredGB)} | ${one(fit.usableGB)} | ${fit.fits ? '動く' : '動かない'} | ${one(fit.headroomGB)} | ${fit.fits ? `${one(fit.throughput.low)}–${one(fit.throughput.high)}（推定）` : '-'} |`);
    }
    lines.push('');
  }
  lines.push('## 経済性', '', '| 機械 | CAPEX円 | 電気代/月円 | 電気代/年円 | 月次保有コスト円 | 3年TCO円 | 損益分岐M tok/月 |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const machine of catalog.machines) {
    const econ = report.economics.find((item) => item.machineId === machine.id);
    lines.push(`| ${machine.name} | ${yen(machine.priceYen)} | ${yen(econ.electricityYenPerMonth)} | ${yen(econ.electricityYenPerMonth * 12)} | ${yen(econ.monthlyOwnershipYen)} | ${yen(econ.threeYearYen)} | - |`);
  }
  lines.push('', '- 価格は報道値であり、各行の構成価格とは限らない。特にMac Studioは最安構成価格を使った下限値で、128GB/512GB構成の実価格ではない。', '- M5 Ultra 512GB構成の価格は未取得。上表の949,800円とそれに基づく経済性は最安構成の下限値である。', '- **単価が未取得のため損益分岐は算出不能**。推測値では補完しない。', '',
    '## 判定（この構成で「開発スピードが上がるか」）', '', '| モデル | verdict | 動く機械（推定tok/s上限） |', '|---|---|---|', ...report.verdicts.map((v) => `| ${v.modelName} | ${v.verdict} | ${runningMachines(v.modelId)} |`), '',
    '「動く機械」は Q4_K_M で収容できる機械だけをカタログ順に並べ、括弧内はその機械での推定上限 tok/s。', '',
    '20 tok/sを「人が待たされない対話」の判定目安とする。これは実測値でも絶対基準でもなく、業界一般の目安である。モデル判定は、動く構成がなければ「動かない」、動く全構成の推定上限が20 tok/s未満なら「バッチ向け」、それ以外を「対話可」とした。', '',
    '- 向く: 大量バッチ分類・抽出、機密データのローカル処理、オフライン/ネットワーク制限環境',
    '- 向かない: フロンティアモデル並みの品質が要るエージェント的コーディング、長文脈の高精度推論',
    '- 調達リスク: 世界的なメモリ不足で512GB構成は2026年10月後半まで提供されない（報道ベースで未検証）', '',
    '## 未検証（実測が必要なもの）', '', '- 実 tok/s', '- 実売価格（報道ベース）', '- 512GB構成の価格と提供時期', '- 電気代の実測', '- クラウド単価（損益分岐に必須）', '',
    '## 出典', '', '### 一次', '', '- Apple 日本公式スペックページ（2026-09-19取得。カタログのハードウェア仕様）', ...catalog.models.map((m) => `- ${m.name}: ${m.shapeSource}`), '', '### 二次', '', '- 2026-08-25発表の報道（価格・発売時期・メモリ供給状況）', '');
  return `${lines.join('\n')}\n`;
}

function summary(fit) { return `${fit.fits ? '動く' : '動かない'} / ${one(fit.throughput.low)}–${one(fit.throughput.high)} tok/s（推定）`; }

export function runPlan(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'mac-local-llm-catalog.json');
  const docPath = options.docPath || path.join(repo, 'docs', 'mac-local-llm-plan.md');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(errors.join('\n'));
    const report = buildReport(catalog);
    const markdown = renderMarkdown(catalog, report);
    if (options.check) {
      // Windows の checkout は CRLF になり得るため、内容が同じ文書を改行差だけで drift と誤判定しない。
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/mac-local-llm-plan.md が古い。node tools/mac-local-llm-plan.mjs --write で再生成');
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
    process.stderr.write(`使用法: node tools/mac-local-llm-plan.mjs [--write|--check|--json]\n不正な引数です: ${unknown.join(', ') || 'モードは1つだけ指定してください'}\n`);
    process.exitCode = 1;
  } else process.exitCode = runPlan({ write: args.includes('--write'), check: args.includes('--check'), json: args.includes('--json') });
}
