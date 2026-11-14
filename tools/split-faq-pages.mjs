/**
 * X-0007: FAQ-ALL-20-QUESTIONS.html を個別の固定ページ用HTMLファイルに分割する
 *
 * 使い方:
 *   node tools/split-faq-pages.mjs
 *
 * 入力: ai-visibility/x0007-implementation/FAQ-ALL-20-QUESTIONS.html
 * 出力先: ai-visibility/x0007-implementation/split/
 * 出力ファイル名: faq-01-cost-range.html, faq-02-low-budget.html, ...
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INPUT_FILE = path.resolve(
  __dirname, '..', 'ai-visibility', 'x0007-implementation', 'FAQ-ALL-20-QUESTIONS.html',
);
export const OUTPUT_DIR = path.resolve(
  __dirname, '..', 'ai-visibility', 'x0007-implementation', 'split',
);

const SEPARATOR = '<!-- ============================================================ -->';
const SLUG_RE = /\/\*\s*スラッグ:\s*\/booth\/faq\/([^/]+?)\/\s*(?:\*\/|-->)/;

/** WordPress固定ページ用HTMLヘッダー（<!DOCTYPE html> なし） */
const WP_HEADER = `<!-- X-0007: WordPress固定ページ本文 -->
<!-- 出典: docs/ai-news-x0007-phase2-content-plan.md (PR #1816) -->
`;

function addWordPressHeader(pageContent) {
  const headingEnd = pageContent.indexOf('</h2>');
  if (headingEnd === -1) return pageContent;
  const insertAt = headingEnd + '</h2>'.length;
  return `${pageContent.slice(0, insertAt)}\n${WP_HEADER}${pageContent.slice(insertAt)}`;
}

export function parsePages(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const pieces = raw.split(SEPARATOR);

  const pages = [];
  const contentPieces = pieces.slice(3); // 先頭3つをスキップ

  for (let i = 0; i + 1 < contentPieces.length; i += 2) {
    const meta = contentPieces[i];
    const body = contentPieces[i + 1];

    const slugMatch = meta.match(SLUG_RE);
    if (!slugMatch) continue;

    const slug = slugMatch[1];
    const h2Index = body.indexOf('<h2>');
    if (h2Index === -1) continue;

    const scriptEndIndex = body.lastIndexOf('</script>');
    if (scriptEndIndex === -1) continue;

    let endIndex = scriptEndIndex + '</script>'.length;
    const afterScript = body.slice(scriptEndIndex + '</script>'.length);
    const hrMatch = afterScript.match(/^\n{1,2}<hr>/);
    if (hrMatch) {
      endIndex += hrMatch[0].length;
    }

    const pageContent = body.slice(h2Index, endIndex).trim();
    const pageNum = pages.length + 1;

    pages.push({
      num: pageNum,
      slug,
      content: addWordPressHeader(pageContent),
      filename: `faq-${String(pageNum).padStart(2, '0')}-${slug}.html`,
    });
  }

  return pages;
}

/** メインエントリポイント */
export function main(inputFile = INPUT_FILE, outputDir = OUTPUT_DIR) {
  if (!fs.existsSync(inputFile)) {
    console.error(`エラー: 入力ファイルが見つかりません: ${inputFile}`);
    return null;
  }

  const raw = fs.readFileSync(inputFile, 'utf-8');
  const pages = parsePages(raw);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const page of pages) {
    const outputPath = path.join(outputDir, page.filename);
    fs.writeFileSync(outputPath, page.content, 'utf-8');
    console.log(`作成: ${page.filename}`);
  }

  console.log(`\n完了: ${pages.length} ファイルを ${outputDir} に作成しました。`);
  return pages;
}

export default main;

// ── CLI実行 ──
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
