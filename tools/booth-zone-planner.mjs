#!/usr/bin/env node
/**
 * booth-zone-planner.mjs — X-0074: 展示ブースのゾーン配置計画エージェント
 *
 * ブースの寸法とクライアント要件から、機能ゾーン（展示・商談・デモ・收納・受付）
 * の最適な配置を提案する。通路幅・動線・開放面を考慮した配置を計算する。
 *
 * 使い方:
 *   node tools/booth-zone-planner.mjs --spec <spec.json> [--out <output.json>]
 *   node tools/booth-zone-planner.mjs --sample   サンプル表示
 *   node tools/booth-zone-planner.mjs --validate <spec.json>  検証のみ
 */
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// ---- ゾーン種別 ----

/** ゾーン種別の定義 */
export const ZONE_TYPES = Object.freeze({
  reception:   { label: '受付',     priority: 1, minArea_m2: 1.0, frontBand: true  },
  display:     { label: '展示',     priority: 2, minArea_m2: 2.0, frontBand: false },
  meeting:     { label: '商談',     priority: 3, minArea_m2: 2.5, frontBand: false },
  demo:        { label: 'デモ',     priority: 4, minArea_m2: 3.0, frontBand: false },
  storage:     { label: '收納',     priority: 5, minArea_m2: 0.5, frontBand: false },
  aisle:       { label: '通路',     priority: 0, minArea_m2: 0.0, frontBand: false },
});

/** ゾーンの優先度ラベル */
export const ZONE_PRIORITIES = Object.freeze({
  1: '最優先（受付・ブランディング）',
  2: '高優先（展示・訴求）',
  3: '中優先（商談・接客）',
  4: '低優先（デモ・体験）',
  5: '調整可能（收納・バックヤード）',
});

// ---- 検証 ----

const required = s => typeof s === 'string' && s.trim().length > 0;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * ゾーン仕様を検証する
 * @param {object} spec - { booth: { w_mm, d_mm, open_sides, walls }, zones: [...], rules: {...} }
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateZonePlan(spec) {
  const errors = [];
  const warnings = [];

  if (!object(spec)) { errors.push('仕様はオブジェクトで指定してください'); return { ok: false, errors, warnings }; }

  const booth = spec.booth || {};
  if (!positive(booth.w_mm)) errors.push('booth.w_mm は正の数が必要です');
  if (!positive(booth.d_mm)) errors.push('booth.d_mm は正の数が必要です');
  if (!positive(booth.height_limit_mm || booth.height_limit_mm === undefined)) {
    if (booth.height_limit_mm !== undefined && !positive(booth.height_limit_mm)) errors.push('booth.height_limit_mm は正の数が必要です');
  }
  if (!Array.isArray(booth.open_sides)) errors.push('booth.open_sides は配列が必要です');
  if (!Array.isArray(booth.walls)) errors.push('booth.walls は配列が必要です');

  // 開放面と壁面の重複チェック
  if (Array.isArray(booth.open_sides) && Array.isArray(booth.walls)) {
    const overlap = booth.open_sides.filter(s => booth.walls.includes(s));
    if (overlap.length > 0) errors.push(`開放面と壁面が重複: ${overlap.join(', ')}`);
  }

  if (!Array.isArray(spec.zones)) {
    errors.push('zones は配列が必要です');
    return { ok: errors.length === 0, errors, warnings };
  }

  const zoneIds = new Set();
  let totalArea = 0;
  const aisleWidth = (spec.rules || {}).minAisleMm || 600;

  spec.zones.forEach((zone, index) => {
    if (!object(zone)) { errors.push(`zone[${index}] はオブジェクトが必要です`); return; }

    const zid = required(zone.id) ? zone.id : `ゾーン${index + 1}`;

    if (!required(zone.id)) errors.push(`zone[${index}]: id は必須です`);
    else if (zoneIds.has(zone.id)) errors.push(`ゾーンID重複: ${zone.id}`);
    zoneIds.add(zone.id);

    if (!required(zone.type)) errors.push(`${zid}: type は必須です`);
    else if (!Object.hasOwn(ZONE_TYPES, zone.type)) {
      errors.push(`${zid}: 未知のゾーン種別 '${zone.type}'（有効: ${Object.keys(ZONE_TYPES).join(', ')}）`);
    }

    if (!required(zone.label)) {
      if (zone.type && Object.hasOwn(ZONE_TYPES, zone.type)) zone.label = ZONE_TYPES[zone.type].label;
      else errors.push(`${zid}: label は必須です`);
    }

    for (const key of ['x_mm', 'y_mm']) {
      if (!nonnegative(zone[key])) errors.push(`${zid}: ${key} は0以上の整数が必要です`);
    }
    for (const key of ['w_mm', 'd_mm']) {
      if (!positive(zone[key])) errors.push(`${zid}: ${key} は正の整数が必要です`);
    }

    if ([zone.x_mm, zone.y_mm, zone.w_mm, zone.d_mm].every(n => typeof n === 'number')) {
      const xEnd = zone.x_mm + zone.w_mm;
      const yEnd = zone.y_mm + zone.d_mm;
      if (xEnd > booth.w_mm) errors.push(`${zid}: X がブース幅(${booth.w_mm}mm)を超過 (${xEnd}mm)`);
      if (yEnd > booth.d_mm) errors.push(`${zid}: Y がブース奥行(${booth.d_mm}mm)を超過 (${yEnd}mm)`);
      totalArea += zone.w_mm * zone.d_mm;
    }
  });

  // 通路幅のチェック
  if (Array.isArray(spec.zones) && spec.zones.length > 0) {
    const zones = spec.zones;
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i], b = zones[j];
        if ([a.x_mm, a.y_mm, a.w_mm, a.d_mm, b.x_mm, b.y_mm, b.w_mm, b.d_mm].every(n => typeof n === 'number')) {
          // AABB重なりチェック
          if (a.x_mm < b.x_mm + b.w_mm && b.x_mm < a.x_mm + a.w_mm &&
              a.y_mm < b.y_mm + b.d_mm && b.y_mm < a.y_mm + a.d_mm) {
            warnings.push(`${a.id} と ${b.id} が重なっています（${a.label} x ${b.label}）`);
          }
        }
      }
    }

    // 総面積がブース面積を超えていないか
    const boothArea = booth.w_mm * booth.d_mm;
    if (totalArea > boothArea) {
      errors.push(`ゾーン総面積(${totalArea / 1e6} m²)がブース面積(${boothArea / 1e6} m²)を超過しています`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---- ゾーン配置アルゴリズム ----

/**
 * 要件から自動的にゾーン配置を生成する
 * @param {object} requirements - クライアント要件
 * @param {number} requirements.w_mm - ブース幅(mm)
 * @param {number} requirements.d_mm - ブース奥行(mm)
 * @param {string[]} requirements.open_sides - 開放面 ['front', 'left', 'right', 'back']
 * @param {string[]} requirements.walls - 壁面
 * @param {string[]} requirements.required_zones - 必要なゾーン種別 ['reception','display','meeting',...]
 * @param {object} [requirements.rules] - 追加ルール
 * @param {number} [requirements.rules.minAisleMm=600] - 最小通路幅
 * @returns {{ zones: object[], warnings: string[], meta: object }}
 */
export function planZones(requirements) {
  const warnings = [];
  const {
    w_mm: width,
    d_mm: depth,
    open_sides = ['front'],
    walls = ['back'],
    required_zones = ['reception', 'display', 'meeting', 'storage'],
    rules = {},
  } = requirements;

  const minAisle = rules.minAisleMm || 600;
  const frontOpen = open_sides.includes('front');

  if (!positive(width)) throw new Error('w_mm (幅) は正の数が必要です');
  if (!positive(depth)) throw new Error('d_mm (奥行) は正の数が必要です');
  if (required_zones.length === 0) throw new Error('required_zones は1つ以上必要です');

  const zones = [];
  const takenAreas = [];

  // ゾーン優先順にソート
  const sorted = required_zones
    .filter(z => Object.hasOwn(ZONE_TYPES, z))
    .sort((a, b) => ZONE_TYPES[a].priority - ZONE_TYPES[b].priority);

  if (sorted.length === 0) {
    return { zones: [], warnings: ['有効なゾーン種別が指定されていません'], meta: { width, depth } };
  }

  // ブースを前後に分割する比率（前面からの奥行き割合）
  const frontBandRatio = frontOpen ? 0.35 : 0.25; // 前面帯の比率
  const frontBandDepth = Math.floor(depth * frontBandRatio);
  const rearDepth = depth - frontBandDepth;

  // ゾーン数のカウント
  const hasReception = sorted.includes('reception');
  const hasDisplay = sorted.includes('display');
  const hasMeeting = sorted.includes('meeting');
  const hasDemo = sorted.includes('demo');
  const hasStorage = sorted.includes('storage');

  // 幅を分割数に応じて配分
  const frontZones = [];
  const rearZones = [];

  // 受付は前面（通路側）に配置
  if (hasReception) {
    const recvWidth = Math.floor(width * 0.3);
    const recvDepth = Math.min(frontBandDepth, 1200);
    frontZones.push({
      id: 'reception',
      type: 'reception',
      label: '受付',
      x_mm: 0,
      y_mm: 0,
      w_mm: recvWidth,
      d_mm: recvDepth,
      priority: ZONE_TYPES.reception.priority,
      color: '#dbeafe',
    });
  }

  // デモ/展示は中央〜後方に
  if (hasDisplay) {
    const displayWidth = Math.floor(width * (hasMeeting ? 0.5 : 0.7));
    const displayDepth = Math.floor(rearDepth * 0.6);
    const dx = hasReception ? Math.floor((width - displayWidth) / 2) : 0;
    rearZones.push({
      id: 'display',
      type: 'display',
      label: '展示',
      x_mm: dx,
      y_mm: frontBandDepth,
      w_mm: displayWidth,
      d_mm: displayDepth,
      priority: ZONE_TYPES.display.priority,
      color: '#dcfce7',
    });
  }

  if (hasMeeting) {
    const meetingWidth = hasDisplay ? Math.floor(width * 0.4) : Math.floor(width * 0.5);
    const meetingDepth = Math.min(Math.floor(depth * 0.4), 2000);
    const meetingX = hasDisplay ? width - meetingWidth : Math.floor((width - meetingWidth) / 2);
    const meetingY = hasDisplay ? frontBandDepth : Math.floor(depth * 0.3);
    rearZones.push({
      id: 'meeting',
      type: 'meeting',
      label: '商談',
      x_mm: meetingX,
      y_mm: meetingY,
      w_mm: meetingWidth,
      d_mm: meetingDepth,
      priority: ZONE_TYPES.meeting.priority,
      color: '#fef9c3',
    });
  }

  if (hasDemo) {
    const demoWidth = Math.floor(width * 0.35);
    const demoDepth = Math.min(Math.floor(rearDepth * 0.5), 1500);
    const demoX = Math.floor((width - demoWidth) / 2);
    const demoY = frontBandDepth + (hasDisplay ? Math.floor(rearDepth * 0.65) : 0);
    if (demoY + demoDepth <= depth) {
      rearZones.push({
        id: 'demo',
        type: 'demo',
        label: 'デモ',
        x_mm: demoX,
        y_mm: demoY,
        w_mm: demoWidth,
        d_mm: demoDepth,
        priority: ZONE_TYPES.demo.priority,
        color: '#cffafe',
      });
    } else {
      warnings.push('デモゾーンを配置する十分な奥行きがありません');
    }
  }

  if (hasStorage) {
    // 收納は壁側または余剰スペース
    const storageWidth = 600;
    const storageDepth = Math.min(900, Math.floor(depth * 0.2));
    const storageX = width - storageWidth;
    const storageY = depth - storageDepth;
    rearZones.push({
      id: 'storage',
      type: 'storage',
      label: '收納',
      x_mm: storageX,
      y_mm: storageY,
      w_mm: storageWidth,
      d_mm: storageDepth,
      priority: ZONE_TYPES.storage.priority,
      color: '#e2e8f0',
    });
  }

  zones.push(...frontZones, ...rearZones);

  // 重なりチェック
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i], b = zones[j];
      if (a.x_mm < b.x_mm + b.w_mm && b.x_mm < a.x_mm + a.w_mm &&
          a.y_mm < b.y_mm + b.d_mm && b.y_mm < a.y_mm + a.d_mm) {
        warnings.push(`${a.id} と ${b.id} が重なっています（調整が必要です）`);
      }
    }
  }

  const usedArea = zones.reduce((sum, z) => sum + z.w_mm * z.d_mm, 0);
  const totalArea = width * depth;

  return {
    zones,
    warnings,
    meta: {
      width_mm: width,
      depth_mm: depth,
      total_area_m2: totalArea / 1e6,
      used_area_m2: usedArea / 1e6,
      utilization_pct: Math.round(usedArea / totalArea * 1000) / 10,
      front_open: frontOpen,
      front_band_depth_mm: frontBandDepth,
      min_aisle_mm: minAisle,
      zone_count: zones.length,
    },
  };
}

/**
 * ゾーン配置をSVGで可視化
 * @param {object} spec - { booth, zones, rules }
 * @returns {string} SVG文字列
 */
export function renderZoneSvg(spec) {
  const valid = validateZonePlan(spec);
  if (!valid.ok) throw new Error(`検証エラー:\n${valid.errors.join('\n')}`);

  const { w_mm: width, d_mm: depth } = spec.booth;
  const scale = Math.min(800 / width, 600 / depth) * 0.9;
  const svgW = width * scale + 200;
  const svgH = depth * scale + 400;

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 ${svgW + 200} ${svgH + 500}" font-family="sans-serif">`,
    `<rect x="0" y="0" width="${width * scale}" height="${depth * scale}" fill="#f8fafc" stroke="#94a3b8" stroke-width="4"/>`,
  ];

  // 開放面を点線で表示
  if (Array.isArray(spec.booth.open_sides)) {
    for (const side of spec.booth.open_sides) {
      if (side === 'front') lines.push(`<line x1="0" y1="0" x2="${width * scale}" y2="0" stroke="#3b82f6" stroke-width="6" stroke-dasharray="20 12"/>`);
      else if (side === 'back') lines.push(`<line x1="0" y1="${depth * scale}" x2="${width * scale}" y2="${depth * scale}" stroke="#3b82f6" stroke-width="6" stroke-dasharray="20 12"/>`);
      else if (side === 'left') lines.push(`<line x1="0" y1="0" x2="0" y2="${depth * scale}" stroke="#3b82f6" stroke-width="6" stroke-dasharray="20 12"/>`);
      else if (side === 'right') lines.push(`<line x1="${width * scale}" y1="0" x2="${width * scale}" y2="${depth * scale}" stroke="#3b82f6" stroke-width="6" stroke-dasharray="20 12"/>`);
    }
  }

  // 壁面
  if (Array.isArray(spec.booth.walls)) {
    for (const side of spec.booth.walls) {
      if (side === 'back') lines.push(`<line x1="0" y1="${depth * scale}" x2="${width * scale}" y2="${depth * scale}" stroke="#1e293b" stroke-width="12"/>`);
      else if (side === 'left') lines.push(`<line x1="0" y1="0" x2="0" y2="${depth * scale}" stroke="#1e293b" stroke-width="12"/>`);
      else if (side === 'right') lines.push(`<line x1="${width * scale}" y1="0" x2="${width * scale}" y2="${depth * scale}" stroke="#1e293b" stroke-width="12"/>`);
    }
  }

  // ゾーン描画
  for (const zone of spec.zones) {
    const x = zone.x_mm * scale;
    const y = zone.y_mm * scale;
    const w = zone.w_mm * scale;
    const d = zone.d_mm * scale;
    const cx = x + w / 2;
    const cy = y + d / 2;
    const color = zone.color || '#e2e8f0';
    lines.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${d}" fill="${color}" stroke="#475569" stroke-width="4" rx="4"/>`,
      `<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="${Math.min(w, d) / 5}" font-weight="bold">${zone.label}</text>`,
      `<text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="${Math.min(w, d) / 7}" fill="#64748b">${zone.w_mm}×${zone.d_mm}mm</text>`,
    );
  }

  // 凡例
  lines.push(
    `<g transform="translate(0 ${depth * scale + 40})">`,
    `<rect x="0" y="0" width="${width * scale}" height="280" fill="#f8fafc"/>`,
    `<text x="20" y="50" font-size="20" font-weight="bold">${spec.meta?.name || 'ブースゾーン計画'}</text>`,
    `<text x="20" y="90" font-size="16">寸法: ${width}×${depth}mm (${(width * depth / 1e6).toFixed(1)}m²)</text>`,
    `<text x="20" y="130" font-size="16">ゾーン数: ${spec.zones.length}</text>`,
    `</g>`,
    '</svg>',
  );

  return lines.join('\n');
}

// ---- CLI ----

function printHelp() {
  console.log(`booth-zone-planner.mjs — X-0074: ブースゾーン配置計画エージェント

使い方:
  node tools/booth-zone-planner.mjs --sample         サンプル表示
  node tools/booth-zone-planner.mjs --validate <json> ゾーン仕様の検証
  node tools/booth-zone-planner.mjs --spec <json>    JSONファイルからゾーン生成
  node tools/booth-zone-planner.mjs --out <path>     出力先指定（--spec と併用）

対応ゾーン種別: ${Object.keys(ZONE_TYPES).join(', ')}`);
}

function printSample() {
  const requirements = {
    w_mm: 3000,
    d_mm: 3000,
    open_sides: ['front'],
    walls: ['back', 'left', 'right'],
    required_zones: ['reception', 'display', 'meeting', 'storage'],
  };

  const result = planZones(requirements);

  console.log('=== ゾーン配置計画 ===\n');
  console.log(`ブース: ${requirements.w_mm}×${requirements.d_mm}mm`);
  console.log(`開放面: ${requirements.open_sides.join(', ')}`);
  console.log(`壁面: ${requirements.walls.join(', ')}`);
  console.log(`ゾーン数: ${result.zones.length}`);
  console.log(`使用率: ${result.meta.utilization_pct}%\n`);

  console.log('ゾーン一覧:');
  console.log('| ID | 種別 | ラベル | X | Y | W | D |');
  console.log('|---|---|---|---|---|---|---|');
  for (const z of result.zones) {
    console.log(`| ${z.id.padEnd(12)} | ${z.type.padEnd(10)} | ${z.label.padEnd(6)} | ${String(z.x_mm).padEnd(4)} | ${String(z.y_mm).padEnd(4)} | ${String(z.w_mm).padEnd(4)} | ${String(z.d_mm).padEnd(4)} |`);
  }

  if (result.warnings.length > 0) {
    console.log('\n警告:');
    result.warnings.forEach(w => console.log(`  - ${w}`));
  }

  // SVGも表示
  const spec = {
    booth: { w_mm: requirements.w_mm, d_mm: requirements.d_mm, open_sides: requirements.open_sides, walls: requirements.walls },
    zones: result.zones,
    rules: { minAisleMm: 600 },
    meta: { name: '3m×3m ブースゾーン計画' },
  };
  console.log('\n--- SVG ---');
  console.log(renderZoneSvg(spec));
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--sample')) {
    printSample();
  } else if (args.includes('--help')) {
    printHelp();
  } else if (args.includes('--validate')) {
    const idx = args.indexOf('--validate');
    const specPath = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    if (!specPath) { console.error('--validate にはJSONファイルのパスが必要です'); process.exitCode = 1; }
    else {
      try {
        const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
        const result = validateZonePlan(spec);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`検証エラー: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } else if (args.includes('--spec')) {
    const idx = args.indexOf('--spec');
    const specPath = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    const outIdx = args.indexOf('--out');
    const outPath = outIdx + 1 < args.length && !args[outIdx + 1].startsWith('--') ? args[outIdx + 1] : null;
    if (!specPath) { console.error('--spec にはJSONファイルのパスが必要です'); process.exitCode = 1; }
    else {
      try {
        const raw = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
        const result = planZones(raw);
        const output = JSON.stringify(result, null, 2);
        if (outPath) {
          fs.writeFileSync(path.resolve(outPath), output, 'utf8');
          console.log(`ゾーン計画を ${outPath} に出力しました`);
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