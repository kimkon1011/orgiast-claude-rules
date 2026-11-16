#!/usr/bin/env node
/**
 * benchmark-model-routing.mjs — タスク難易度別モデルルーティング ベンチマーク
 *
 * Haiku/Sonnet/Opus の3モデルでタスク3種（ブース企画・分類抽出・資料作成）を実行し、
 * pass@1 と cost per task を実測する。
 *
 * 使い方:
 *   node tools/benchmark-model-routing.mjs             # 既定の小規模実行
 *   node tools/benchmark-model-routing.mjs --quick      # 最小（モデル×タスク=9 calls）
 *   node tools/benchmark-model-routing.mjs --full       # 最大（5+30+10 = 135 calls → 時間注意）
 *
 * 出力: stdout に CSV 形式 + 最終サマリ。--output <path> で CSV 保存。
 */

import { isEntry } from './is-entry.mjs';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

const LLM_ASK = fileURLToPath(new URL('./llm-ask.mjs', import.meta.url));
const HOME = process.env.ORGIAST_HOME || os.homedir();

// === タスク定義 ===
// 各タスク: { id, category, prompt, expected, evalFn(content) => boolean }
function makeJudge(expected) {
  return (text) => text.toLowerCase().includes(expected.toLowerCase()) && text.trim().length > 5;
}

const TASKS = {

  // --- 1. ブース企画（創造・構成）: Opus 想定 ---
  boothPlan: [
    {
      id: 'booth-concept-01',
      category: 'creative',
      prompt: `あなたは展示会ブースデザイナーです。IT企業（製品: AI チャットボット）の 3m×3m ブースのコンセプトを考えてください。
以下の要素を含めてください:
- ブース全体のテーマ（1文）
- 来場者の導線設計（ゾーニング）
- 使用する展示機材・備品
- グラフィックパネルの構成
- 予算感（150-200万円想定）

200字程度で簡潔にまとめてください。`,
      expected: 'ブース',
      evalFn: (t) => t.includes('ブース') && t.length > 80,
    },
    {
      id: 'booth-concept-02',
      category: 'creative',
      prompt: `食品メーカー（発酵食品）の 6m×3m ブース企画を考えてください。
- 来場者を引きつける仕掛け（演出要素）
- 商談スペースと展示ゾーンのバランス
- 試食コーナーの衛生設計
- 予算250-350万円の配分案

200字程度でまとめてください。`,
      expected: 'ブース',
      evalFn: (t) => t.includes('ブース') && t.length > 80,
    },
  ],

  // --- 2. 分類・抽出（ルールベース work）: Haiku 想定 ---
  classify: [
    {
      id: 'classify-extract-01',
      category: 'extraction',
      prompt: `次のヒアリングメモから、以下の項目を抽出してJSONで出力してください。
- 要望: リスト
- 予算感: 文字列
- 希望時期: 文字列
- 懸念点: リスト

メモ: 「展示会のブースを新しくしたいんです。今使っているのは10年前のもので、古臭く見えてしまって。予算はだいたい200万から300万円くらいで考えています。来年の3月の展示会に間に合えばいいです。ただ、予算が限られているので、なるべくコストを抑えたいです。あと、前回はデザインがイマイチだったので、今回はもっとモダンな感じにしたいです」

回答はJSONのみ、余計な説明は不要です。`,
      expected: '要望',
      evalFn: (t) => t.includes('予算') && t.includes('要望') && t.includes('希望時期'),
    },
    {
      id: 'classify-extract-02',
      category: 'extraction',
      prompt: `以下のログから障害の原因を特定し、JSONで報告してください:
- error_type: エラーの種類
- affected_files: 影響を受けたファイル
- severity: high/medium/low
- suggested_fix: 修正案

ログ:
[ERROR] 2026-11-12 10:23:45 module.js:152 TypeError: Cannot read property 'config' of undefined
    at loadConfig (./src/config.js:42)
    at initApp (./src/app.js:18)
[WARN] 2026-11-12 10:23:46 config.js:43 falling back to default config
[INFO] 2026-11-12 10:23:47 app.js:22 app started with default config

回答はJSONのみで。`,
      expected: 'error_type',
      evalFn: (t) => t.includes('error_type') && t.includes('severity'),
    },
  ],

  // --- 3. 資料作成（文書生成）: Sonnet 想定 ---
  document: [
    {
      id: 'doc-gen-01',
      category: 'document',
      prompt: `展示会ブースの見積書に含むべき項目リストを簡潔に箇条書きで5項目挙げてください。
各項目に簡単な説明（1行）を付けてください。`,
      expected: '項目',
      evalFn: (t) => t.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•') || l.trim().startsWith('*') || /^\d+[\.\)]/.test(l.trim())).length >= 4,
    },
    {
      id: 'doc-gen-02',
      category: 'document',
      prompt: `展示会ブース制作のスケジュール表をマークダウン形式で作成してください。
期間: 2027年1月〜3月（3ヶ月間）
必要なフェーズ: 企画→設計→制作→設置→撤去
マイルストーンを月単位で記載してください。`,
      expected: '月',
      evalFn: (t) => t.includes('月') && t.length > 100,
    },
  ],
};

function modelSpec(model) {
  const names = { haiku: 'anthropic/claude-haiku-5.5', sonnet: 'anthropic/claude-sonnet-5.5', opus: 'anthropic/claude-opus-5.5' };
  return { model: model, providerName: 'claude', apiModel: names[model] };
}

async function runTask(model, task, timeoutMs = 30000) {
  const spec = modelSpec(model);
  const start = Date.now();
  try {
    const { stdout, stderr } = await execute(process.execPath, [
      LLM_ASK, '--provider', spec.providerName, '--model', spec.apiModel,
      '--max', '500', '--no-fallback', '--no-persist',
      ...task.prompt.split(/\n/).filter(l => l.trim()),
    ], { env: process.env, maxBuffer: 1024 * 50, timeout: timeoutMs });
    const content = stdout || '';
    const passed = task.evalFn(content);
    const tokMatch = stderr.match(/in=(\d+)\s+out=(\d+)/);
    const inTok = tokMatch ? parseInt(tokMatch[1]) : 0;
    const outTok = tokMatch ? parseInt(tokMatch[2]) : 0;
    return {
      task_id: task.id, category: task.category, model: model,
      passed: passed ? 1 : 0, content_length: content.length,
      input_tokens: inTok, output_tokens: outTok,
      elapsed_ms: Date.now() - start,
      preview: content.slice(0, 60).replace(/\n/g, ' '),
    };
  } catch (err) {
    return {
      task_id: task.id, category: task.category, model: model,
      passed: 0, content_length: 0,
      input_tokens: 0, output_tokens: 0,
      elapsed_ms: Date.now() - start,
      error: err.message?.slice(0, 80) || String(err).slice(0, 80),
    };
  }
}

function estimateCost(inTok, outTok, model) {
  // OpenRouter pricing (est.) — 実際の cost は usd フィールドから取得したほうが正確
  const rates = {
    haiku: { in: 0.25e-6, out: 1.25e-6 },   // ~$0.25/M in, $1.25/M out
    sonnet: { in: 3e-6, out: 15e-6 },        // ~$3/M in, $15/M out
    opus: { in: 15e-6, out: 75e-6 },          // ~$15/M in, $75/M out
  };
  const r = rates[model];
  return inTok * r.in + outTok * r.out;
}

const MODELS = ['haiku', 'sonnet', 'opus'];

export async function runBenchmark(opts = {}) {
  const scale = opts.scale || 'quick'; // 'quick' | 'normal' | 'full'
  const multipliers = { quick: 1, normal: 2, full: 5 };
  const mult = multipliers[scale];
  const maxTaskPerType = opts.maxPerType || mult;

  const tasksToRun = [];
  for (const [typeName, taskList] of Object.entries(TASKS)) {
    tasksToRun.push(...taskList.slice(0, maxTaskPerType));
  }

  const results = [];
  for (const model of MODELS) {
    process.stderr.write(`[benchmark] model=${model} tasks=${tasksToRun.length}\n`);
    for (const task of tasksToRun) {
      const result = await runTask(model, task, opts.timeout || 45000);
      results.push(result);
      const passMark = result.passed ? '✅' : '❌';
      process.stderr.write(`  ${passMark} ${result.task_id} (${result.elapsed_ms}ms)\n`);
    }
  }

  return results;
}

function formatCSV(results) {
  const header = 'task_id,category,model,passed,content_length,input_tokens,output_tokens,elapsed_ms';
  const rows = results.map(r =>
    `"${r.task_id}","${r.category}","${r.model}",${r.passed},${r.content_length},${r.input_tokens},${r.output_tokens},${r.elapsed_ms}`
  );
  return header + '\n' + rows.join('\n');
}

function summarize(results) {
  const byModel = {};
  for (const r of results) {
    byModel[r.model] = byModel[r.model] || [];
    byModel[r.model].push(r);
  }
  const lines = ['\n=== ベンチマーク結果サマリ ===\n'];
  lines.push('モデル | タスク数 | pass(率) | 総トークン(in+out) | 推定コスト($) | 平均応答(ms)');
  lines.push('---');
  for (const model of MODELS) {
    const items = byModel[model] || [];
    const total = items.length;
    const passed = items.filter(i => i.passed).length;
    const rate = total > 0 ? (passed / total * 100).toFixed(0) : '-';
    const inToks = items.reduce((s, i) => s + i.input_tokens, 0);
    const outToks = items.reduce((s, i) => s + i.output_tokens, 0);
    const cost = items.reduce((s, i) => s + estimateCost(i.input_tokens, i.output_tokens, model), 0);
    const avgMs = total > 0 ? (items.reduce((s, i) => s + i.elapsed_ms, 0) / total).toFixed(0) : '-';
    lines.push(`${model} | ${total} | ${passed}/${total} (${rate}%) | ${inToks + outToks} | $${cost.toFixed(4)} | ${avgMs}ms`);
  }

  const byCategory = {};
  for (const r of results) {
    const key = `${r.model}:${r.category}`;
    byCategory[key] = byCategory[key] || [];
    byCategory[key].push(r);
  }
  lines.push('\n--- カテゴリ別 pass@1 ---');
  for (const model of MODELS) {
    for (const cat of ['creative', 'extraction', 'document']) {
      const key = `${model}:${cat}`;
      const items = byCategory[key] || [];
      const pass = items.filter(i => i.passed).length;
      const total = items.length;
      const rate = total > 0 ? (pass / total * 100).toFixed(0) : '-';
      lines.push(`  ${model} / ${cat}: ${pass}/${total} (${rate}%)`);
    }
  }

  return lines.join('\n');
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const scale = args.includes('--quick') ? 'quick' : args.includes('--full') ? 'full' : 'normal';
  const outputPath = args.includes('--output') ? args[args.indexOf('--output') + 1] : '';

  const results = await runBenchmark({ scale });
  const csv = formatCSV(results);
  if (outputPath) {
    fs.writeFileSync(outputPath, csv);
    process.stderr.write(`\nCSV saved: ${outputPath}\n`);
  }
  process.stdout.write(csv);
  process.stderr.write(summarize(results));
}