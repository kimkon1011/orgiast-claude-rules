#!/usr/bin/env node
/**
 * エージェントトークン消費推定ツール（X-0055）
 *
 * AIエージェント（単一・チーム）のトークン消費量をチャット比で見積もる。
 * オージャストのイベント関連マルチエージェント利用時のコスト試算に使用。
 *
 * 使い方:
 *   node tools/agent-token-estimator.mjs                    # デフォルト（単一エージェント・Sonnet）
 *   node tools/agent-token-estimator.mjs --mode multi       # マルチエージェント
 *   node tools/agent-token-estimator.mjs --model opus       # Opus 5.5
 *   node tools/agent-token-estimator.mjs --json             # JSON出力
 *   node tools/agent-token-estimator.mjs --turns 20 --input-tokens 50000 --agents 3
 */
import { isEntry } from './is-entry.mjs';

// モデル別価格（$ / 1Mトークン）: 2026-11-18 時点
export const MODELS = {
  'haiku':  { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.025, label: 'Haiku 5.5' },
  'sonnet': { input: 1.25, output: 6.25, cacheWrite: 1.56,  cacheRead: 0.31,  label: 'Sonnet 5.5' },
  'opus':   { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.75,  label: 'Opus 5.5' },
  'fable':  { input: 8.00, output: 24.00, cacheWrite: 10.00, cacheRead: 2.00, label: 'Fable 5.2' },
};

// シナリオ別のトークン消費倍率（チャット比）
export const SCENARIOS = {
  chat:  { multiplier: 1,  label: '標準チャット',         description: '1ターンの単純な会話' },
  agent: { multiplier: 4,  label: '単一エージェント',     description: 'ツール呼び出し・履歴保持を含む' },
  multi: { multiplier: 15, label: 'マルチエージェント',   description: 'オーケストレーター＋サブエージェント構成' },
};

// チャットの基準トークン数（1ターン）
const BASELINE_INPUT_TOKENS = 1000;
const BASELINE_OUTPUT_TOKENS = 200;

// プロンプト設計の改善提案
export const PROMPT_TIPS = [
  {
    title: '固定プレフィックスの階層化',
    description: 'システムプロンプト・ツール定義・共有コンテキストを先頭に固定し、プロンプトキャッシュを活用する',
    reduction: '入力コスト75%オフ（キャッシュヒット時）',
    effort: '低',
  },
  {
    title: 'チェックポイント要約',
    description: 'ツール呼び出し後に状態を要約し、次ターンでは要約のみを引き継ぐ。生のツール結果を丸ごと保持しない',
    reduction: '履歴トークン60〜80%削減',
    effort: '中',
  },
  {
    title: 'セマンティックツール検索',
    description: '全ツール定義を毎回送る代わりに、現在のタスクに必要なツールだけを動的に選択する',
    reduction: 'ツール定義部分87%削減',
    effort: '高',
  },
  {
    title: 'モデルルーティング',
    description: 'タスク難易度に応じてモデルを切り替え（定型=Haiku、判断=Opus/Fable）',
    reduction: 'コスト最大97%削減（Opus→Haiku切替時）',
    effort: '中',
  },
  {
    title: 'ターン間隔の管理',
    description: 'ターン間隔を3分以内に保ち、プロンプトキャッシュのTTL（約5分）を維持する',
    reduction: 'キャッシュ維持で入力コスト75%オフ継続',
    effort: '低',
  },
];

/**
 * トークン消費とコストを計算
 */
export function estimateTokenCost({
  mode = 'agent',
  model = 'sonnet',
  turns = 10,
  inputTokensPerTurn = null,
  outputTokensPerTurn = null,
  numAgents = null,
  useCache = true,
} = {}) {
  const scenario = SCENARIOS[mode];
  if (!scenario) throw new Error(`未知のモード: ${mode}（chat / agent / multi）`);

  const modelConfig = MODELS[model];
  if (!modelConfig) throw new Error(`未知のモデル: ${model}（haiku / sonnet / opus / fable）`);

  // 1ターンあたりのトークン数
  const inputPerTurn = inputTokensPerTurn ?? BASELINE_INPUT_TOKENS * scenario.multiplier;
  const outputPerTurn = outputTokensPerTurn ?? BASELINE_OUTPUT_TOKENS;

  // エージェント数（マルチエージェントの場合はサブエージェント数を考慮）
  const effectiveAgents = numAgents ?? (mode === 'multi' ? 3 : 1);

  // エージェント数に応じた追加倍率
  const agentScale = mode === 'multi' ? Math.max(1, effectiveAgents * 0.7) : 1;

  // 総トークン数（全エージェント・全ターン）
  const totalInputTokens = Math.round(inputPerTurn * turns * effectiveAgents * agentScale);
  const totalOutputTokens = Math.round(outputPerTurn * turns * effectiveAgents * agentScale);

  // キャッシュありの計算
  let cacheCost = null;
  if (useCache) {
    // 初回書き込み: 全エージェントの初回ターン
    const cacheWriteTokens = Math.round(inputPerTurn * effectiveAgents * agentScale);
    // 2回目以降: キャッシュ読み取り
    const cacheReadTokens = totalInputTokens - cacheWriteTokens;
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * modelConfig.cacheWrite;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * modelConfig.cacheRead;
    const outputCost = (totalOutputTokens / 1_000_000) * modelConfig.output;
    cacheCost = {
      writeTokens: cacheWriteTokens,
      readTokens: cacheReadTokens,
      writeCost: round2(cacheWriteCost),
      readCost: round2(cacheReadCost),
      outputCost: round2(outputCost),
      total: round2(cacheWriteCost + cacheReadCost + outputCost),
    };
  }

  // キャッシュなしの計算
  const noCacheInputCost = (totalInputTokens / 1_000_000) * modelConfig.input;
  const noCacheOutputCost = (totalOutputTokens / 1_000_000) * modelConfig.output;
  const noCacheCost = {
    inputCost: round2(noCacheInputCost),
    outputCost: round2(noCacheOutputCost),
    total: round2(noCacheInputCost + noCacheOutputCost),
  };

  // チャット比
  const chatInputTokens = BASELINE_INPUT_TOKENS * turns;
  const chatOutputTokens = BASELINE_OUTPUT_TOKENS;
  const chatRatio = totalInputTokens / Math.max(1, chatInputTokens);

  return {
    scenario: scenario.label,
    model: modelConfig.label,
    turns,
    effectiveAgents,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    chatRatio: round2(chatRatio),
    inputPerTurn,
    outputPerTurn,
    noCache: noCacheCost,
    cache: cacheCost,
    savings: cacheCost ? round2((1 - cacheCost.total / noCacheCost.total) * 100) : 0,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 結果を人間可読なテーブルで表示
 */
export function formatResult(result) {
  const lines = [];
  const s = result;

  lines.push(`=== エージェントトークン消費推定（X-0055） ===`);
  lines.push('');
  lines.push(`シナリオ: ${s.scenario}`);
  lines.push(`モデル:   ${s.model}`);
  lines.push(`ターン数: ${s.turns}`);
  lines.push(`エージェント数: ${s.effectiveAgents}`);
  lines.push('');
  lines.push(`--- トークン消費 ---`);
  lines.push(`  1ターンあたり入力: ${s.inputPerTurn.toLocaleString()} tokens`);
  lines.push(`  1ターンあたり出力: ${s.outputPerTurn.toLocaleString()} tokens`);
  lines.push(`  総入力トークン:     ${s.totalInputTokens.toLocaleString()} tokens`);
  lines.push(`  総出力トークン:     ${s.totalOutputTokens.toLocaleString()} tokens`);
  lines.push(`  総トークン:         ${s.totalTokens.toLocaleString()} tokens`);
  lines.push(`  チャット比:         ${s.chatRatio.toFixed(1)}x`);
  lines.push('');
  lines.push(`--- コスト ---`);
  lines.push(`  キャッシュなし:     $${s.noCache.total.toFixed(2)}（入力 $${s.noCache.inputCost.toFixed(2)} + 出力 $${s.noCache.outputCost.toFixed(2)}）`);
  if (s.cache) {
    lines.push(`  キャッシュあり:     $${s.cache.total.toFixed(2)}（書込 $${s.cache.writeCost.toFixed(2)} + 読取 $${s.cache.readCost.toFixed(2)} + 出力 $${s.cache.outputCost.toFixed(2)}）`);
    lines.push(`  削減率:             ${s.savings.toFixed(0)}%`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * プロンプト設計の改善提案を表示
 */
export function formatTips() {
  const lines = [];
  lines.push('=== プロンプト設計の改善提案（再読み込み削減） ===');
  lines.push('');
  for (const tip of PROMPT_TIPS) {
    lines.push(`【${tip.title}】（工数: ${tip.effort}）`);
    lines.push(`  ${tip.description}`);
    lines.push(`  効果: ${tip.reduction}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function parseArgs(args) {
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const has = (flag) => args.includes(flag);
  const mode = value('--mode', 'agent');
  const model = value('--model', 'sonnet');
  const turns = Number(value('--turns', 10));
  const inputTokens = value('--input-tokens', null) ? Number(value('--input-tokens', null)) : null;
  const outputTokens = value('--output-tokens', null) ? Number(value('--output-tokens', null)) : null;
  const agents = value('--agents', null) ? Number(value('--agents', null)) : null;
  const useCache = !has('--no-cache');
  const jsonOutput = has('--json');
  const showTips = has('--tips');

  if (!SCENARIOS[mode]) throw new Error(`--mode は chat / agent / multi のいずれかを指定してください`);
  if (!MODELS[model]) throw new Error(`--model は haiku / sonnet / opus / fable のいずれかを指定してください`);
  if (turns < 1 || !Number.isInteger(turns)) throw new Error('--turns は1以上の整数で指定してください');

  return { mode, model, turns, inputTokens, outputTokens, agents, useCache, jsonOutput, showTips };
}

export function run(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  const result = estimateTokenCost({
    mode: opts.mode,
    model: opts.model,
    turns: opts.turns,
    inputTokensPerTurn: opts.inputTokens,
    outputTokensPerTurn: opts.outputTokens,
    numAgents: opts.agents,
    useCache: opts.useCache,
  });

  if (opts.jsonOutput) {
    const output = { ...result, tips: opts.showTips ? PROMPT_TIPS : undefined };
    return JSON.stringify(output, null, 2);
  }

  let output = formatResult(result);
  if (opts.showTips) {
    output += formatTips();
  }
  return output;
}

if (isEntry(import.meta.url)) {
  try {
    const output = run();
    process.stdout.write(output + '\n');
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}