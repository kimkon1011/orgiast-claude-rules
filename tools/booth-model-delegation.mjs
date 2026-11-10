// generated-by: Sonnet

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROJECT = 'C0057-2027-tokyo-pack';

export const roles = Object.freeze([
  { phase: '企画概要', model: 'Sonnet', agent: 'main' },
  { phase: 'ブース設計企画', model: 'Sonnet', agent: 'main' },
  { phase: '過去事例調査', model: 'Haiku', agent: 'search-agent' },
  { phase: 'コード検索', model: 'Haiku', agent: 'grep-agent' },
  { phase: '成果物監査', model: 'Haiku', agent: 'audit-agent' },
  { phase: '完了前確認', model: 'Opus', agent: 'advisor' },
]);

const templates = Object.freeze([
  ['01_企画概要.md', 'Sonnet', '# 01_企画概要\n\n## 案件概要\n\n新規展示会ブース案件です。顧客情報、会期、小間、予算を確認して企画を具体化します。\n\n## 目的\n\n- 来場者へ提供価値を伝える。\n- 個別相談へつながる動線を設計する。'],
  ['02_ブース設計企画書.md', 'Sonnet', '# 02_ブース設計企画書\n\n## 設計方針\n\n認知、理解、体験、相談の順に来場者が移動できる構成とします。寸法と施工条件は主催者資料の受領後に確定します。'],
  ['03_過去事例調査.md', 'Haiku', '# 03_過去事例調査\n\n## 調査結論\n\n類似案件の構成、動線、リード取得方法を調査し、200字以内の結論をここへ記録します。'],
  ['04_最終確認レポート.md', 'Opus', '# 04_最終確認レポート\n\n## 判定\n\n設計前提、未確定事項、仕様漏れ、重大リスクを確認して完了可否を記録します。'],
]);

export function estimateTokens() {
  const legacy = { mainInput: 18_000, mainOutput: 8_000, delegated: 0 };
  const delegated = { mainInput: 9_000, mainOutput: 4_500, delegated: 5_000 };
  const total = (item) => item.mainInput + item.mainOutput + item.delegated;
  return {
    legacy: { ...legacy, total: total(legacy) },
    delegated: { ...delegated, total: total(delegated) },
    saved: total(legacy) - total(delegated),
    reductionPercent: Number((((total(legacy) - total(delegated)) / total(legacy)) * 100).toFixed(1)),
  };
}

export function initProject(projectName = DEFAULT_PROJECT, baseDir = path.join(repoDir, 'apps', 'expo-apply', 'projects')) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName)) throw new Error('プロジェクト名は英数字、ピリオド、ハイフン、アンダースコアだけを使用してください。');
  const outputDir = path.resolve(baseDir, projectName);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [filename, model, body] of templates) {
    const target = path.join(outputDir, filename);
    if (!fs.existsSync(target)) fs.writeFileSync(target, `<!-- generated-by: ${model} -->\n\n${body}\n`, 'utf8');
  }
  return outputDir;
}

export function demo(projectName = DEFAULT_PROJECT, baseDir) {
  const outputDir = initProject(projectName, baseDir);
  return { outputDir, roles, externalLlmCalls: 0 };
}

function usage() {
  return `使用法: node tools/booth-model-delegation.mjs <モード> [オプション]\n\nモード:\n  --demo                 デモ成果物と役割割当を確認\n  --analyze              トークン消費の推定値を表示\n  --init                 新規プロジェクトを作成\n\nオプション:\n  --project <名前>       プロジェクト名（既定: ${DEFAULT_PROJECT}）\n  --base-dir <パス>      作成先の親ディレクトリ`;
}

function parseArgs(argv) {
  const modes = argv.filter((arg) => ['--demo', '--analyze', '--init'].includes(arg));
  if (argv.includes('--help')) return { help: true };
  if (modes.length !== 1) throw new Error('--demo、--analyze、--init のいずれか1つを指定してください。');
  const options = { mode: modes[0], project: DEFAULT_PROJECT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (['--project', '--base-dir'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} には値が必要です。`);
      options[arg === '--project' ? 'project' : 'baseDir'] = argv[++i];
    } else if (![...modes, '--help'].includes(arg)) throw new Error(`不明なオプションです: ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  if (options.mode === '--analyze') {
    const report = estimateTokens();
    console.log(`従来1体: ${report.legacy.total.toLocaleString()} tokens`);
    console.log(`モデル別委譲: ${report.delegated.total.toLocaleString()} tokens`);
    console.log(`推定削減: ${report.saved.toLocaleString()} tokens (${report.reductionPercent}%)`);
    return report;
  }
  const result = options.mode === '--demo'
    ? demo(options.project, options.baseDir)
    : { outputDir: initProject(options.project, options.baseDir) };
  console.log(`${options.project} を初期化しました: ${result.outputDir}`);
  if (options.mode === '--demo') {
    for (const role of roles) console.log(`${role.model}: ${role.phase} (${role.agent})`);
    console.log('外部LLM呼び出し: 0');
  }
  return result;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[エラー] ${error.message}`);
    process.exitCode = 1;
  }
}
