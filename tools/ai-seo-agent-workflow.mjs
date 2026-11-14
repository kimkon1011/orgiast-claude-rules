#!/usr/bin/env node

/**
 * X-0019 AI SEO Agent Workflow — 検証CLIツール
 *
 * Usage:
 *   node tools/ai-seo-agent-workflow.mjs --list
 *   node tools/ai-seo-agent-workflow.mjs --scenario plan
 *   node tools/ai-seo-agent-workflow.mjs --scenario plan --json
 *   node tools/ai-seo-agent-workflow.mjs  (all scenarios)
 */

// ── Data ──────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { key: 'plan',     label: '実装パス別 月額コスト試算' },
  { key: 'keywords', label: 'キーワード機会スコアリング' },
  { key: 'minisite', label: 'ミニサイト企画テンプレート生成' },
];

const COST_PATHS = [
  {
    label: 'A: Claude Code + GAS',
    monthly: '$0〜5',
    setup: '1〜2日',
    note: '既存環境流用、GAS無料枠内。制約: GAS実行時間6分/回制限',
  },
  {
    label: 'B: Hermes/OpenClaw on VPS',
    monthly: '$10〜30',
    setup: '1〜2週間',
    note: 'VPS費用 $10.89/月（Hetzner CX22）+ API従量 $0〜20/月',
  },
  {
    label: 'C: カスタムNode.js',
    monthly: '$1〜10',
    setup: '3〜5日',
    note: 'API従量 $1〜10/月、VPS不要（GitHub Actions無料枠）',
  },
];

const KEYWORD_DATA = [
  { kw: '展示会ブース 費用 相場', volume: 1200, rank: 25, competition: '中' },
  { kw: '小規模ブース デザイン',  volume: 800,  rank: 18, competition: '低' },
  { kw: '展示会 集客 施策',      volume: 600,  rank: 30, competition: '高' },
  { kw: 'イベント企画 代行',     volume: 400,  rank: 12, competition: '中' },
  { kw: 'ブース製作 会社 比較',  volume: 350,  rank: 35, competition: '高' },
  { kw: '展示会 ブース レンタル', volume: 900,  rank: null, competition: '低' },
  { kw: 'ブース装飾 会社',       volume: 500,  rank: 22, competition: '中' },
  { kw: '展示会 出展 準備',      volume: 700,  rank: null, competition: '低' },
];

const MAX_VOLUME = Math.max(...KEYWORD_DATA.map(d => d.volume));

const COMPETITION_SCORE = { 低: 0.3, 中: 0.15, 高: 0 };

const MINISITE_TEMPLATES = [
  {
    theme: '展示会ブース 費用 相場',
    targetKw: ['ブース費用', '相場', '予算', '坪単価'],
    content: '費用テーブル + 規模別事例 + 見積依頼CTA',
  },
  {
    theme: '小規模ブース デザイン',
    targetKw: ['小規模', '3坪', '6坪', '島ブース'],
    content: '実績ギャラリー + レイアウト例 + 費用目安',
  },
  {
    theme: '展示会 集客 施策',
    targetKw: ['集客', 'ノベルティ', 'ブース誘導'],
    content: '施策リスト + 事例 + チェックリストDL',
  },
  {
    theme: 'イベント企画 代行',
    targetKw: ['イベント企画', '運営代行', '丸投げ'],
    content: 'サービス一覧 + フローチャート + 実績',
  },
  {
    theme: 'ブース製作 会社 比較',
    targetKw: ['ブース製作会社', '選び方', '比較'],
    content: '選定基準 + 自社の強み + 比較表',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────

function scoreKeyword({ volume, rank, competition }) {
  const volScore = (volume / MAX_VOLUME) * 0.4;
  const rankScore = rank != null ? (1 - rank / 50) * 0.3 : 0;
  const compScore = (COMPETITION_SCORE[competition] ?? 0) * 0.3;
  return Math.round((volScore + rankScore + compScore) * 1000) / 1000;
}

function separator() {
  console.log('─'.repeat(56));
}

function jsonOrText(data, useJson) {
  if (useJson) {
    console.log(JSON.stringify(data));
    return;
  }
  return data; // caller prints
}

// ── Scenario runners ──────────────────────────────────────────────────────

function runList(useJson) {
  const data = SCENARIOS.map(s => ({ key: s.key, label: s.label }));
  if (useJson) return jsonOrText(data, true);
  console.log('利用可能シナリオ:\n');
  data.forEach(s => console.log(`  ${s.key.padEnd(12)} ${s.label}`));
  console.log();
}

function runPlan(useJson) {
  const data = COST_PATHS.map(p => ({
    path: p.label,
    monthlyCost: p.monthly,
    setupPeriod: p.setup,
    notes: p.note,
  }));
  if (useJson) return jsonOrText(data, true);

  console.log('【実装パス別 月額コスト試算】\n');
  COST_PATHS.forEach(p => {
    console.log(`  ${p.label}`);
    console.log(`    月額: ${p.monthly}  |  導入期間: ${p.setup}`);
    console.log(`    ${p.note}\n`);
  });
}

function runKeywords(useJson) {
  const data = KEYWORD_DATA.map(d => ({
    keyword: d.kw,
    volume: d.volume,
    rank: d.rank,
    competition: d.competition,
    score: scoreKeyword(d),
  }));
  if (useJson) return jsonOrText(data, true);

  console.log('【キーワード機会スコアリング】\n');
  console.log('  キーワード'.padEnd(28) + '検索数  順位  競合  スコア');
  console.log('  ' + '─'.repeat(54));
  const sorted = [...data].sort((a, b) => b.score - a.score);
  sorted.forEach(d => {
    const rankStr = d.rank != null ? String(d.rank).padStart(2) : '--';
    console.log(
      `  ${d.keyword.padEnd(26)} ${String(d.volume).padStart(5)}  ${rankStr}位  ${d.competition}  ${d.score.toFixed(3)}`
    );
  });
  console.log();
}

function runMinisite(useJson) {
  const data = MINISITE_TEMPLATES.map(t => ({
    theme: t.theme,
    targetKeywords: t.targetKw,
    contentStructure: t.content,
  }));
  if (useJson) return jsonOrText(data, true);

  console.log('【ミニサイト企画テンプレート】\n');
  MINISITE_TEMPLATES.forEach((t, i) => {
    console.log(`  ${i + 1}. テーマ: ${t.theme}`);
    console.log(`     狙うKW: ${t.targetKw.join(', ')}`);
    console.log(`     コンテンツ構成: ${t.content}\n`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

function showError(message) {
  const err = { error: true, message };
  console.error(`エラー: ${message}`);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(err));
  }
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const useJson = args.includes('--json');
  const listOnly = args.includes('--list');
  const scenarioIdx = args.indexOf('--scenario');
  const scenario = scenarioIdx !== -1 ? args[scenarioIdx + 1] : null;

  // Validate
  if (scenario && !SCENARIOS.some(s => s.key === scenario)) {
    showError(`不明なシナリオ「${scenario}」。--list で一覧を確認してください。`);
  }

  if (listOnly) {
    runList(useJson);
    return;
  }

  if (scenario) {
    switch (scenario) {
      case 'plan':     runPlan(useJson);     break;
      case 'keywords': runKeywords(useJson); break;
      case 'minisite': runMinisite(useJson); break;
    }
    return;
  }

  // No specific option → run all
  if (!useJson) {
    runList(false);
    separator();
  }
  runPlan(useJson);
  if (!useJson) separator();
  runKeywords(useJson);
  if (!useJson) separator();
  runMinisite(useJson);
}

main();
