// grok-bot-prompt-bridge.mjs — Grok Bot のリサーチ結果JSONから Claude Code 向け
// 実装プロンプト（Markdown）を生成するブリッジツール。
//
// 使い方:
//   node tools/grok-bot-prompt-bridge.mjs --research <research.json> [--output <output.md>]
//   node tools/grok-bot-prompt-bridge.mjs --sample              # サンプルJSON表示
//
// Grok Bot が出力したリサーチJSON（§2.2 のテンプレート準拠）を読み込み、
// Claude Code に渡す Markdown 形式の実装指示書に変換する。
//
// Phase 1（Grok Bot リサーチ）→ Phase 2（Claude Code 実装）の橋渡し役。
// リサーチ結果のファクトのみを抽出し、ハルシネーションや推測は除外する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Grok Bot のリサーチ結果JSONのスキーマ定義（バリデーション用）
 */
const RESEARCH_SCHEMA = {
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        required: ['item', 'summary', 'confidence'],
        properties: {
          item: 'string',
          summary: 'string',
          sources: 'array',
          confidence: { enum: ['high', 'medium', 'low'] }
        }
      }
    },
    recommended_approach: 'string',
    risks: 'array',
    estimated_effort: 'string'
  }
};

/**
 * バリデーション — 必須項目の存在を確認
 */
function validateResearch(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('リサーチデータはオブジェクトである必要があります');
  }
  if (!Array.isArray(data.findings) || data.findings.length === 0) {
    throw new Error('findings は空でない配列である必要があります');
  }
  for (let i = 0; i < data.findings.length; i++) {
    const f = data.findings[i];
    if (!f.item || !f.summary || !f.confidence) {
      throw new Error(`findings[${i}]: item / summary / confidence は必須です`);
    }
    if (!['high', 'medium', 'low'].includes(f.confidence)) {
      throw new Error(`findings[${i}].confidence は high/medium/low のいずれかです`);
    }
  }
  return true;
}

/**
 * confidence のラベル表示
 */
function confidenceLabel(c) {
  const map = { high: '✅ 高信頼', medium: '📊 中信頼', low: '⚠️ 低信頼' };
  return map[c] || c;
}

/**
 * Grok JSON → Claude Code 実装プロンプト（Markdown）
 */
function generatePrompt(data, meta = {}) {
  const { recommended_approach, risks, estimated_effort } = data;
  const lines = [];

  lines.push(`# 実装指示書（Grok Bot リサーチ結果より自動生成）`);

  if (meta.title) {
    lines.push(`\n## プロジェクト: ${meta.title}`);
  }
  if (meta.description) {
    lines.push(`\n${meta.description}`);
  }

  // --- 技術スタック（findings から推奨技術を抽出） ---
  const techFindings = data.findings.filter(f =>
    /技術|スタック|言語|フレームワーク|API|database|DB/i.test(f.item)
  );
  if (techFindings.length > 0) {
    lines.push(`\n## 技術スタック`);
    for (const f of techFindings) {
      lines.push(`- **${f.item}**: ${f.summary} ${confidenceLabel(f.confidence)}`);
      if (f.sources?.length) {
        lines.push(`  - 出典: ${f.sources.join(', ')}`);
      }
    }
  }

  // --- 実装要件（confidence high の finding のみ） ---
  const highConfFindings = data.findings.filter(f => f.confidence === 'high');
  const medConfFindings = data.findings.filter(f => f.confidence === 'medium');

  if (highConfFindings.length > 0) {
    lines.push(`\n## 実装要件（確定）`);
    for (const f of highConfFindings) {
      lines.push(`1. **${f.item}**: ${f.summary}`);
      if (f.sources?.length) {
        lines.push(`   - 参考: ${f.sources.join(', ')}`);
      }
    }
  }

  if (medConfFindings.length > 0) {
    lines.push(`\n## 参考情報（要確認）`);
    for (const f of medConfFindings) {
      lines.push(`- ${f.item}: ${f.summary}（${f.sources?.join(', ') || '出典未記載'}）`);
    }
  }

  // --- 推奨アプローチ ---
  if (recommended_approach) {
    lines.push(`\n## 推奨アプローチ`);
    lines.push(`${recommended_approach}`);
  }

  // --- リスク ---
  if (risks && risks.length > 0) {
    lines.push(`\n## 注意点・リスク`);
    for (const r of risks) {
      lines.push(`- ${r}`);
    }
  }

  // --- 工数 ---
  if (estimated_effort) {
    lines.push(`\n## 想定工数`);
    lines.push(`${estimated_effort}`);
  }

  // --- 検証項目（Grok Bot QA 用） ---
  lines.push(`\n## 検証項目（Grok Bot QA 用）`);
  let qaIdx = 1;
  for (const f of data.findings) {
    if (f.confidence === 'high') {
      lines.push(`- [ ] ${qaIdx++}. ${f.item} が正しく実装されているか`);
    }
  }
  if (risks?.length) {
    for (const r of risks) {
      lines.push(`- [ ] ${qaIdx++}. リスク「${r}」の対策が実装されているか`);
    }
  }

  // --- 全ソース一覧 ---
  const allSources = data.findings.flatMap(f => f.sources || []).filter(Boolean);
  const uniqueSources = [...new Set(allSources)];
  if (uniqueSources.length > 0) {
    lines.push(`\n## 参考リソース一覧`);
    for (const s of uniqueSources) {
      lines.push(`- <${s}>`);
    }
  }

  // --- メタデータ（CLI 生成情報） ---
  const now = new Date().toISOString().split('T')[0];
  lines.push(``);
  lines.push(`---`);
  lines.push(`*生成日: ${now} | 生成元: Grok Bot Research Bridge | low-confidence findings は除外*`);

  return lines.join('\n');
}

/**
 * リサーチJSONファイルを読み込む（Markdown ブロックからの抽出対応）
 */
function loadResearch(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();

  // Markdown コードブロック内のJSONを抽出
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;

  // JSONパース（BOM除去）
  const cleanJson = jsonStr.replace(/^﻿/, '');
  return JSON.parse(cleanJson);
}

/**
 * サンプルリサーチJSONを表示
 */
function showSample() {
  const sample = {
    findings: [
      {
        item: 'React バージョン',
        summary: '最新安定版は React 19。Next.js 15 が推奨。App Router がデフォルト。',
        sources: ['https://react.dev/blog/2024/12/05/react-19', 'https://nextjs.org/docs'],
        confidence: 'high'
      },
      {
        item: 'UIコンポーネント',
        summary: 'Shadcn/ui + Tailwind CSS 4 が2025年デファクト。Headless UI も選択肢。',
        sources: ['https://ui.shadcn.com', 'https://tailwindcss.com'],
        confidence: 'high'
      },
      {
        item: '認証方式',
        summary: 'NextAuth.js v5（Auth.js）が主流。Supabase Auth も成長中。',
        sources: ['https://authjs.dev'],
        confidence: 'medium'
      },
      {
        item: '競合実装例',
        summary: '5社中3社が Next.js + microCMS 構成。1社が WordPress REST API + React。',
        sources: [],
        confidence: 'medium'
      },
      {
        item: '料金相場',
        summary: '類似サイト制作の相場観だが、正確な数字は要確認。',
        sources: [],
        confidence: 'low'
      }
    ],
    recommended_approach: 'Next.js 15 (App Router) + Shadcn/ui + Tailwind CSS 4 で新規構築。WordPress と共存する場合はサブパス運用。',
    risks: [
      'WordPress とのセッション共有が必要な場合、認証方式の統一に工数がかかる',
      '既存テーマのCSSとTailwindの競合リスク'
    ],
    estimated_effort: '2〜3人日（WordPress連携なしの場合）'
  };
  console.log(JSON.stringify(sample, null, 2));
}

function printUsage() {
  console.log(`
使い方:
  node tools/grok-bot-prompt-bridge.mjs --research <file.json> [--output <file.md>]
  node tools/grok-bot-prompt-bridge.mjs --sample
  node tools/grok-bot-prompt-bridge.mjs --help

オプション:
  --research <path>    Grok Bot リサーチ結果JSONファイル（Markdown コードブロック内でも可）
  --output <path>      生成する実装プロンプトの出力先（省略時は stdout）
  --title <text>       プロジェクトタイトル（任意）
  --desc <text>        プロジェクト説明（任意）
  --sample             サンプルJSONを表示
  --help               このヘルプ
`);
}

function parseArgs(argv) {
  const opts = { research: null, output: null, title: null, description: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--research': opts.research = argv[++i]; break;
      case '--output': opts.output = argv[++i]; break;
      case '--title': opts.title = argv[++i]; break;
      case '--desc': opts.description = argv[++i]; break;
      case '--sample': opts.sample = true; break;
      case '--help': opts.help = true; break;
    }
  }
  return opts;
}

// --- main ---
function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printUsage();
    return;
  }

  if (opts.sample) {
    showSample();
    return;
  }

  if (!opts.research) {
    console.error('エラー: --research <file> は必須です');
    printUsage();
    process.exit(1);
  }

  const researchPath = path.resolve(opts.research);
  if (!fs.existsSync(researchPath)) {
    console.error(`エラー: ファイルが見つかりません: ${researchPath}`);
    process.exit(1);
  }

  let data;
  try {
    data = loadResearch(researchPath);
    validateResearch(data);
  } catch (err) {
    console.error(`エラー: リサーチJSONの読み込みに失敗しました: ${err.message}`);
    process.exit(1);
  }

  const meta = {
    title: opts.title || undefined,
    description: opts.description || undefined
  };

  const prompt = generatePrompt(data, meta);

  if (opts.output) {
    const outPath = path.resolve(opts.output);
    fs.writeFileSync(outPath, prompt, 'utf8');
    console.error(`実装プロンプトを出力しました: ${outPath}`);
  } else {
    console.log(prompt);
  }
}

main();