#!/usr/bin/env node
/** 全4 Phaseを順番に実行するマスターオーケストレータ */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRunIndex = args.indexOf('--dry-run');
const gscIndex = args.indexOf('--gsc-csv');
const dryRunDir = dryRunIndex >= 0 ? args[dryRunIndex + 1] : null;
const gscCsv = gscIndex >= 0 ? args[gscIndex + 1] : null;

if (dryRunIndex >= 0 && (!dryRunDir || dryRunDir.startsWith('--'))) {
  console.error('使用法: node run.mjs [--dry-run <outdir>] [--gsc-csv <path>]');
  process.exit(1);
}
if (gscIndex >= 0 && (!gscCsv || gscCsv.startsWith('--'))) {
  console.error('--gsc-csvにはCSVパスが必要です');
  process.exit(1);
}

const phases = [
  { number: 1, name: 'サイトクロール', script: 'phase1-crawl.mjs' },
  { number: 2, name: 'キーワード収集・統合', script: 'phase2-collect.mjs' },
  { number: 3, name: '評価・優先順位付け', script: 'phase3-score.mjs' },
  { number: 4, name: 'コンテンツ提案生成', script: 'phase4-propose.mjs' },
];

const startedAt = Date.now();
for (const phase of phases) {
  console.log(`\n=== Phase ${phase.number}: ${phase.name} ===`);
  const phaseArgs = [path.join(root, 'process', phase.script)];
  if (dryRunDir) phaseArgs.push('--dry-run', path.resolve(dryRunDir));
  if (phase.number === 2 && gscCsv) phaseArgs.push('--gsc-csv', path.resolve(gscCsv));
  const result = spawnSync(process.execPath, phaseArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`Phase ${phase.number} でエラーが発生したため停止します。`);
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
}

console.log(`\n全 Phase 完了（実行時間: ${((Date.now() - startedAt) / 1000).toFixed(1)}秒）`);
