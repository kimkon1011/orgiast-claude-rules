#!/usr/bin/env node
/**
 * X-0065: 箇条書きPPTを関係図へ組み直す
 *
 * PowerPointの箇条書きスライドを解析し、関係パターン（プロセス・比較・階層・循環・タイムライン）を検出、
 * Mermaid図に変換する。
 *
 * Usage:
 *   node tools/ppt-to-relation.mjs --input "提案.pptx" --pages "1-6"
 *   node tools/ppt-to-relation.mjs --input "提案.pptx" --pages "1,3,5" --dry-run
 *   node tools/ppt-to-relation.mjs --input "提案.pptx" --pages "1-6" --design-ref 7 --output "出力.pptx"
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPattern } from './lib/pattern-detect.mjs';
import { generateMermaid } from './lib/mermaid-gen.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// CLI
// ============================================================

function usage() {
  console.error(`
Usage: node tools/ppt-to-relation.mjs --input <path> [options]

Options:
  --input <path>         元PPTXファイル（必須）
  --pages <range>        変換対象ページ（"1-6" or "1,3,5"）（必須）
  --design-ref <num>     デザイン基準ページ番号
  --output <path>        出力ファイル（省略時は入力ファイル名 + "_relation"）
  --dry-run              Mermaidコードを表示のみ（PPTXは書き出さない）
  --interactive          各ページの判定結果を表示して確認
  --help                 このヘルプ

Examples:
  node tools/ppt-to-relation.mjs --input "提案.pptx" --pages "1-6"
  node tools/ppt-to-relation.mjs --input "提案.pptx" --pages "1,3,5" --dry-run
`);
}

function parsePages(arg) {
  const pages = new Set();
  for (const part of arg.split(',')) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      for (let i = parseInt(rangeMatch[1]); i <= parseInt(rangeMatch[2]); i++) {
        pages.add(i);
      }
    } else {
      const num = parseInt(trimmed);
      if (!isNaN(num)) pages.add(num);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

// ============================================================
// PPTX抽出（スケルトン: Phase1では Mermaidコード生成まで）
// ============================================================

/**
 * PPTXから指定ページの箇条書きを抽出
 * Phase1 スケルトン: 実際の抽出は Codex 委譲で実装
 *
 * @param {string} pptxPath
 * @param {number[]} pages
 * @returns {Promise<Array<{page: number, bullets: string[]}>>}
 */
async function extractBulletsFromPptx(pptxPath, pages) {
  // TODO: Codex委譲で python-pptx または officeparser を使った抽出を実装
  // 現時点ではJSON形式の代替入力に対応
  console.error(`[ppt-to-relation] 読み込み: ${pptxPath}`);
  console.error(`[ppt-to-relation] 対象ページ: ${pages.join(', ')}`);
  console.error('[ppt-to-relation] PPTX抽出は Phase1 で実装予定（現在はスケルトン）');
  return pages.map((page) => ({ page, bullets: [] }));
}

/**
 * テスト用: プレーンJSONから読み込み
 */
function loadBulletsFromJson(jsonPath) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  return data.pages || [];
}

// ============================================================
// メイン
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    usage();
    process.exit(0);
  }

  const opts = {
    input: '',
    pages: '',
    designRef: 0,
    output: '',
    dryRun: false,
    interactive: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
        opts.input = args[++i];
        break;
      case '--pages':
        opts.pages = args[++i];
        break;
      case '--design-ref':
        opts.designRef = parseInt(args[++i]);
        break;
      case '--output':
        opts.output = args[++i];
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--interactive':
        opts.interactive = true;
        break;
    }
  }

  if (!opts.input || !opts.pages) {
    console.error('エラー: --input と --pages は必須です');
    usage();
    process.exit(1);
  }

  const pages = parsePages(opts.pages);
  console.error(`[ppt-to-relation] 入力: ${opts.input}`);
  console.error(`[ppt-to-relation] ページ: ${pages.join(', ')}`);

  // 箇条書き抽出（スケルトン時は代替ファイルを試す）
  let slideBullets;

  // .json で始まる input はテスト用JSON
  if (opts.input.endsWith('.json')) {
    slideBullets = loadBulletsFromJson(opts.input);
  } else {
    slideBullets = await extractBulletsFromPptx(opts.input, pages);
  }

  // 各スライドを変換
  const results = [];
  for (const slide of slideBullets) {
    const { page, bullets } = slide;

    if (!bullets || bullets.length === 0) {
      console.error(`[ppt-to-relation] ページ ${page}: 箇条書きなし（スキップ）`);
      continue;
    }

    const detection = detectPattern(bullets);
    const mermaidCode = generateMermaid(detection.pattern, bullets);

    results.push({ page, bullets, detection, mermaidCode });

    if (opts.interactive || opts.dryRun) {
      console.log(`\n=== ページ ${page} ===`);
      console.log(`パターン: ${detection.pattern} (信頼度: ${detection.confidence.toFixed(2)})`);
      console.log(`スコア:`, detection.scores);
      console.log(`\n--- Mermaid ---`);
      console.log(mermaidCode);
    }
  }

  // dry-run または interactive ならここで終了
  if (opts.dryRun) {
    console.error('\n[dry-run] PPTX書き出しなし');
    process.exit(0);
  }

  if (opts.interactive) {
    console.error('\n[interactive] 確認表示のみ（PPTXは書き出しません）');
    process.exit(0);
  }

  // 出力ファイル名の決定
  const outputPath = opts.output || opts.input.replace(/\.pptx$/, '_relation.pptx');
  console.error(`\n[ppt-to-relation] 出力: ${outputPath}`);
  console.error(`[ppt-to-relation] 変換完了: ${results.length} ページ`);

  // TODO: Phase1 で PPTX 書き出しを Codex 委譲で実装
  // 現時点ではJSONに結果を保存
  const resultJson = outputPath.replace(/\.pptx$/, '.json');
  writeFileSync(
    resultJson,
    JSON.stringify({ input: opts.input, pages: results }, null, 2),
    'utf-8',
  );
  console.error(`[ppt-to-relation] 結果JSON: ${resultJson}`);

  // マーメイドコードだけの表示
  console.error('\n--- 生成された Mermaid コード ---');
  for (const r of results) {
    console.log(`\n<!-- ページ ${r.page} (${r.detection.pattern}) -->`);
    console.log(r.mermaidCode);
  }
}

main().catch((err) => {
  console.error('エラー:', err);
  process.exit(1);
});