// generate-spec.mjs — ブース仕様生成CLI（テンプレートベース、LLM非依存）
// node generate-spec.mjs --client "名" --event "展" --budget 300 --size "3x6" --requirements "商談重視" [--batch] [--dry-run] [--compact] [--output ./{case_id}.json]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { save } from './spec-cache.mjs';
import { assemblePrompt, specSkeleton, printSummary, printBatchComparison } from './spec-display.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = process.env.BOOTH_SPEC_CACHE_DIR || join(process.env.HOME || process.env.USERPROFILE || '.', '.claude', 'booth-spec-cache');

// 標準ブースサイズ
const BOOTH_SIZE_MAP = {
  '3x3':  { w_mm: 3000, d_mm: 3000, height_limit_mm: 2700, open_sides: ['front'], walls: ['back', 'left'], budgetRange: [100, 200] },
  '3x6':  { w_mm: 6000, d_mm: 3000, height_limit_mm: 3000, open_sides: ['front', 'right'], walls: ['back', 'left'], budgetRange: [150, 350] },
  '6x6':  { w_mm: 6000, d_mm: 6000, height_limit_mm: 3500, open_sides: ['front', 'right'], walls: ['back', 'left'], budgetRange: [300, 600] },
  '6x9':  { w_mm: 9000, d_mm: 6000, height_limit_mm: 4000, open_sides: ['front'], walls: ['back', 'left', 'right'], budgetRange: [500, 1000] },
};

// アセットテンプレート
const ASSET_TEMPLATES = {
  system_panel:       { asset_id: 'system_panel',              w_mm: 2600, d_mm: 2400, h_mm: 40,   t_mm: 40 },
  floor_panel:        { asset_id: 'floor_panel',               w_mm: 3000, d_mm: 3000, h_mm: 50,   t_mm: 50 },
  display_table:      { asset_id: 'panel_display_450x900x790',  w_mm: 450,  d_mm: 900,  h_mm: 790,  t_mm: 50 },
  showcase_high:      { asset_id: 'shodan_high_810x810x900',   w_mm: 810,  d_mm: 810,  h_mm: 900,  t_mm: 50 },
  showcase_small:     { asset_id: 'shodan_high_400x400x720',   w_mm: 400,  d_mm: 400,  h_mm: 720,  t_mm: 50 },
  stacking_600:       { asset_id: 'shodan_stacking_600x600x550', w_mm: 600, d_mm: 600,  h_mm: 550,  t_mm: 50 },
  stacking_420:       { asset_id: 'shodan_stacking_420x540x870', w_mm: 420, d_mm: 540,  h_mm: 870,  t_mm: 50 },
  monitor:            { asset_id: 'monitor_42_50x970x560',      w_mm: 50,   d_mm: 970,  h_mm: 560,  t_mm: 50 },
};

// CLI引数パース
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--client':      args.client = argv[++i]; break;
      case '--event':       args.event = argv[++i]; break;
      case '--budget':      args.budget = argv[++i]; break;
      case '--size':        args.size = argv[++i]; break;
      case '--requirements': args.requirements = argv[++i]; break;
      case '--output':      args.output = argv[++i]; break;
      case '--case-id':     args.caseId = argv[++i]; break;
      case '--batch':       args.batch = true; break;
      case '--dry-run':     args.dryRun = true; break;
      case '--compact':     args.compact = true; break;
      default: if (arg.startsWith('--')) { console.error(`不明なオプション: ${arg}`); process.exit(1); }
    }
  }
  return args;
}

function generateCaseId() { const ts = Date.now().toString(36).slice(-4).toUpperCase(); return `G-${ts}-v1`; }

// バリデーション（booth-spec.schema.json 準拠）
function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['仕様がオブジェクトではありません'];
  for (const key of ['case_id', 'title']) { if (typeof spec[key] !== 'string' || spec[key].length === 0) errors.push(`${key} が空です`); }
  const booth = spec.booth;
  if (!booth || typeof booth !== 'object') errors.push('booth がありません');
  else {
    for (const key of ['w_mm', 'd_mm', 'height_limit_mm']) { if (typeof booth[key] !== 'number' || booth[key] <= 0) errors.push(`booth.${key} が正の数ではありません`); }
    for (const key of ['open_sides', 'walls']) { if (!Array.isArray(booth[key])) errors.push(`booth.${key} が配列ではありません`); }
  }
  if (!Array.isArray(spec.items)) errors.push('items が配列ではありません');
  else for (const [i, item] of spec.items.entries()) { if ((!item.asset_id && !item.param) || !Array.isArray(item.pos_mm) || item.pos_mm.length !== 3) errors.push(`items[${i}] が必須形式を満たしません`); }
  if (!Array.isArray(spec.views)) errors.push('views が配列ではありません');
  return errors;
}

function assertValidSpec(spec) { const errors = validateSpec(spec); if (errors.length > 0) throw new Error(`生成仕様がスキーマ要件を満たしません: ${errors.join(', ')}`); }

function parseBudget(budgetStr) {
  if (!budgetStr) return [300];
  const parts = budgetStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  return parts.length > 0 ? parts : [300];
}

// 予算からアセットセット選択
function selectAssetsForBudget(budget, boothSize, requirements) {
  const items = [];
  // 常設: 床パネル + 背面パネル + 展示台
  items.push({ ...ASSET_TEMPLATES.floor_panel, pos_mm: [boothSize.w_mm / 2, boothSize.d_mm / 2, 0], count: 1 });
  items.push({ ...ASSET_TEMPLATES.system_panel, pos_mm: [boothSize.w_mm / 2, 200, 0], count: 1 });
  items.push({ ...ASSET_TEMPLATES.display_table, pos_mm: [boothSize.w_mm / 3, boothSize.d_mm / 2, 0], count: 1 });

  if (budget >= 200) {
    items.push({ ...ASSET_TEMPLATES.showcase_high, pos_mm: [boothSize.w_mm * 2 / 3, boothSize.d_mm / 2 - 300, 0], count: 1 });
    items.push({ ...ASSET_TEMPLATES.monitor, pos_mm: [boothSize.w_mm / 2, boothSize.d_mm / 4, 1500], count: 1 });
  }
  if (budget >= 350) {
    items.push({ ...ASSET_TEMPLATES.stacking_600, pos_mm: [boothSize.w_mm * 3 / 4, boothSize.d_mm / 2 + 300, 0], count: 1 });
    items.push({ ...ASSET_TEMPLATES.showcase_small, pos_mm: [boothSize.w_mm / 4, boothSize.d_mm / 2 + 300, 0], count: 1 });
  }

  const reqs = (requirements || '').toLowerCase();
  if (reqs.includes('デモ') || reqs.includes('実機') || reqs.includes('demo')) items.push({ ...ASSET_TEMPLATES.monitor, pos_mm: [boothSize.w_mm * 3 / 4, boothSize.d_mm / 4, 1200], rot_deg: 15, count: 1 });
  if (reqs.includes('商談') || reqs.includes('ミーティング') || reqs.includes('meeting')) items.push({ ...ASSET_TEMPLATES.stacking_420, pos_mm: [boothSize.w_mm / 2, boothSize.d_mm * 0.7, 0], count: 2 });
  if (reqs.includes('展示') || reqs.includes('ショーケース') || reqs.includes('display')) items.push({ ...ASSET_TEMPLATES.showcase_small, pos_mm: [boothSize.w_mm * 0.15, boothSize.d_mm * 0.3, 0], count: 1 });
  return items;
}

// ブース仕様生成（テンプレートベース）
function generateSpec({ client, event, budget, size, requirements, caseId }) {
  const boothSize = BOOTH_SIZE_MAP[size] || BOOTH_SIZE_MAP['3x3'];
  return {
    case_id: caseId,
    title: `${client ? client + ' ' : ''}展示ブース（${size}）`,
    booth: { w_mm: boothSize.w_mm, d_mm: boothSize.d_mm, height_limit_mm: boothSize.height_limit_mm, open_sides: [...boothSize.open_sides], walls: [...boothSize.walls] },
    items: selectAssetsForBudget(budget, boothSize, requirements),
    views: ['persp_front_left', 'persp_front_right', 'top'],
  };
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

async function main() {
  const args = parseArgs(process.argv);
  const budgets = parseBudget(args.budget);
  const isBatch = args.batch && budgets.length > 1;
  const size = args.size || '3x3';

  if (!BOOTH_SIZE_MAP[size]) { console.error(`エラー: 未対応サイズ "${size}"。対応: ${Object.keys(BOOTH_SIZE_MAP).join(', ')}`); process.exit(1); }

  if (args.dryRun) {
    console.log('=== アセンブルドプロンプト ===\n' + assemblePrompt(args) + '\n=== スペックスケルトン ===\n' + JSON.stringify(specSkeleton(args), null, 2));
    return;
  }

  // 生成
  const specs = isBatch
    ? budgets.map((budget, i) => {
        const caseId = args.caseId || generateCaseId().replace(/-v1$/, `-b${i + 1}-v1`);
        const spec = generateSpec({ ...args, budget, size, caseId: args.caseId ? `${caseId}-b${i + 1}-v1` : caseId });
        assertValidSpec(spec);
        return spec;
      })
    : [generateSpec({ ...args, budget: budgets[0], size, caseId: args.caseId || generateCaseId() })];

  // コンパクト出力
  if (args.compact) {
    for (const spec of specs) console.log(JSON.stringify({ case_id: spec.case_id, title: spec.title, booth: `${spec.booth.w_mm}x${spec.booth.d_mm}`, item_count: spec.items.length, views: spec.views.length }));
    return;
  }

  // 保存 + 表示
  for (const spec of specs) {
    try { save(DEFAULT_CACHE_DIR, spec); } catch { /* キャッシュ保存失敗は無視 */ }
    if (args.output) {
      const outputPath = args.output.replace('{case_id}', spec.case_id);
      const dir = dirname(outputPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');
    }
  }

  if (isBatch) {
    for (const spec of specs) printSummary(spec, budgets, false);
    printBatchComparison(specs, budgets);
  } else {
    printSummary(specs[0], budgets, false);
  }
}

main().catch(err => { console.error('エラー:', err.message); process.exit(1); });