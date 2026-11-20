// spec-display.mjs — generate-spec.mjs の表示関数（分離によりコアを軽量化）

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PREFIX_FILE = join(__dirname, 'cache-prefix.md');

export function assemblePrompt(args) {
  let prefix = '';
  try {
    if (existsSync(CACHE_PREFIX_FILE)) prefix = readFileSync(CACHE_PREFIX_FILE, 'utf-8');
  } catch { prefix = '# ブース仕様生成コンテキスト（読み込み失敗）\n'; }
  const inputSection = `## 入力パラメータ\n- クライアント: ${args.client || '(未指定)'}\n- イベント: ${args.event || '(未指定)'}\n- 予算: ${args.budget || 300}万円\n- サイズ: ${args.size || '3x3'}\n- 要件: ${args.requirements || '(なし)'}\n- モード: ${args.batch ? 'バッチ' : '単一'}\n`;
  return prefix + inputSection;
}

export function specSkeleton(args) {
  const BOOTH_SIZE_MAP = {
    '3x3': { w_mm: 3000, d_mm: 3000, height_limit_mm: 2700, open_sides: ['front'], walls: ['back', 'left'] },
    '3x6': { w_mm: 6000, d_mm: 3000, height_limit_mm: 3000, open_sides: ['front', 'right'], walls: ['back', 'left'] },
    '6x6': { w_mm: 6000, d_mm: 6000, height_limit_mm: 3500, open_sides: ['front', 'right'], walls: ['back', 'left'] },
    '6x9': { w_mm: 9000, d_mm: 6000, height_limit_mm: 4000, open_sides: ['front'], walls: ['back', 'left', 'right'] },
  };
  const boothSize = BOOTH_SIZE_MAP[args.size] || BOOTH_SIZE_MAP['3x3'];
  return {
    case_id: '{自動生成}', title: `${args.client || '(クライアント名)'} 展示ブース（${args.size}）`,
    booth: { ...boothSize },
    items: [
      { asset_id: 'floor_panel', pos_mm: '[center]', count: 1 },
      { asset_id: 'system_panel', pos_mm: '[back_wall]', count: 1 },
      { asset_id: 'display_table', pos_mm: '[display_area]', count: 1 },
      { asset_id: 'monitor(予算>=200万)', pos_mm: '[wall_mount]', count: 1 },
      { asset_id: 'showcase(予算>=200万)', pos_mm: '[corner]', count: 1 },
    ],
    views: ['persp_front_left', 'persp_front_right', 'top'],
    _note: 'スケルトン。--dry-run を外して実際の生成を。'
  };
}

export function printSummary(spec, budgets, isBatch) {
  console.log(`=== ブース仕様生成 サマリ ===\n案件ID: ${spec.case_id}\nタイトル: ${spec.title}\nブース: ${spec.booth.w_mm}×${spec.booth.d_mm}mm\nアイテム数: ${spec.items.length}\nビュー: ${spec.views.join(', ')}`);
  const bd = budgetBreakdown(budgets[0]);
  console.log('\n--- 予算配分 ---');
  for (const item of bd) console.log(`  ${item.category}: ${item.amount}万円`);
}

export function printBatchComparison(specs, budgets) {
  console.log('\n=== バッチ比較表 ===');
  console.log(`| 項目 | ${budgets.map(b => `${b}万円`).join(' | ')} |`);
  console.log(`|------|${budgets.map(() => '------|').join('')}`);
  console.log(`| アイテム数 | ${specs.map(s => s.items.length).join(' | ')} |`);
  console.log(`| 床面積 | ${specs.map(s => `${s.booth.w_mm}×${s.booth.d_mm}mm`).join(' | ')} |`);
  const categories = ['企画・設計', '構造部材', 'グラフィック・サイン', '映像・デジタル', '施工・運営'];
  for (const cat of categories) {
    const vals = budgets.map(b => { const bd = budgetBreakdown(b); const found = bd.find(x => x.category === cat); return found ? `${found.amount}万円` : '-'; });
    console.log(`| ${cat} | ${vals.join(' | ')} |`);
  }
}

function budgetBreakdown(budget) {
  return [
    { category: '企画・設計', amount: Math.round(budget * 0.10) },
    { category: '構造部材', amount: Math.round(budget * 0.40) },
    { category: 'グラフィック・サイン', amount: Math.round(budget * 0.20) },
    { category: '映像・デジタル', amount: Math.round(budget * 0.15) },
    { category: '施工・運営', amount: Math.round(budget * 0.15) },
  ];
}