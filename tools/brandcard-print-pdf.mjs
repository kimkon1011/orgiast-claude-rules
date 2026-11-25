#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_SRC = String.raw`C:\Users\kimko\.claude\file-history\2bb98fd7-237a-4cca-ba5a-060f78bb9a86\f5944f1a14ac7438@v3`;
const QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
// 入稿仕様は仕上がり148×100mm＋塗り足し3mm四方＝154×106mm。
// ただし Chrome の --print-to-pdf は @page 寸法を 1/75in グリッドに丸めるため、
// `106mm` を指定すると PDF の高さが 105.833mm になり下辺の塗り足しが 2.833mm に落ちる。
// `106.2mm` を指定すると 106.172mm（3.172mm の塗り足し）になるので余裕側へ倒す。
// 幅は `154mm` で 154.178mm になる（こちらは余る側なのでそのまま）。
// ページは html/body の背景をカード地色で塗るので、余り領域も白にはならない。
const PRINT_CSS = `<style id="brandcard-print-bleed">
@page{size:154mm 106.2mm;margin:0}
html,body{margin:0!important;padding:0!important;background:#FBFAF7!important;display:block!important}
.sheet{width:154mm;height:106mm;background:var(--card,#FBFAF7);position:relative;overflow:hidden;
  page-break-after:always;break-after:page}
.sheet:last-child{page-break-after:auto!important;break-after:auto!important}
.sheet .card{position:absolute!important;top:3mm!important;left:3mm!important;
  width:148mm!important;height:100mm!important;margin:0!important;
  box-shadow:none!important;border:0!important;page-break-after:auto!important}
@media print{.tools,.label{display:none!important}}
/* カードは148×100mmの固定紙面なので、画面用の狭幅フォールバック
   （@media (max-width:640px)）を打ち消して常に2カラムで組む。
   1カラムだと②のお手入れカードが高さ100mmを超え、overflow:hidden で
   「ご注意」節と注記ボックスが欠落する（実測）。 */
.sheet .c2{grid-template-columns:1fr 1fr!important}
.sheet .c3{grid-template-columns:1.25fr 1fr!important}
</style>`;

function matchingDivEnd(html, start) {
  const tagPattern = /<\/?div\b[^>]*>/giu;
  tagPattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (/^<\/div/iu.test(match[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return tagPattern.lastIndex;
  }
  throw new Error('対応する </div> が見つかりません');
}

export function extractCard(srcHtml, n) {
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new RangeError('カード番号は1〜4で指定してください');
  const pattern = new RegExp(`<div\\b[^>]*class=(['"])[^'"]*\\bcard\\b[^'"]*\\bc${n}\\b[^'"]*\\1[^>]*>`, 'iu');
  const match = pattern.exec(srcHtml);
  if (!match) throw new Error(`.card.c${n} が見つかりません`);
  return srcHtml.slice(match.index, matchingDivEnd(srcHtml, match.index));
}

function replaceQrWrap(cardHtml) {
  const match = /<div\b[^>]*class=(['"])[^'"]*\bqrwrap\b[^'"]*\1[^>]*>/iu.exec(cardHtml);
  if (!match) throw new Error('.qrwrap が見つかりません');
  const end = matchingDivEnd(cardHtml, match.index);
  const replacement = `<div class="qrwrap">
    <p class="qcap">追加のご注文・名入れのご相談は<br><b>seisaku-team@orgiast.jp</b> まで<br>メールでご連絡ください。</p>
  </div>`;
  return `${cardHtml.slice(0, match.index)}${replacement}${cardHtml.slice(end)}`;
}

export function buildPagesHtml(srcHtml, { cards, dropQr = false, qrInlineJs } = {}) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('cards を1件以上指定してください');
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/iu.exec(srcHtml);
  if (!headMatch) throw new Error('<head> が見つかりません');
  let head = headMatch[1].replace(/<script\b[^>]*src=(['"])[^'"]*qrcode(?:\.min)?\.js[^'"]*\1[^>]*>\s*<\/script>/giu, '');
  head += `\n${PRINT_CSS}`;

  const usesQr = cards.includes(3) && !dropQr;
  if (usesQr) {
    const library = typeof qrInlineJs === 'string'
      ? `<script>${qrInlineJs.replace(/<\/script/giu, '<\\/script')}</script>`
      : `<script src="${QR_URL}"></script>`;
    head += `\n${library}`;
  }

  const sheets = cards.map((n) => {
    let card = extractCard(srcHtml, n);
    if (dropQr && n === 3) card = replaceQrWrap(card);
    return `<div class="sheet">\n${card}\n</div>`;
  }).join('\n');

  let qrDrawing = '';
  if (usesQr) {
    const scripts = [...srcHtml.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/giu)];
    const orderScript = scripts.find((item) => /\bORDER_URL\b/u.test(item[1]));
    if (!orderScript) throw new Error('ORDER_URL の描画スクリプトが見つかりません');
    qrDrawing = `\n<script>${orderScript[1]}</script>`;
  }

  return `<!doctype html>\n<html lang="ja">\n<head>${head}\n</head>\n<body>\n${sheets}${qrDrawing}\n</body>\n</html>\n`;
}

export function countPages(pdfBuffer) {
  return (Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer))
    .toString('latin1').match(/\/Type\s*\/Page(?!s)\b/gu)?.length ?? 0;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Chrome/Edge が見つかりません。CHROME_PATH を設定してください。探索先:\n${candidates.join('\n')}`);
  return found;
}

async function loadQrLibrary() {
  const cachePath = path.join(TOOL_DIR, '.cache', 'qrcode.min.js');
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');
  try {
    const response = await fetch(QR_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.text();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, source, 'utf8');
    return source;
  } catch (error) {
    console.warn(`警告: qrcode.min.js の取得に失敗したため外部参照へフォールバックします: ${error.message}`);
    return undefined;
  }
}

function printPdf(chrome, htmlPath, pdfPath) {
  const common = [
    '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=10000',
    `--print-to-pdf=${path.resolve(pdfPath)}`, pathToFileURL(path.resolve(htmlPath)).href,
  ];
  let last;
  for (const headless of ['--headless=new', '--headless']) {
    last = spawnSync(chrome, [headless, ...common], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (!last.error && last.status === 0 && fs.existsSync(pdfPath)) {
      console.log(`Chrome mode: ${headless}`);
      return;
    }
  }
  const detail = last?.error?.message || `exit=${last?.status}; stderr=${last?.stderr || '(空)'}`;
  throw new Error(`PDF生成に失敗しました: ${detail}`);
}

function parseArgs(args) {
  const options = { src: DEFAULT_SRC, outDir: path.resolve('out', 'brandcard') };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--src' && args[i + 1]) options.src = args[++i];
    else if (args[i] === '--out-dir' && args[i + 1]) options.outDir = path.resolve(args[++i]);
    else throw new Error(`不正または値のない引数です: ${args[i]}`);
  }
  return options;
}

async function main() {
  const { src, outDir } = parseArgs(process.argv.slice(2));
  const srcHtml = fs.readFileSync(src, 'utf8');
  const qrInlineJs = await loadQrLibrary();
  const chrome = findChrome();
  fs.mkdirSync(outDir, { recursive: true });
  const jobs = [
    ['brandcard-A_154x106.pdf', { cards: [1, 2] }],
    ['brandcard-B_154x106.pdf', { cards: [4, 3], qrInlineJs }],
    ['brandcard-B_154x106_mail.pdf', { cards: [4, 3], dropQr: true }],
  ];
  for (const [pdfName, buildOptions] of jobs) {
    const htmlPath = path.join(outDir, `.${pdfName}.html`);
    const pdfPath = path.join(outDir, pdfName);
    try {
      fs.writeFileSync(htmlPath, buildPagesHtml(srcHtml, buildOptions), 'utf8');
      printPdf(chrome, htmlPath, pdfPath);
    } finally {
      fs.rmSync(htmlPath, { force: true });
    }
    const pdf = fs.readFileSync(pdfPath);
    console.log(`${pdfName}: ${pdf.length} bytes, ${countPages(pdf)} pages`);
  }
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
