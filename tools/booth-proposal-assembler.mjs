#!/usr/bin/env node
/**
 * booth-proposal-assembler.mjs — X-0074: ブース提案書統合エージェント
 *
 * ゾーン計画・什器配置・予算情報を統合し、クライアント向け提案書を生成する。
 * 各エージェントの出力を組み合わせて一貫性のある提案書を構成する。
 *
 * 使い方:
 *   node tools/booth-proposal-assembler.mjs --zone-plan <zones.json> --layout <layout.json> [--client "企業名"] [--out <dir>]
 *   node tools/booth-proposal-assembler.mjs --sample
 */
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// ---- 提案書セクション定義 ----

/** 提案書の標準セクション構成 */
export const PROPOSAL_SECTIONS = Object.freeze([
  { id: 'cover',         label: '表紙',        required: true  },
  { id: 'summary',       label: '提案概要',    required: true  },
  { id: 'requirements',  label: '要件分析',    required: true  },
  { id: 'zone_plan',     label: 'ゾーン計画',  required: false },
  { id: 'layout',        label: '什器配置',    required: false },
  { id: 'budget',        label: '予算配分',    required: true  },
  { id: 'schedule',      label: 'スケジュール', required: false },
  { id: 'company_info',  label: '会社概要',    required: false },
]);

// ---- 検証 ----

const required = s => typeof s === 'string' && s.trim().length > 0;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 提案書データを検証する
 * @param {object} data
 * @returns {{ ok: boolean, errors: string[], sections: string[] }}
 */
export function validateProposalData(data) {
  const errors = [];

  if (!object(data)) { errors.push('提案書データはオブジェクトが必要です'); return { ok: false, errors, sections: [] }; }
  if (!required(data.client_name)) errors.push('client_name（企業名）は必須です');

  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    errors.push('sections（セクション一覧）は必須です');
  }

  const sectionIds = data.sections?.map(s => s.id) || [];
  const seen = new Set();
  for (const section of data.sections || []) {
    if (!object(section)) { errors.push('セクションはオブジェクトが必要です'); continue; }
    if (!required(section.id)) errors.push('セクション: id は必須です');
    else if (seen.has(section.id)) errors.push(`セクションID重複: ${section.id}`);
    seen.add(section.id);
    if (!required(section.title)) errors.push(`${section.id}: title は必須です`);
  }

  // 必須セクションの確認
  for (const ps of PROPOSAL_SECTIONS) {
    if (ps.required && data.include_sections?.includes?.(ps.id) === false) {
      // OK: explicitly excluded
    } else if (ps.required && !sectionIds.includes(ps.id)) {
      // If zone_plan or layout data is missing, only require it if data exists
      if (ps.id === 'zone_plan' && !data.zone_data) continue;
      if (ps.id === 'layout' && !data.layout_data) continue;
      if (ps.id === 'schedule' && !data.schedule_data) continue;
      if (ps.id === 'company_info' && !data.company_data) continue;
      errors.push(`必須セクションがありません: ${ps.id}`);
    }
  }

  return { ok: errors.length === 0, errors, sections: sectionIds };
}

// ---- 提案書生成 ----

/**
 * 提案書テキストを生成する
 * @param {object} data - 提案データ
 * @param {string} data.client_name - 企業名
 * @param {string} [data.project_name] - 案件名
 * @param {object} [data.zone_data] - planZones() の出力
 * @param {object} [data.layout_data] - optimizeLayout() の出力
 * @param {object} [data.requirements] - クライアント要件
 * @param {string[]} [data.include_sections] - 含めるセクション
 * @returns {string} Markdown提案書
 */
export function assembleProposal(data) {
  const {
    client_name: clientName,
    project_name: projectName = `${clientName}様 展示ブース提案書`,
    zone_data: zoneData,
    layout_data: layoutData,
    requirements = {},
    include_sections: includeSections,
  } = data;

  const sections = [];
  let boothSize = '';
  let totalBudget = 0;

  // 要件から情報を抽出
  if (zoneData?.meta) {
    boothSize = `${zoneData.meta.width_mm}×${zoneData.meta.depth_mm}mm`;
  }

  const budgetStr = requirements.budget || (layoutData?.meta?.budget ? `¥${layoutData.meta.budget.toLocaleString()}` : '');

  const shouldInclude = (id) => {
    if (!includeSections) return true;
    return includeSections.includes(id);
  };

  // --- 表紙 ---
  if (shouldInclude('cover')) {
    sections.push(`# ${projectName}

**提出日**: ${new Date().toISOString().slice(0, 10)}
**提出先**: ${clientName} 様
**提案者**: 株式会社オージャスト（Re:ブース）

---

`);
  }

  // --- 提案概要 ---
  if (shouldInclude('summary')) {
    const zoneCount = zoneData?.zones?.length || 0;
    const layoutItemCount = layoutData?.items?.length || 0;
    const totalCost = layoutData?.totalCost || 0;

    sections.push(`## 提案概要

${clientName}様の展示ブースについて、以下のプランをご提案いたします。

| 項目 | 内容 |
|------|------|
| ブースサイズ | ${boothSize || '要確認'} |
| 提案ゾーン数 | ${zoneCount}ゾーン |
| 導入什器数 | ${layoutItemCount}点 |
| 見積金額 | ¥${totalCost.toLocaleString()}${budgetStr ? `（予算: ${budgetStr}）` : ''}

`);
  }

  // --- 要件分析 ---
  if (shouldInclude('requirements')) {
    const reqList = [];
    if (requirements.event) reqList.push(['展示会', requirements.event]);
    if (requirements.venue) reqList.push(['会場', requirements.venue]);
    if (requirements.dates) reqList.push(['会期', requirements.dates]);
    if (requirements.budget) reqList.push(['予算', budgetStr]);
    if (requirements.purpose) reqList.push(['出展目的', requirements.purpose]);
    if (requirements.design_style) reqList.push(['デザインテイスト', requirements.design_style]);

    sections.push(`## 要件分析

### 出展情報

${reqList.length > 0
  ? `| 項目 | 内容 |\n|---|---|\n${reqList.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}`
  : 'クライアントよりヒアリングした要件に基づき、最適なブースプランを提案します。'}

### 提案方針

来場者の動線・視認性・運用効率を考慮し、最適なゾーニングと什器配置を計画しました。

`);
  }

  // --- ゾーン計画 ---
  if (shouldInclude('zone_plan') && zoneData?.zones) {
    const zoneTable = `| ゾーン | 種別 | サイズ | 優先度 |\n|---|---|---|---|\n${zoneData.zones.map(z =>
      `| ${z.label} | ${z.type} | ${z.w_mm}×${z.d_mm}mm | ${'★'.repeat(Math.max(1, 6 - z.priority))} |`
    ).join('\n')}`;

    sections.push(`## ゾーン計画

ブース内を機能別に ${zoneData.zones.length}ゾーンに分割します。
${zoneData.meta
  ? `総面積: ${zoneData.meta.total_area_m2}m²、使用率: ${zoneData.meta.utilization_pct}%`
  : ''}

${zoneTable}

${zoneData.warnings && zoneData.warnings.length > 0
  ? `**注意点**: ${zoneData.warnings.join('、')}`
  : ''}

`);
  }

  // --- 什器配置 ---
  if (shouldInclude('layout') && layoutData?.items) {
    const itemTable = `| 什器 | サイズ | 金額 | 配置ゾーン |\n|---|---|---|---|\n${layoutData.items.map(i =>
      `| ${i.label} | ${i.w_mm}×${i.d_mm}mm | ¥${i.price.toLocaleString()} | ${i.zone || '(未割当)'} |`
    ).join('\n')}`;

    sections.push(`## 什器配置計画

提案ブースに以下の什器を配置します。

${itemTable}

`);
  }

  // --- 予算配分 ---
  if (shouldInclude('budget')) {
    const totalCost = layoutData?.totalCost || 0;
    const budget = layoutData?.meta?.budget;

    // ゾーン別集計
    const zoneGroups = {};
    if (layoutData?.items) {
      for (const item of layoutData.items) {
        const zone = item.zone || 'other';
        if (!zoneGroups[zone]) zoneGroups[zone] = 0;
        zoneGroups[zone] += item.price;
      }
    }

    const budgetTable = Object.keys(zoneGroups).length > 0
      ? `| 区分 | 金額 | 比率 |\n|---|---|---|\n${Object.entries(zoneGroups).map(([zone, cost]) =>
          `| ${zone} | ¥${cost.toLocaleString()} | ${(cost / totalCost * 100).toFixed(1)}% |`
        ).join('\n')}`
      : '予算配分データは未生成です。';

    sections.push(`## 予算配分

### 見積総額: ¥${totalCost.toLocaleString()}
${budget ? `（設定予算: ¥${budget.toLocaleString()}）` : ''}

${budgetTable}

${layoutData?.meta?.within_budget === false ? '\n⚠ 予算を超過しています。調整が必要です。\n' : ''}
${layoutData?.warnings?.some(w => w.includes('予算')) ? `\n${layoutData.warnings.filter(w => w.includes('予算')).join('\n')}\n` : ''}

`);
  }

  // --- スケジュール ---
  if (shouldInclude('schedule')) {
    sections.push(`## スケジュール（目安）

| 工程 | 期間 | 備考 |
|------|------|------|
| 企画・設計 | 着工〜2週間 | ゾーン計画・什器選定 |
| 見積確定 | 1週間 | 最終調整・確定 |
| 制作・準備 | 2〜4週間 | 什器手配・パネル制作 |
| 搬入設営 | 1〜2日前 | 会場設営 |
| 会期中運用 | 展示会期間中 | 運営サポート |
| 撤去 | 最終日 | 撤去・搬出 |

`);
  }

  // --- 会社概要 ---
  if (shouldInclude('company_info')) {
    sections.push(`## 株式会社オージャストについて

| 項目 | 内容 |
|------|------|
| 社名 | 株式会社オージャスト |
| ブランド | Re:ブース（リユースブース専門ブランド） |
| 事業内容 | 展示会ブースの企画・設計・制作・施工・運営支援 |
| 強み | SDGs対応・コスト削減・短期納品・環境配慮型ブース |

### お問い合わせ

ご質問やご不明な点がございましたら、下記までお気軽にご連絡ください。

- **メール**: seisaku-team@orgiast.jp
- **Web**: https://orgiast.jp

`);
  }

  return sections.join('\n');
}

/**
 * 提案書データから Markdown ファイル群を出力する
 * @param {object} data - assembleProposal() の入力
 * @param {string} outDir - 出力先ディレクトリ
 * @returns {{ proposalMd: string, files: string[] }}
 */
export function writeProposalFiles(data, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const markdown = assembleProposal(data);
  const proposalPath = path.join(outDir, 'proposal.md');
  fs.writeFileSync(proposalPath, markdown, 'utf8');

  // 必要に応じてゾーンデータも別ファイルで保存
  const files = ['proposal.md'];
  if (data.zone_data) {
    const zonePath = path.join(outDir, 'zone-plan.json');
    fs.writeFileSync(zonePath, JSON.stringify(data.zone_data, null, 2), 'utf8');
    files.push('zone-plan.json');
  }
  if (data.layout_data) {
    const layoutPath = path.join(outDir, 'layout-plan.json');
    fs.writeFileSync(layoutPath, JSON.stringify(data.layout_data, null, 2), 'utf8');
    files.push('layout-plan.json');
  }

  return { proposalMd: markdown, files };
}

// ---- CLI ----

function printHelp() {
  console.log(`booth-proposal-assembler.mjs — X-0074: ブース提案書統合エージェント

使い方:
  node tools/booth-proposal-assembler.mjs --zone-plan <zones.json> --layout <layout.json> [--client "社名"] [--out <dir>]
  node tools/booth-proposal-assembler.mjs --sample  サンプル提案書の表示
  node tools/booth-proposal-assembler.mjs --validate <proposal-data.json>  提案書データの検証
  node tools/booth-proposal-assembler.mjs --sections  利用可能セクション一覧

オプション:
  --zone-plan <file>    ゾーン計画JSON（planZonesの出力）
  --layout <file>       什器配置JSON（optimizeLayoutの出力）
  --client <string>     クライアント企業名
  --budget <number>     予算（円）
  --event <string>      展示会名
  --venue <string>      会場
  --out <dir>           出力ディレクトリ`);
}

function printSections() {
  console.log('利用可能セクション:\n');
  for (const s of PROPOSAL_SECTIONS) {
    console.log(`  ${s.id.padEnd(16)} ${s.label}${s.required ? ' (必須)' : ''}`);
  }
}

function printSample() {
  const sampleZonePlan = {
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 2700, d_mm: 1000, priority: 1, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 1000, w_mm: 3000, d_mm: 1200, priority: 2, color: '#dcfce7' },
      { id: 'meeting', type: 'meeting', label: '商談', x_mm: 0, y_mm: 2200, w_mm: 3000, d_mm: 800, priority: 3, color: '#fef9c3' },
    ],
    meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 66.7, min_aisle_mm: 600 },
  };

  const sampleLayout = {
    items: [
      { id: 'counter_reception', label: 'カウンターテーブル', w_mm: 900, d_mm: 450, price: 15000, zone: 'reception' },
      { id: 'shelf_display', label: '展示シェルフ', w_mm: 1200, d_mm: 400, price: 35000, zone: 'display' },
      { id: 'table_meeting', label: '商談テーブル', w_mm: 1200, d_mm: 700, price: 25000, zone: 'meeting' },
      { id: 'chair1', label: 'チェア', w_mm: 500, d_mm: 500, price: 8000, zone: 'meeting' },
      { id: 'chair2', label: 'チェア', w_mm: 500, d_mm: 500, price: 8000, zone: 'meeting' },
      { id: 'rack_reception', label: 'パンフレットラック', w_mm: 400, d_mm: 300, price: 8000, zone: 'reception' },
    ],
    zones: sampleZonePlan.zones,
    totalCost: 99000,
    meta: { width_mm: 3000, depth_mm: 3000, within_budget: true },
    warnings: [],
  };

  const markdown = assembleProposal({
    client_name: 'サンプル企業',
    project_name: 'サンプル企業様 展示ブース提案書',
    zone_data: sampleZonePlan,
    layout_data: sampleLayout,
    requirements: {
      event: 'サンプル展示会 2026',
      venue: '東京ビッグサイト',
      dates: '2026-12-01〜03',
      budget: '300,000円',
      purpose: '新製品発表・ブランディング',
    },
  });

  console.log(markdown);
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--sample')) {
    printSample();
  } else if (args.includes('--help')) {
    printHelp();
  } else if (args.includes('--sections')) {
    printSections();
  } else if (args.includes('--validate')) {
    const idx = args.indexOf('--validate');
    const dataPath = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    if (!dataPath) { console.error('--validate にはJSONファイルのパスが必要です'); process.exitCode = 1; }
    else {
      try {
        const data = JSON.parse(fs.readFileSync(path.resolve(dataPath), 'utf8'));
        const result = validateProposalData(data);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`検証エラー: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } else {
    // ゾーン計画とレイアウトから提案書生成
    const zoneIdx = args.indexOf('--zone-plan');
    const layoutIdx = args.indexOf('--layout');
    const clientIdx = args.indexOf('--client');
    const budgetIdx = args.indexOf('--budget');
    const eventIdx = args.indexOf('--event');
    const venueIdx = args.indexOf('--venue');
    const outIdx = args.indexOf('--out');

    const zonePath = zoneIdx + 1 < args.length && !args[zoneIdx + 1].startsWith('--') ? args[zoneIdx + 1] : null;
    const layoutPath = layoutIdx + 1 < args.length && !args[layoutIdx + 1].startsWith('--') ? args[layoutIdx + 1] : null;
    const clientName = clientIdx + 1 < args.length && !args[clientIdx + 1].startsWith('--') ? args[clientIdx + 1] : 'クライアント';
    const budget = budgetIdx + 1 < args.length && !args[budgetIdx + 1].startsWith('--') ? Number(args[budgetIdx + 1]) : undefined;
    const eventName = eventIdx + 1 < args.length && !args[eventIdx + 1].startsWith('--') ? args[eventIdx + 1] : undefined;
    const venueName = venueIdx + 1 < args.length && !args[venueIdx + 1].startsWith('--') ? args[venueIdx + 1] : undefined;
    const outDir = outIdx + 1 < args.length && !args[outIdx + 1].startsWith('--') ? args[outIdx + 1] : null;

    if (!zonePath && !layoutPath) {
      console.error('--zone-plan または --layout が必要です');
      process.exitCode = 1;
    } else {
      try {
        const zoneData = zonePath ? JSON.parse(fs.readFileSync(path.resolve(zonePath), 'utf8')) : null;
        const layoutData = layoutPath ? JSON.parse(fs.readFileSync(path.resolve(layoutPath), 'utf8')) : null;

        const markdown = assembleProposal({
          client_name: clientName,
          zone_data: zoneData,
          layout_data: layoutData,
          requirements: {
            event: eventName,
            venue: venueName,
            budget: budget,
          },
        });

        if (outDir) {
          const result = writeProposalFiles({
            client_name: clientName,
            zone_data: zoneData,
            layout_data: layoutData,
          }, path.resolve(outDir));
          console.log(`提案書を ${outDir} に出力しました`);
          console.log(`生成ファイル: ${result.files.join(', ')}`);
        } else {
          console.log(markdown);
        }
      } catch (err) {
        console.error(`エラー: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}