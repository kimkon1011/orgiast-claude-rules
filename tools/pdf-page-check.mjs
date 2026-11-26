#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isEntry } from './is-entry.mjs';

export const PDF_RENDER_DIR = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'pdf-render');
export const EVIDENCE_DIR = path.join(PDF_RENDER_DIR, 'evidence');
export const OUT_BASE = path.join(PDF_RENDER_DIR, 'out');
export const INTERNAL_WORDS = ['社内レビュー', '社内用', 'お客様提示版には含めません', '付録', 'ブリーフ', 'Wayback', 'ChatGPTパース生成', '取得元', 'draft', 'TODO'];
const MUPDF_ENTRY = path.join(PDF_RENDER_DIR, 'node_modules', 'mupdf', 'dist', 'mupdf.js');
const canonical = value => path.resolve(value).replaceAll('\\', '/');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function loadMupdf() {
  if (!fs.existsSync(MUPDF_ENTRY)) throw new Error('mupdf がありません。node tools/pdf-page-check.mjs --install を実行してください');
  return import(pathToFileURL(MUPDF_ENTRY).href);
}

export async function inspectPdf(pdfFile, { outDir, scale = 1.0, allowWords = [], evidenceDir = EVIDENCE_DIR } = {}) {
  const absolutePdf = path.resolve(pdfFile || '');
  if (!fs.statSync(absolutePdf, { throwIfNoEntry: false })?.isFile()) throw new Error(`PDF がありません: ${absolutePdf}`);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) throw new Error(`--scale は 0 より大きく 8 以下にしてください: ${scale}`);
  const bytes = fs.readFileSync(absolutePdf);
  const digest = sha256(bytes);
  const destination = path.resolve(outDir || path.join(OUT_BASE, digest.slice(0, 12)));
  fs.mkdirSync(destination, { recursive: true });
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pages = doc.countPages();
  if (pages < 1) { doc.destroy(); throw new Error('PDF にページがありません'); }
  const pngs = [], pageData = [], warnings = [];
  const allowed = new Set(allowWords);

  try { for (let index = 0; index < pages; index++) {
    const page = doc.loadPage(index);
    let pixmap, structured;
    try {
    const png = path.join(destination, `page-${String(index + 1).padStart(2, '0')}.png`);
    pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    fs.writeFileSync(png, pixmap.asPNG());
    pngs.push(canonical(png));
    const pixels = pixmap.getPixels();
    const width = pixmap.getWidth(), imageHeight = pixmap.getHeight(), stride = pixmap.getStride(), components = pixmap.getNumberOfComponents();
    let whiteRows = 0;
    for (let y = imageHeight - 1; y >= 0; y--) {
      let nonWhite = 0;
      for (let x = 0; x < width; x++) {
        const offset = y * stride + x * components;
        if (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250) nonWhite++;
      }
      if (nonWhite > Math.max(1, width * 0.001)) break;
      whiteRows++;
    }
    structured = page.toStructuredText('preserve-whitespace');
    const text = structured.asText();
    const blocks = [];
    structured.walk({
      beginTextBlock() { blocks.push([]); },
      beginLine() { blocks.at(-1)?.push(''); },
      onChar(char) { const block = blocks.at(-1); if (block?.length) block[block.length - 1] += char; },
    });
    const nonempty = blocks.map(block => block.map(line => line.trim()).filter(Boolean)).filter(block => block.length);
    const ratio = imageHeight > 0 ? whiteRows / imageHeight : 0;
    if (ratio > 0.55) warnings.push({ type: 'bottom-blank', page: index + 1, ratio: Number(ratio.toFixed(3)), detail: `P${index + 1}: 下側空白率 ${Math.round(ratio * 100)}%` });
    for (const word of INTERNAL_WORDS) if (!allowed.has(word) && text.toLocaleLowerCase().includes(word.toLocaleLowerCase())) warnings.push({ type: 'internal-word', page: index + 1, word, detail: `P${index + 1}: 「${word}」を検出` });
    pageData.push(nonempty);
    } finally { structured?.destroy(); pixmap?.destroy(); page.destroy(); }
  } } finally { doc.destroy(); }
  for (let index = 0; index < pageData.length - 1; index++) {
    const tail = pageData[index].at(-1) || [];
    const next = pageData[index + 1][0]?.[0] || '';
    if (tail.length >= 1 && tail.length <= 2 && [...tail.join('')].length <= 30
      && !/[。.!?！？]$|^\d+$/.test(tail.join(''))
      && ([...next].length > 30 || /[。、.!?]/u.test(next))) warnings.push({ type: 'orphaned-heading', page: index + 1, detail: `P${index + 1}→P${index + 2}: 末尾の短い見出し取り残し疑い「${tail.join(' / ')}」` });
  }
  if (sha256(fs.readFileSync(absolutePdf)) !== digest) throw new Error('描画中にPDFが更新されました。もう一度描画してください');
  const fatal = warnings.some(warning => warning.type === 'internal-word');
  const evidence = { sha256: digest, pdf: canonical(absolutePdf), pages, renderedAt: Date.now(), pngs, warnings, fatal };
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, `${digest}.json`);
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  return { ...evidence, evidenceFile: canonical(evidenceFile), note: '全ページ画像を1枚ずつ Read して目視すること。確認項目: ①見出し・注記・表の分離 ②半分以上の空白 ③社内向け記載 ④生成元・寸法・金額・社名の一致 ⑤文字化け・語途中改行・1文字行 ⑥画像欠け・空白' };
}

export function installMupdf({ renderDir = PDF_RENDER_DIR, run = spawnSync } = {}) {
  const entry = path.join(renderDir, 'node_modules/mupdf/dist/mupdf.js');
  if (fs.existsSync(entry)) return { installed: true, path: entry };
  fs.mkdirSync(renderDir, { recursive: true });
  const nodeDir = path.dirname(process.execPath);
  // Invoke npm's JS entry using this Node, never cmd.exe / a constructed shell command.
  const candidates = [path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
  const npmBin = path.join(nodeDir, 'npm');
  if (fs.existsSync(npmBin)) candidates.push(fs.realpathSync(npmBin));
  const npm = candidates.find(file => fs.existsSync(file));
  if (!npm) throw new Error(`node と同じ場所に npm がありません: ${nodeDir}`);
  const result = run(process.execPath, [npm, 'install', '--prefix', renderDir, '--no-audit', '--no-fund', 'mupdf'], {
    cwd: renderDir,
    env: { ...process.env, INIT_CWD: renderDir },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
  });
  if (result.status !== 0 || !fs.existsSync(entry)) throw new Error(`mupdf の導入に失敗しました (exit ${result.status}): ${result.error?.message || result.stderr || result.stdout}`);
  return { installed: true, path: entry };
}
function values(argv, flag) { return argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]] : []); }
async function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--install')) { console.log(JSON.stringify(installMupdf())); return; }
    const pdf = values(argv, '--pdf')[0];
    if (!pdf) throw new Error('Usage: node tools/pdf-page-check.mjs --install | --pdf <file> [--out <dir>] [--scale 1.0] [--allow-word <語>]');
    const scaleArg = values(argv, '--scale')[0];
    const result = await inspectPdf(pdf, { outDir: values(argv, '--out')[0], scale: scaleArg === undefined ? 1.0 : Number(scaleArg), allowWords: values(argv, '--allow-word') });
    console.log(JSON.stringify(result, null, 2));
    if (result.fatal) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (isEntry(import.meta.url)) await main();
