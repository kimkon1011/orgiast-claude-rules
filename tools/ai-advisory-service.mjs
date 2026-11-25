#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const CATALOG_URL = new URL('./ai-advisory-service-catalog.json', import.meta.url);
const DOC_URL = new URL('../docs/ai-advisory-service-packages.md', import.meta.url);
const DOC_LABEL = 'docs/ai-advisory-service-packages.md';
const USAGE = '使い方: node tools/ai-advisory-service.mjs [--write|--check|--estimate <id,id,...>]';

export function formatYen(n) {
  const [integer, fraction] = String(n).split('.');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}

export function formatDays(n) {
  return String(n);
}

export function priceOf(pkg, dayRateYen) {
  return Math.floor(pkg.effortDays * dayRateYen);
}

export function estimate(catalog, ids) {
  const entries = new Map([
    ...catalog.packages.map((pkg) => [pkg.id, { ...pkg, kind: 'package' }]),
    ...catalog.options.map((option) => [option.id, { ...option, kind: 'option' }]),
  ]);
  const lines = ids.map((id) => {
    const item = entries.get(id);
    if (!item) throw new Error(`未知の id: ${id}`);
    return { id, name: item.name, effortDays: item.effortDays, yen: priceOf(item, catalog.dayRateYen), kind: item.kind };
  });
  return {
    lines,
    totalDays: lines.reduce((sum, line) => sum + line.effortDays, 0),
    totalYen: lines.reduce((sum, line) => sum + line.yen, 0),
  };
}

export function render(catalog) {
  const lines = [
    '<!-- このファイルは tools/ai-advisory-service.mjs --write が生成する。手で編集しない。 -->',
    '# AI導入支援サービスのパッケージ（叩き台）',
    '',
    `> ⚠️ ${catalog.priceStatusNote}`,
    '',
    `- 基準日: ${catalog.priceAsOf}`,
    `- 1人日単価: ${formatYen(catalog.dayRateYen)} 円（${catalog.dayRateBasis}）`,
    `- 算出方法: ${catalog.pricingMethod}`,
    `- 原価: ${catalog.costNote}`,
    `- 状態: ${catalog.priceStatus}`,
    '',
    '## パッケージ一覧',
    '',
    '| id | パッケージ | 標準工数(人日) | 標準価格(円) | 期間 | 主な成果物 |',
    '|---|---|---|---|---|---|',
  ];
  for (const pkg of catalog.packages) {
    const deliverable = pkg.deliverables[0] + (pkg.deliverables.length > 1 ? ` ほか${pkg.deliverables.length - 1}件` : '');
    lines.push(`| ${pkg.id} | ${pkg.name} | ${formatDays(pkg.effortDays)} | ${formatYen(priceOf(pkg, catalog.dayRateYen))} | ${pkg.durationWeeks}週間 | ${deliverable} |`);
  }
  lines.push('', '## パッケージ詳細');
  for (const pkg of catalog.packages) {
    lines.push(
      '', `### ${pkg.id}: ${pkg.name}`, '',
      `- 目的: ${pkg.objective}`,
      `- 対象顧客: ${pkg.targetCustomer}`,
      '- 成果物:', ...pkg.deliverables.map((item) => `  - ${item}`),
      `- 標準工数: ${formatDays(pkg.effortDays)} 人日`,
      `- 標準価格: ${formatYen(priceOf(pkg, catalog.dayRateYen))} 円`,
      `- 期間: ${pkg.durationWeeks}週間`,
      '- 前提:', ...pkg.prerequisites.map((item) => `  - ${item}`),
      '- 除外:', ...pkg.excludes.map((item) => `  - ${item}`),
    );
  }
  lines.push('', '## オプション', '',
    '| id | オプション | 単位 | 追加(人日) | 追加価格(円) | 備考 |',
    '|---|---|---|---|---|---|');
  for (const option of catalog.options) {
    lines.push(`| ${option.id} | ${option.name} | ${option.unit} | ${formatDays(option.effortDays)} | ${formatYen(priceOf(option, catalog.dayRateYen))} | ${option.note} |`);
  }
  lines.push('', '## 見積の出し方', '',
    '`node tools/ai-advisory-service.mjs --estimate assessment,extra-online`');
  return `${lines.join('\n')}\n`;
}

export function main(argv) {
  const isSimple = argv.length === 1 && ['--write', '--check'].includes(argv[0]);
  const isEstimate = argv.length === 2 && argv[0] === '--estimate' && argv[1].trim() !== '' && !argv[1].startsWith('--');
  if (argv.length !== 0 && !isSimple && !isEstimate) {
    console.error(USAGE);
    return 2;
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG_URL, 'utf8'));
  if (argv.length === 0) {
    console.log(`パッケージ ${catalog.packages.length}件 / オプション ${catalog.options.length}件\n1人日単価: ${formatYen(catalog.dayRateYen)} 円 (${catalog.dayRateBasis})\n${catalog.priceStatusNote}`);
    return 0;
  }
  if (argv[0] === '--write') {
    fs.mkdirSync(path.dirname(fileURLToPath(DOC_URL)), { recursive: true });
    fs.writeFileSync(DOC_URL, render(catalog), 'utf8');
    console.log(`生成: ${DOC_LABEL}`);
    return 0;
  }
  if (argv[0] === '--check') {
    let existing;
    try {
      existing = fs.readFileSync(DOC_URL, 'utf8').replace(/\r\n/g, '\n');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing === render(catalog)) {
      console.log(`OK: ${DOC_LABEL} は最新`);
      return 0;
    }
    console.error(`drift: ${DOC_LABEL} が生成物と一致しません。--write で再生成してください。`);
    return 1;
  }
  let result;
  try {
    result = estimate(catalog, argv[1].split(','));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  console.log([
    `見積: ${result.lines[0].name}${result.lines.length > 1 ? ` ほか${result.lines.length - 1}件` : ''}`,
    ...result.lines.map((line) => `- ${line.id} ${line.name}: ${formatDays(line.effortDays)} 人日 / ${formatYen(line.yen)} 円`),
    `合計: ${formatDays(result.totalDays)} 人日 / ${formatYen(result.totalYen)} 円`,
    `※ ${catalog.priceStatusNote}`,
  ].join('\n'));
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
