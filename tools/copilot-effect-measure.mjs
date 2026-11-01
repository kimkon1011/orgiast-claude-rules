#!/usr/bin/env node
// ローカルCopilot導入効果測定（P-0299）
// 代表タスクをクラウド Claude（既定）とローカル安価モデル（cheap-code 経由）の
// 両バックエンドで実行し、壁時計時間と推定ネットワークバイトを比較する測定ハーネス。
// 既定は --dry-run（計画JSONを出力・ネットワーク不使用）。--live で実測する。
//
// 出典: AIニュース提案 P-0299「ローカルCopilot導入効果測定」（2026-10-28 digest）
//   先行事例（北海道大学・東芝等）: ローカルCopilot導入で作業時間 月5-15h 削減、
//   ネットワークトラフィック 30-50% 減少 → 実測で同等なら 主要部署へ本導入を判断する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 代表タスク（主要部署の典型 AI 利用）
export const TASKS = Object.freeze({
  classify: Object.freeze({ department: '営業', description: '短文の分類（提案トリアージ等）' }),
  summarize: Object.freeze({ department: '営業', description: 'digest 要約（ai-news-digest 等）' }),
  judge: Object.freeze({ department: '制作', description: '多基準判定（ルール適合チェック等）' }),
  plan: Object.freeze({ department: '制作', description: '設計・企画案（企画書等）' }),
});

// バックエンド定義。cloud = クラウド Claude CLI、local = cheap-code（OpenRouter 経由の安価モデル）。
export const BACKENDS = Object.freeze({
  cloud: Object.freeze({ label: 'クラウド Claude（既定）', command: 'claude', args: ['-p'] }),
  local: Object.freeze({
    label: 'ローカル安価モデル（cheap-code:deepseek 経由）',
    command: 'node',
    args: ['tools/cheap-code.mjs', '--provider', 'deepseek', '--dry-run'],
  }),
});

// ---- 推定ネットワークバイト（概算） ----
// 実ネットワークを計測する前に、prompt/completion の文字数から上下界つきで推定する。
// 日本語 UTF-8 は 1 token ≒ 1.5-2 文字。token 数 = 文字数 × TOKENS_PER_CHAR とし、
// 1 token あたり INPUT/OUTPUT_BYTES_PER_TOKEN バイト（入力・出力で 4B/4B の控えめな中央値）を乗じ、
// HTTP ヘッダ相当の固定オーバーヘッドを足す。
export const INPUT_BYTES_PER_TOKEN = 4;
export const OUTPUT_BYTES_PER_TOKEN = 4;
export const TOKENS_PER_CHAR = 0.6;
export const REQUEST_OVERHEAD_BYTES = 2048;

export function estimateBytes({ promptChars = 0, completionChars = 0 } = {}) {
  const inputTokens = promptChars * TOKENS_PER_CHAR;
  const outputTokens = completionChars * TOKENS_PER_CHAR;
  return {
    promptChars, completionChars,
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
    totalBytes: Math.round(REQUEST_OVERHEAD_BYTES + inputTokens * INPUT_BYTES_PER_TOKEN + outputTokens * OUTPUT_BYTES_PER_TOKEN),
  };
}

function number(value, fallback, flag) {
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error(`${flag} は 0 以上の数値で指定してください`);
  return num;
}

export function parseArgs(args) {
  const indexOf = (flag) => args.indexOf(flag);
  const value = (flag) => (indexOf(flag) >= 0 ? args[indexOf(flag) + 1] : undefined);
  const task = value('--task') ?? 'classify';
  const backend = value('--backend') ?? 'both';
  const targetByteReduction = number(value('--target-byte-reduction'), 0.3, '--target-byte-reduction');
  if (!Object.hasOwn(TASKS, task) && task !== 'all') throw new Error(`--task は ${Object.keys(TASKS).join(', ')} または all のいずれかで指定してください`);
  if (!['cloud', 'local', 'both'].includes(backend)) throw new Error('--backend は cloud, local, both のいずれかで指定してください');
  if (targetByteReduction < 0 || targetByteReduction > 1) throw new Error('--target-byte-reduction は 0〜1 で指定してください');
  return {
    list: args.includes('--list'),
    dryRun: args.includes('--dry-run'),
    live: args.includes('--live'),
    task,
    backend,
    targetByteReduction,
    prompt: value('--prompt'),
    report: value('--report'),
    durationSeconds: number(value('--duration-seconds'), 60, '--duration-seconds'),
  };
}

export function buildPlan({ tasks = TASKS, backends = BACKENDS, prompt = '（実測時は --prompt で注入）' } = {}) {
  return {
    proposal: 'P-0299',
    title: 'ローカルCopilot導入効果測定',
    metric: '壁時計時間（ms）と推定ネットワークバイト（prompt/completion 文字数 × 概算換算）',
    prompt,
    plan: Object.entries(tasks).map(([id, t]) => ({
      task: id,
      department: t.department,
      description: t.description,
      backends: Object.keys(backends),
    })),
    note: 'dry-run はネットワーク・API を一切呼ばない。実測は --live で行う。',
  };
}

// ---- 実測 ----
export function resolveReportPath(home, report) {
  // --report はファイルパスそのまま。既定は ~/.claude/logs/copilot-effect-measure.json
  return report || path.join(home, '.claude', 'logs', 'copilot-effect-measure.json');
}

export function loadReport(reportPath) {
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return { runs: [] };
  }
}

export function appendRun(reportPath, run) {
  const report = loadReport(reportPath);
  report.runs.push(run);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function commandExists(command, cwd) {
  if (command === 'node') return true; // 自身のランタイム
  if (path.isAbsolute(command)) return fs.existsSync(command); // 絶対パスは直接存在確認
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0;
}

export function runOnce({ task, backend, prompt, home, cwd, now = () => Date.now(), registry = BACKENDS }) {
  if (!Object.hasOwn(TASKS, task)) throw new Error(`未知の task: ${task}`);
  if (!Object.hasOwn(registry, backend)) throw new Error(`未知の backend: ${backend}`);
  const spec = registry[backend];
  const argv = [...spec.args, ...(backend === 'cloud' ? [prompt] : ['--prompt-file', path.join(home, '.copilot-effect-measure', `${task}.prompt.txt`)])];
  const start = now();
  const result = spawnSync(spec.command, argv, { cwd, encoding: 'utf8', timeout: 60000 });
  const elapsedMs = now() - start;
  return { task, backend, elapsedMs, promptChars: prompt.length, completionChars: (result.stdout || '').length, status: result.status, error: result.error?.message ?? null };
}

export function summarizeRuns(runs) {
  const byBackend = {};
  for (const run of runs) {
    (byBackend[run.backend] ??= []).push(run);
  }
  const series = (values) => {
    if (!values.length) return { count: 0 };
    const sum = values.reduce((a, b) => a + b, 0);
    return { count: values.length, avg: sum / values.length, min: Math.min(...values), max: Math.max(...values), sum };
  };
  const summary = {};
  for (const [backend, items] of Object.entries(byBackend)) {
    const bytes = series(items.map((r) => estimateBytes(r).totalBytes));
    const time = series(items.map((r) => r.elapsedMs));
    summary[backend] = { runs: items.length, bytesEst: bytes, elapsedMs: time };
  }
  return summary;
}

// ---- 導入判断: ローカル版での推定ネットワークバイト削減が目標（既定 30%）を満たすか ----
export function judgeAdoption(summary, { targetByteReduction = 0.3 } = {}) {
  const cloud = summary.cloud, local = summary.local;
  if (!cloud || cloud.bytesEst.count === 0) return { expand: false, reason: 'クラウド側の実測がありません' };
  if (!local || local.bytesEst.count === 0) return { expand: false, reason: 'ローカル側の実測がありません', measured: false };
  const reduction = 1 - local.bytesEst.avg / cloud.bytesEst.avg;
  const expand = reduction >= targetByteReduction;
  return {
    expand,
    byteReduction: Math.round(reduction * 1000) / 1000,
    targetByteReduction,
    conclusion: expand
      ? `ネットワーク推定バイトが ${(reduction * 100).toFixed(0)}% 減（目標 ${(targetByteReduction * 100).toFixed(0)}% 以上）→ 主要部署への試験導入拡大を推奨`
      : `ネットワーク推定バイト削減は ${(reduction * 100).toFixed(0)}%（目標 ${(targetByteReduction * 100).toFixed(0)}%）に未達 → 測定継続・タスク追加を推奨`,
  };
}

export async function main(argv = process.argv.slice(2), { registry = BACKENDS } = {}) {
  const args = parseArgs(argv);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const cwd = process.cwd();
  if (args.list) {
    process.stdout.write(JSON.stringify({ tasks: TASKS, backends: registry }, null, 2) + '\n');
    return 0;
  }
  if (!args.live) {
    const tasks = args.task === 'all' ? TASKS : { [args.task]: TASKS[args.task] };
    process.stdout.write(JSON.stringify(buildPlan({ tasks, prompt: args.prompt }), null, 2) + '\n');
    return 0;
  }
  // --live: 実測。設定（バックエンド実行基盤）が無い機体では fail closed して報告だけ残す。
  const reportPath = resolveReportPath(home, args.report);
  const backends = args.backend === 'both' ? Object.keys(registry) : [args.backend];
  for (const backend of backends) {
    if (!Object.hasOwn(registry, backend)) throw new Error(`--backend ${backend} は利用可能なバックエンドにありません`);
    if (!commandExists(registry[backend].command, cwd)) {
      throw new Error(`バックエンド ${backend} の実行基盤（${registry[backend].command}）がありません。--live は実行可能な機体でのみ使えます`);
    }
    const run = runOnce({ task: args.task, backend, prompt: args.prompt || '', home, cwd, registry });
    appendRun(reportPath, run);
  }
  const summary = summarizeRuns(loadReport(reportPath).runs);
  process.stdout.write(JSON.stringify({ report: reportPath, summary, adoption: judgeAdoption(summary, { targetByteReduction: args.targetByteReduction }) }, null, 2) + '\n');
  return 0;
}

if (process.argv[1] && (process.argv[1].endsWith('copilot-effect-measure.mjs') || process.argv[1].endsWith('copilot-effect-measure'))) {
  main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err.message); process.exitCode = 1; });
}