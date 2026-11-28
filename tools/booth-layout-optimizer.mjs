#!/usr/bin/env node
/**
 * booth-layout-optimizer.mjs — X-0074: ブース什器配置最適化エージェント
 *
 * ゾーン計画と予算・要件から、各ゾーン内の最適な什器・備品配置を生成する。
 * 通路幅・可視性・運用効率を考慮した配置を計算する。
 *
 * 使い方:
 *   node tools/booth-layout-optimizer.mjs --zone-plan <plan.json> [--budget <円>] [--out <output.json>]
 *   node tools/booth-layout-optimizer.mjs --sample
 */
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// ---- 什器テンプレート ----

/** 標準什器カタログ（種別・寸法mm・想定価格・ゾーン適合） */
export const EQUIPMENT_CATALOG = Object.freeze({
  counter_table: { label: 'カウンターテーブル', w_mm: 900, d_mm: 450, h_mm: 700, price: 15000, zones: ['reception'], icon: 'counter' },
  display_shelf: { label: '展示シェルフ', w_mm: 1200, d_mm: 400, h_mm: 1800, price: 35000, zones: ['display'], icon: 'shelf' },
  panel_screen:  { label: 'パネルスクリーン', w_mm: 1800, d_mm: 40, h_mm: 2400, price: 45000, zones: ['display', 'meeting'], icon: 'panel' },
  meeting_table: { label: '商談テーブル', w_mm: 1200, d_mm: 700, h_mm: 700, price: 25000, zones: ['meeting'], icon: 'table' },
  chair:         { label: 'チェア', w_mm: 500, d_mm: 500, h_mm: 800, price: 8000, zones: ['meeting', 'reception'], icon: 'chair' },
  demo_pedestal: { label: 'デモ台', w_mm: 600, d_mm: 450, h_mm: 900, price: 12000, zones: ['demo'], icon: 'pedestal' },
  brochure_rack: { label: 'パンフレットラック', w_mm: 400, d_mm: 300, h_mm: 1500, price: 8000, zones: ['reception', 'display'], icon: 'rack' },
  storage_box:   { label: '收納ボックス', w_mm: 600, d_mm: 600, h_mm: 600, price: 5000, zones: ['storage'], icon: 'box' },
  monitor_stand: { label: 'モニタースタンド', w_mm: 800, d_mm: 600, h_mm: 1500, price: 30000, zones: ['display', 'reception'], icon: 'monitor' },
  led_sign:      { label: 'LEDサインボード', w_mm: 2000, d_mm: 100, h_mm: 500, price: 55000, zones: ['reception'], icon: 'sign' },
});

/** 什器タイプのカラー */
export const EQUIPMENT_COLORS = Object.freeze({
  counter: '#dbeafe',
  shelf: '#dcfce7',
  table: '#fef9c3',
  chair: '#f3e8ff',
  panel: '#fee2e2',
  box: '#e2e8f0',
  pedestal: '#cffafe',
  rack: '#f1f5f9',
  monitor: '#e0e7ff',
  sign: '#fce7f3',
  other: '#f8fafc',
});

// ---- 検証 ----

const required = s => typeof s === 'string' && s.trim().length > 0;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * レイアウト案を検証する
 * @param {object} plan - レイアウト計画
 * @returns {{ ok: boolean, errors: string[], warnings: string[], totalCost: number }}
 */
export function validateLayoutPlan(plan) {
  const errors = [];
  const warnings = [];
  let totalCost = 0;

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    errors.push('レイアウト計画はオブジェクトが必要です');
    return { ok: false, errors, warnings, totalCost: 0 };
  }

  if (!positive(plan.booth?.w_mm)) errors.push('booth.w_mm は正の数が必要です');
  if (!positive(plan.booth?.d_mm)) errors.push('booth.d_mm は正の数が必要です');

  if (!Array.isArray(plan.items)) {
    errors.push('items は配列が必要です');
    return { ok: false, errors, warnings, totalCost: 0 };
  }

  const boothW = plan.booth?.w_mm || Infinity;
  const boothD = plan.booth?.d_mm || Infinity;
  const ids = new Set();
  const rects = [];

  plan.items.forEach((item, index) => {
    const id = required(item.id) ? item.id : `項目${index + 1}`;

    if (!required(item.id)) errors.push(`items[${index}]: id は必須です`);
    else if (ids.has(item.id)) errors.push(`ID重複: ${item.id}`);
    ids.add(item.id);

    if (!required(item.type)) errors.push(`${id}: type は必須です`);
    if (!required(item.label)) errors.push(`${id}: label は必須です`);

    for (const key of ['x_mm', 'y_mm']) {
      if (!nonnegative(item[key])) errors.push(`${id}: ${key} は0以上が必要です`);
    }
    for (const key of ['w_mm', 'd_mm']) {
      if (!positive(item[key])) errors.push(`${id}: ${key} は正の数が必要です`);
    }

    if (item.price !== undefined && !nonnegative(item.price)) errors.push(`${id}: price は0以上が必要です`);
    totalCost += item.price || 0;

    if ([item.x_mm, item.y_mm, item.w_mm, item.d_mm].every(n => typeof n === 'number')) {
      if (item.x_mm + item.w_mm > boothW) errors.push(`${id}: 幅超過`);
      if (item.y_mm + item.d_mm > boothD) errors.push(`${id}: 奥行超過`);

      for (const prev of rects) {
        if (item.x_mm < prev.x + prev.w && prev.x < item.x_mm + item.w_mm &&
            item.y_mm < prev.y + prev.d && prev.y < item.y_mm + item.d_mm) {
          warnings.push(`重なり: ${prev.id} x ${id}`);
        }
      }
      rects.push({ id, x: item.x_mm, y: item.y_mm, w: item.w_mm, d: item.d_mm });
    }
  });

  return { ok: errors.length === 0, errors, warnings, totalCost };
}

// ---- 配置アルゴリズム ----

/**
 * ゾーン計画から最適什器配置を生成する
 * @param {object} zonePlan - planZones() の出力形式
 * @param {object} [options]
 * @param {number} [options.budget] - 予算上限（円）
 * @param {string[]} [options.priority_items] - 優先する什器ID
 * @returns {{ items: object[], zones: object[], totalCost: number, warnings: string[], meta: object }}
 */
export function optimizeLayout(zonePlan, options = {}) {
  const warnings = [];
  const { budget, priority_items = [] } = options;
  const subOptimal = []; // 予算超過時に削った項目

  if (!zonePlan || !Array.isArray(zonePlan.zones)) {
    throw new Error('zonePlan.zones は配列が必要です');
  }

  const width = zonePlan.meta?.width_mm || 3000;
  const depth = zonePlan.meta?.depth_mm || 3000;
  const minAisle = zonePlan.meta?.min_aisle_mm || 600;

  const items = [];
  let totalCost = 0;

  // 各ゾーンに適した什器を選択
  for (const zone of zonePlan.zones) {
    // そのゾーンに適した什器を優先度順に取得
    const suitable = Object.entries(EQUIPMENT_CATALOG)
      .filter(([_, eq]) => eq.zones.includes(zone.type));
    if (suitable.length === 0) continue;

    // 優先項目を先に配置
    suitable.sort(([aId], [bId]) => {
      const aPri = priority_items.includes(aId) ? 0 : 1;
      const bPri = priority_items.includes(bId) ? 0 : 1;
      return aPri - bPri;
    });

    let xOffset = zone.x_mm + minAisle / 2;
    const yCenter = zone.y_mm + zone.d_mm / 2;
    let maxDepthUsed = zone.d_mm;

    // 優先項目の配置
    for (const [eqId, eq] of suitable) {
      if (budget !== undefined && budget !== null && totalCost + eq.price > budget) {
        subOptimal.push(eqId);
        continue;
      }

      // ゾーン幅に収まるか確認
      if (xOffset + eq.w_mm > zone.x_mm + zone.w_mm - minAisle / 2) {
        // 次の行へ
        xOffset = zone.x_mm + minAisle / 2;
        const rowDepth = maxDepthUsed + eq.d_mm + minAisle;
        if (rowDepth > zone.d_mm) {
          warnings.push(`${zone.id}: ゾーン容量不足（${eq.label}を配置できません）`);
          continue;
        }
        maxDepthUsed = rowDepth;
      }

      const yPos = zone.type === 'reception'
        ? zone.y_mm + zone.d_mm - eq.d_mm // 受付は前面（通路側）に配置
        : yCenter - eq.d_mm / 2;

      const placedY = Math.max(zone.y_mm, Math.min(yPos, zone.y_mm + zone.d_mm - eq.d_mm));

      items.push({
        id: `${eqId}_${zone.id}`,
        type: eq.icon,
        label: eq.label,
        x_mm: Math.round(xOffset),
        y_mm: Math.round(placedY),
        w_mm: eq.w_mm,
        d_mm: eq.d_mm,
        h_mm: eq.h_mm,
        price: eq.price,
        zone: zone.id,
        color: EQUIPMENT_COLORS[eq.icon] || EQUIPMENT_COLORS.other,
      });

      totalCost += eq.price;
      xOffset += eq.w_mm + minAisle;
    }
  }

  // 予算超過時の調整
  if (budget !== undefined && budget !== null && totalCost > budget) {
    warnings.push(`予算超過: ¥${totalCost} > ¥${budget}`);
    // 最適化: 予算内に収まらない項目を削除（優先度低いものから）
    items.sort((a, b) => {
      const zonePriA = Object.entries(EQUIPMENT_CATALOG).find(([_, eq]) => eq.label === a.label)?.[1]?.price || 0;
      const zonePriB = Object.entries(EQUIPMENT_CATALOG).find(([_, eq]) => eq.label === b.label)?.[1]?.price || 0;
      return zonePriB - zonePriA;
    });
    while (totalCost > budget && items.length > 0) {
      const removed = items.pop();
      totalCost -= removed.price;
      warnings.push(`予算調整: ${removed.label}を削除（-¥${removed.price}）`);
    }
  }

  // 重なりチェック
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.x_mm < b.x_mm + b.w_mm && b.x_mm < a.x_mm + a.w_mm &&
          a.y_mm < b.y_mm + b.d_mm && b.y_mm < a.y_mm + a.d_mm) {
        warnings.push(`什器重なり: ${a.id} x ${b.id}`);
      }
    }
  }

  // 通路幅チェック（前面帯の最小通路幅）
  const frontItems = items.filter(i => i.y_mm < minAisle);
  if (frontItems.length > 0) {
    const totalFrontW = frontItems.reduce((s, i) => s + i.w_mm, 0);
    if (totalFrontW > width * 0.7) {
      warnings.push('前面開口が狭いです（什器が70%以上を占有）');
    }
  }

  return {
    items,
    zones: zonePlan.zones,
    totalCost,
    warnings,
    meta: {
      width_mm: width,
      depth_mm: depth,
      item_count: items.length,
      total_cost: totalCost,
      budget: budget || null,
      within_budget: budget ? totalCost <= budget : true,
      removed_items: subOptimal,
    },
  };
}

/**
 * 配置をSVGで可視化する
 * @param {object} layout - optimizeLayout() の出力
 * @returns {string} SVG文字列
 */
export function renderLayoutSvg(layout) {
  if (!layout || !Array.isArray(layout?.items) || !Array.isArray(layout?.zones)) throw new Error('レイアウトデータが必要です');
  const width = layout.meta.width_mm;
  const depth = layout.meta.depth_mm;
  const scale = Math.min(900 / width, 600 / depth) * 0.85;
  const svgW = width * scale + 200;
  const svgH = depth * scale + 500;

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 ${svgW + 200} ${svgH + 500}" font-family="sans-serif">`,
    `<rect x="0" y="0" width="${width * scale}" height="${depth * scale}" fill="#f8fafc" stroke="#94a3b8" stroke-width="3"/>`,
  ];

  // ゾーン背景
  for (const zone of layout.zones) {
    const zx = zone.x_mm * scale;
    const zy = zone.y_mm * scale;
    const zw = zone.w_mm * scale;
    const zd = zone.d_mm * scale;
    const zcolor = zone.color || '#f1f5f9';
    lines.push(
      `<rect x="${zx}" y="${zy}" width="${zw}" height="${zd}" fill="${zcolor}" fill-opacity="0.25" stroke="#cbd5e1" stroke-width="2" rx="3"/>`,
    );
  }

  // 什器
  for (const item of layout.items) {
    const x = item.x_mm * scale;
    const y = item.y_mm * scale;
    const w = item.w_mm * scale;
    const d = item.d_mm * scale;
    const cx = x + w / 2;
    const cy = y + d / 2;
    const color = item.color || '#e2e8f0';

    lines.push(
      `<rect x="${x}" y="${y}" width="${Math.max(w, 4)}" height="${Math.max(d, 4)}" fill="${color}" stroke="#475569" stroke-width="2" rx="2"/>`,
      `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="${Math.min(Math.max(Math.min(w, d) / 6, 8), 14)}">${item.label}</text>`,
      `<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9" fill="#64748b">${item.w_mm}×${item.d_mm}</text>`,
    );
  }

  // 情報
  const costStr = layout.totalCost > 0 ? `¥${layout.totalCost.toLocaleString()}` : '¥0';
  const budgetStr = layout.meta.budget ? ` / 予算¥${layout.meta.budget.toLocaleString()}` : '';
  lines.push(
    `<g transform="translate(0 ${depth * scale + 40})">`,
    `<rect x="0" y="0" width="${width * scale}" height="360" fill="#f8fafc"/>`,
    `<text x="20" y="40" font-size="18" font-weight="bold">ブース什器配置計画</text>`,
    `<text x="20" y="80" font-size="15">寸法: ${width}×${depth}mm (${(width * depth / 1e6).toFixed(1)}m²)</text>`,
    `<text x="20" y="110" font-size="15">什器数: ${layout.items.length}</text>`,
    `<text x="20" y="140" font-size="15">見積: ${costStr}${budgetStr}</text>`,
    layout.meta.within_budget ? '' : `<text x="20" y="170" font-size="15" fill="#dc2626">⚠ 予算超過</text>`,
    `</g>`,
    '</svg>',
  );

  return lines.join('\n');
}

// ---- CLI ----

function printHelp() {
  console.log(`booth-layout-optimizer.mjs — X-0074: ブース什器配置最適化エージェント

使い方:
  node tools/booth-layout-optimizer.mjs --zone-plan <plan.json> ゾーン計画から配置生成
  node tools/booth-layout-optimizer.mjs --zone-plan <plan.json> --budget 500000 予算指定
  node tools/booth-layout-optimizer.mjs --sample  サンプル表示
  node tools/booth-layout-optimizer.mjs --validate <plan.json>  レイアウト検証

対応什器カテゴリ:
  ${Object.keys(EQUIPMENT_CATALOG).join(', ')}`);
}

function printSample() {
  // ゾーン計画のサンプル
  const sampleZones = {
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 2700, d_mm: 1000, priority: 1, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 1000, w_mm: 3000, d_mm: 1200, priority: 2, color: '#dcfce7' },
      { id: 'meeting', type: 'meeting', label: '商談', x_mm: 0, y_mm: 2200, w_mm: 3000, d_mm: 800, priority: 3, color: '#fef9c3' },
    ],
    meta: { width_mm: 3000, depth_mm: 3000, min_aisle_mm: 600 },
  };

  const result = optimizeLayout(sampleZones, { budget: 500000 });

  console.log('=== 什器配置計画 ===\n');
  console.log(`ゾーン数: ${result.zones.length}`);
  console.log(`什器数: ${result.items.length}`);
  console.log(`総コスト: ¥${result.totalCost.toLocaleString()}\n`);

  console.log('什器一覧:');
  console.log('| ID | ラベル | X | Y | W | D | 価格 | ゾーン |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const item of result.items) {
    console.log(`| ${item.id.padEnd(20)} | ${item.label.padEnd(14)} | ${String(item.x_mm).padEnd(4)} | ${String(item.y_mm).padEnd(4)} | ${String(item.w_mm).padEnd(4)} | ${String(item.d_mm).padEnd(4)} | ¥${String(item.price).padEnd(8)} | ${item.zone || ''} |`);
  }

  if (result.warnings.length > 0) {
    console.log('\n警告/情報:');
    result.warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('\n--- SVG ---');
  console.log(renderLayoutSvg(result));
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--sample')) {
    printSample();
  } else if (args.includes('--help')) {
    printHelp();
  } else if (args.includes('--validate')) {
    const idx = args.indexOf('--validate');
    const planPath = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    if (!planPath) { console.error('--validate にはJSONファイルのパスが必要です'); process.exitCode = 1; }
    else {
      try {
        const plan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8'));
        const result = validateLayoutPlan(plan);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`検証エラー: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } else if (args.includes('--zone-plan')) {
    const idx = args.indexOf('--zone-plan');
    const planPath = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    const budgetIdx = args.indexOf('--budget');
    const budget = budgetIdx + 1 < args.length && !args[budgetIdx + 1].startsWith('--') ? Number(args[budgetIdx + 1]) : undefined;
    const outIdx = args.indexOf('--out');
    const outPath = outIdx + 1 < args.length && !args[outIdx + 1].startsWith('--') ? args[outIdx + 1] : null;

    if (!planPath) { console.error('--zone-plan にはJSONファイルのパスが必要です'); process.exitCode = 1; }
    else {
      try {
        const zonePlan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8'));
        const result = optimizeLayout(zonePlan, { budget: budget && !Number.isNaN(budget) ? budget : undefined });
        const output = JSON.stringify(result, null, 2);
        if (outPath) {
          fs.writeFileSync(path.resolve(outPath), output, 'utf8');
          console.log(`配置計画を ${outPath} に出力しました`);
        } else {
          console.log(output);
        }
      } catch (err) {
        console.error(`エラー: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } else {
    printHelp();
  }
}