// generate-spec.mjs — ブース仕様生成CLIツール
// テンプレートベースでブース仕様JSONを生成する（LLM非依存）
//
// 使い方:
//   node generate-spec.mjs \
//     --client "クライアント名" \
//     --event "イベント名" \
//     --budget 300 \
//     --size "3x6" \
//     --requirements "商談重視・実機デモあり" \
//     [--batch] [--dry-run] [--output ./outputs/spec-{case_id}.json]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { save } from './spec-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PREFIX_FILE = join(__dirname, 'cache-prefix.md');
const DEFAULT_CACHE_DIR = process.env.BOOTH_SPEC_CACHE_DIR
  || join(process.env.HOME || process.env.USERPROFILE || '.', '.claude', 'booth-spec-cache');

// ============================================================
// 標準ブースサイズ定義（cache-prefix.md の内容をコードに反映）
// ============================================================
const BOOTH_SIZE_MAP = {
  '3x3':  { w_mm: 3000, d_mm: 3000, height_limit_mm: 2700, open_sides: ['front'], walls: ['back', 'left'], budgetRange: [100, 200] },
  '3x6':  { w_mm: 6000, d_mm: 3000, height_limit_mm: 3000, open_sides: ['front', 'right'], walls: ['back', 'left'], budgetRange: [150, 350] },
  '6x6':  { w_mm: 6000, d_mm: 6000, height_limit_mm: 3500, open_sides: ['front', 'right'], walls: ['back', 'left'], budgetRange: [300, 600] },
  '6x9':  { w_mm: 9000, d_mm: 6000, height_limit_mm: 4000, open_sides: ['front'], walls: ['back', 'left', 'right'], budgetRange: [500, 1000] }
};

// ============================================================
// アセットライブラリ（cache-prefix.md の保有機材一覧）
// ============================================================
const ASSET_TEMPLATES = {
  system_panel:       { asset_id: 'system_panel',              w_mm: 2600, d_mm: 2400, h_mm: 40,   t_mm: 40 },
  floor_panel:        { asset_id: 'floor_panel',               w_mm: 3000, d_mm: 3000, h_mm: 50,   t_mm: 50 },
  display_table:      { asset_id: 'panel_display_450x900x790',  w_mm: 450,  d_mm: 900,  h_mm: 790,  t_mm: 50 },
  showcase_high:      { asset_id: 'shodan_high_810x810x900',   w_mm: 810,  d_mm: 810,  h_mm: 900,  t_mm: 50 },
  showcase_small:     { asset_id: 'shodan_high_400x400x720',   w_mm: 400,  d_mm: 400,  h_mm: 720,  t_mm: 50 },
  stacking_600:       { asset_id: 'shodan_stacking_600x600x550', w_mm: 600, d_mm: 600,  h_mm: 550,  t_mm: 50 },
  stacking_420:       { asset_id: 'shodan_stacking_420x540x870', w_mm: 420, d_mm: 540,  h_mm: 870,  t_mm: 50 },
  monitor:            { asset_id: 'monitor_42_50x970x560',      w_mm: 50,   d_mm: 970,  h_mm: 560,  t_mm: 50 }
};

// ============================================================
// CLI引数パース
// ============================================================
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
      default:
        if (arg.startsWith('--')) {
          console.error(`不明なオプション: ${arg}`);
          process.exit(1);
        }
    }
  }
  return args;
}

// ============================================================
// case_id 自動生成
// ============================================================
function generateCaseId() {
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `G-${ts}-v1`;
}

// booth-spec.schema.json の必須条件を外部依存なしで確認する。
function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['仕様がオブジェクトではありません'];
  for (const key of ['case_id', 'title']) {
    if (typeof spec[key] !== 'string' || spec[key].length === 0) errors.push(`${key} が空です`);
  }
  const booth = spec.booth;
  if (!booth || typeof booth !== 'object') errors.push('booth がありません');
  else {
    for (const key of ['w_mm', 'd_mm', 'height_limit_mm']) {
      if (typeof booth[key] !== 'number' || booth[key] <= 0) errors.push(`booth.${key} が正の数ではありません`);
    }
    for (const key of ['open_sides', 'walls']) {
      if (!Array.isArray(booth[key])) errors.push(`booth.${key} が配列ではありません`);
    }
  }
  if (!Array.isArray(spec.items)) errors.push('items が配列ではありません');
  else for (const [index, item] of spec.items.entries()) {
    if ((!item.asset_id && !item.param) || !Array.isArray(item.pos_mm) || item.pos_mm.length !== 3) {
      errors.push(`items[${index}] が必須形式を満たしません`);
    }
  }
  if (!Array.isArray(spec.views)) errors.push('views が配列ではありません');
  return errors;
}

function assertValidSpec(spec) {
  const errors = validateSpec(spec);
  if (errors.length > 0) throw new Error(`生成仕様がスキーマ要件を満たしません: ${errors.join(', ')}`);
}

// ============================================================
// 予算パース
// ============================================================
function parseBudget(budgetStr) {
  if (!budgetStr) return [300];
  // カンマ区切り対応（--batch モード）
  const parts = budgetStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  return parts.length > 0 ? parts : [300];
}

// ============================================================
// 予算から適切なアセットセットを選択
// ============================================================
function selectAssetsForBudget(budget, boothSize, requirements) {
  const requiredItems = [];

  // 床パネル（常に設置）
  requiredItems.push({
    ...ASSET_TEMPLATES.floor_panel,
    pos_mm: [boothSize.w_mm / 2, boothSize.d_mm / 2, 0],
    count: 1
  });

  // 背面システムパネル（常に設置）
  requiredItems.push({
    ...ASSET_TEMPLATES.system_panel,
    pos_mm: [boothSize.w_mm / 2, 200, 0],
    count: 1
  });

  // 展示台（常に設置）
  requiredItems.push({
    ...ASSET_TEMPLATES.display_table,
    pos_mm: [boothSize.w_mm / 3, boothSize.d_mm / 2, 0],
    count: 1
  });

  if (budget >= 200) {
    // 中型予算：ショーケース + モニター
    requiredItems.push({
      ...ASSET_TEMPLATES.showcase_high,
      pos_mm: [boothSize.w_mm * 2 / 3, boothSize.d_mm / 2 - 300, 0],
      count: 1
    });
    requiredItems.push({
      ...ASSET_TEMPLATES.monitor,
      pos_mm: [boothSize.w_mm / 2, boothSize.d_mm / 4, 1500],
      count: 1
    });
  }

  if (budget >= 350) {
    // 高予算：追加の什器
    requiredItems.push({
      ...ASSET_TEMPLATES.stacking_600,
      pos_mm: [boothSize.w_mm * 3 / 4, boothSize.d_mm / 2 + 300, 0],
      count: 1
    });
    requiredItems.push({
      ...ASSET_TEMPLATES.showcase_small,
      pos_mm: [boothSize.w_mm / 4, boothSize.d_mm / 2 + 300, 0],
      count: 1
    });
  }

  // 要件に応じた追加アセット
  const reqs = (requirements || '').toLowerCase();

  if (reqs.includes('デモ') || reqs.includes('実機') || reqs.includes('demo')) {
    // デモ用モニター + 床面積確保
    requiredItems.push({
      ...ASSET_TEMPLATES.monitor,
      pos_mm: [boothSize.w_mm * 3 / 4, boothSize.d_mm / 4, 1200],
      rot_deg: 15,
      count: 1
    });
  }

  if (reqs.includes('商談') || reqs.includes('ミーティング') || reqs.includes('meeting')) {
    // 商談スペース用の什器（テーブル代わりの積載什器）
    requiredItems.push({
      ...ASSET_TEMPLATES.stacking_420,
      pos_mm: [boothSize.w_mm / 2, boothSize.d_mm * 0.7, 0],
      count: 2
    });
  }

  if (reqs.includes('展示') || reqs.includes('ショーケース') || reqs.includes('display')) {
    requiredItems.push({
      ...ASSET_TEMPLATES.showcase_small,
      pos_mm: [boothSize.w_mm * 0.15, boothSize.d_mm * 0.3, 0],
      count: 1
    });
  }

  return requiredItems;
}

// ============================================================
// ブース仕様生成（テンプレートベース）
// ============================================================
function generateSpec({ client, event, budget, size, requirements, caseId }) {
  const boothSize = BOOTH_SIZE_MAP[size] || BOOTH_SIZE_MAP['3x3'];

  // アイテム生成
  const items = selectAssetsForBudget(budget, boothSize, requirements);

  // ビュー設定
  const views = ['persp_front_left', 'persp_front_right', 'top'];

  // タイトル自動生成
  const title = `${client ? client + ' ' : ''}展示ブース（${size}）`;

  return {
    case_id: caseId,
    title,
    booth: {
      w_mm: boothSize.w_mm,
      d_mm: boothSize.d_mm,
      height_limit_mm: boothSize.height_limit_mm,
      open_sides: [...boothSize.open_sides],
      walls: [...boothSize.walls]
    },
    items,
    views
  };
}

// ============================================================
// 予算配分計算
// ============================================================
function budgetBreakdown(budget) {
  return [
    { category: '企画・設計', amount: Math.round(budget * 0.10) },
    { category: '構造部材',   amount: Math.round(budget * 0.40) },
    { category: 'グラフィック・サイン', amount: Math.round(budget * 0.20) },
    { category: '映像・デジタル', amount: Math.round(budget * 0.15) },
    { category: '施工・運営', amount: Math.round(budget * 0.15) }
  ];
}

// ============================================================
// アセンブルプロンプト（dry-run 用）
// ============================================================
function assemblePrompt(args) {
  let prefix = '';
  try {
    if (existsSync(CACHE_PREFIX_FILE)) {
      prefix = readFileSync(CACHE_PREFIX_FILE, 'utf-8');
    }
  } catch {
    prefix = '# ブース仕様生成コンテキスト（読み込み失敗）\n';
  }

  const inputSection = `
## 入力パラメータ
- クライアント: ${args.client || '(未指定)'}
- イベント: ${args.event || '(未指定)'}
- 予算: ${args.budget || 300}万円
- サイズ: ${args.size || '3x3'}
- 要件: ${args.requirements || '(なし)'}
- モード: ${args.batch ? 'バッチ' : '単一'}
`;
  return prefix + inputSection;
}

// ============================================================
// スケルトン出力（dry-run 用）
// ============================================================
function specSkeleton(args) {
  const boothSize = BOOTH_SIZE_MAP[args.size] || BOOTH_SIZE_MAP['3x3'];
  return {
    case_id: '{自動生成}',
    title: `${args.client || '(クライアント名)'} 展示ブース（${args.size}）`,
    booth: {
      w_mm: boothSize.w_mm,
      d_mm: boothSize.d_mm,
      height_limit_mm: boothSize.height_limit_mm,
      open_sides: boothSize.open_sides,
      walls: boothSize.walls
    },
    items: [
      { asset_id: 'floor_panel',   pos_mm: '[center]', count: 1 },
      { asset_id: 'system_panel',  pos_mm: '[back_wall]', count: 1 },
      { asset_id: 'display_table', pos_mm: '[display_area]', count: 1 },
      { asset_id: 'monitor(予算>=200万)', pos_mm: '[wall_mount]', count: 1 },
      { asset_id: 'showcase(予算>=200万)', pos_mm: '[corner]', count: 1 }
    ],
    views: ['persp_front_left', 'persp_front_right', 'top'],
    _note: 'これはスケルトンです。--dry-run を外して実際の生成を行ってください。'
  };
}

// ============================================================
// サマリ出力
// ============================================================
function printSummary(spec, budgets, isBatch) {
  console.log('=== ブース仕様生成 サマリ ===');
  console.log(`案件ID:     ${spec.case_id}`);
  console.log(`タイトル:   ${spec.title}`);
  console.log(`ブース:     ${spec.booth.w_mm}×${spec.booth.d_mm}mm`);
  console.log(`アイテム数: ${spec.items.length}`);
  console.log(`ビュー:     ${spec.views.join(', ')}`);

  if (isBatch) {
    console.log('\n--- 予算比較 ---');
    for (const b of budgets) {
      const bd = budgetBreakdown(b);
      console.log(`\n【${b}万円】`);
      for (const item of bd) {
        console.log(`  ${item.category}: ${item.amount}万円`);
      }
    }
  } else {
    console.log('\n--- 予算配分 ---');
    const bd = budgetBreakdown(budgets[0]);
    for (const item of bd) {
      console.log(`  ${item.category}: ${item.amount}万円`);
    }
  }
}

// ============================================================
// バッチ比較表出力
// ============================================================
function printBatchComparison(specs, budgets) {
  console.log('\n=== バッチ比較表 ===');
  console.log(`| 項目 | ${budgets.map(b => `${b}万円`).join(' | ')} |`);
  console.log(`|------|${budgets.map(() => '------|').join('')}`);

  // アイテム数
  console.log(`| アイテム数 | ${specs.map(s => s.items.length).join(' | ')} |`);
  // 床面積
  console.log(`| 床面積 | ${specs.map(s => `${s.booth.w_mm}×${s.booth.d_mm}mm`).join(' | ')} |`);

  // 各予算配分
  const categories = ['企画・設計', '構造部材', 'グラフィック・サイン', '映像・デジタル', '施工・運営'];
  for (const cat of categories) {
    const vals = budgets.map(b => {
      const bd = budgetBreakdown(b);
      const found = bd.find(x => x.category === cat);
      return found ? `${found.amount}万円` : '-';
    });
    console.log(`| ${cat} | ${vals.join(' | ')} |`);
  }
}

// ============================================================
// メインエントリ
// ============================================================
async function main() {
  const args = parseArgs(process.argv);
  const budgets = parseBudget(args.budget);
  const isBatch = args.batch && budgets.length > 1;
  const size = args.size || '3x3';

  // サイズ検証
  if (!BOOTH_SIZE_MAP[size]) {
    console.error(`エラー: 未対応のサイズ "${size}"。対応サイズ: ${Object.keys(BOOTH_SIZE_MAP).join(', ')}`);
    process.exit(1);
  }

  // dry-run モード
  if (args.dryRun) {
    const prompt = assemblePrompt(args);
    const skeleton = specSkeleton(args);
    console.log('=== アセンブルドプロンプト ===');
    console.log(prompt);
    console.log('\n=== スペックスケルトン ===');
    console.log(JSON.stringify(skeleton, null, 2));
    return;
  }

  // 通常生成
  if (isBatch) {
    // バッチモード：複数予算でそれぞれ生成
    const specs = budgets.map((budget, i) => {
      const caseId = args.caseId || generateCaseId().replace(/-v1$/, `-b${i + 1}-v1`);
      const spec = generateSpec({ ...args, budget, size, caseId: args.caseId ? `${caseId}-b${i + 1}-v1` : caseId });
      assertValidSpec(spec);
      return spec;
    });

    // キャッシュ・ファイル保存
    for (const spec of specs) {
      try {
        save(DEFAULT_CACHE_DIR, spec);
      } catch {
        // キャッシュ保存失敗は無視
      }

      if (args.output) {
        const outputPath = args.output.replace('{case_id}', spec.case_id);
        const dir = dirname(outputPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');
        console.log(`出力: ${outputPath}`);
      }
    }

    // サマリ
    for (const spec of specs) {
      printSummary(spec, budgets, false);
      console.log('');
    }
    printBatchComparison(specs, budgets);

  } else {
    // 単一生成
    const budget = budgets[0];
    const caseId = args.caseId || generateCaseId();
    const spec = generateSpec({ ...args, budget, size, caseId });
    assertValidSpec(spec);

    // キャッシュ保存
    try {
      save(DEFAULT_CACHE_DIR, spec);
    } catch {
      // キャッシュ保存失敗は無視
    }

    // ファイル出力
    if (args.output) {
      const outputPath = args.output.replace('{case_id}', spec.case_id);
      const dir = dirname(outputPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');
      console.log(`出力: ${outputPath}`);
    }

    // サマリ
    printSummary(spec, budgets, false);
  }
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
