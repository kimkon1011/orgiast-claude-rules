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

export async function inspectPdf(pdfFile, { outDir, scale = 1.0, allowWords = [] } = {}) {
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
  const pngs = [], pageData = [], warnings = [];
  const allowed = new Set(allowWords);

  for (let index = 0; index < pages; index++) {
    const page = doc.loadPage(index);
    const bounds = page.getBounds();
    const png = path.join(destination, `page-${String(index + 1).padStart(2, '0')}.png`);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
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
    const structured = page.toStructuredText('preserve-whitespace');
    const text = structured.asText();
    const lines = [];
    structured.walk({ beginLine(bbox) { lines.push({ bbox, text: '' }); }, onChar(char) { if (lines.length) lines.at(-1).text += char; } });
    const nonempty = lines.filter(line => line.text.trim());
    const ratio = imageHeight > 0 ? whiteRows / imageHeight : 0;
    if (ratio > 0.55) warnings.push({ type: 'bottom-blank', page: index + 1, ratio: Number(ratio.toFixed(3)), detail: `P${index + 1}: 下側空白率 ${Math.round(ratio * 100)}%` });
    for (const word of INTERNAL_WORDS) if (!allowed.has(word) && text.toLocaleLowerCase().includes(word.toLocaleLowerCase())) warnings.push({ type: 'internal-word', page: index + 1, word, detail: `P${index + 1}: 「${word}」を検出` });
    pageData.push(nonempty);
  }
  for (let index = 0; index < pageData.length - 1; index++) {
    const tail = pageData[index].slice(-2).map(line => line.text.trim()).filter(Boolean);
    const next = pageData[index + 1][0]?.text.trim() || '';
    if (tail.length && tail.every(line => [...line].length <= 30) && ([...next].length > 20 || /[。、]/u.test(next))) warnings.push({ type: 'orphaned-heading', page: index + 1, detail: `P${index + 1}→P${index + 2}: 末尾の短い見出し取り残し疑い「${tail.join(' / ')}」` });
  }
  const fatal = warnings.some(warning => warning.type === 'internal-word');
  const evidence = { sha256: digest, pdf: canonical(absolutePdf), pages, renderedAt: Date.now(), pngs, warnings, fatal };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidenceFile = path.join(EVIDENCE_DIR, `${digest}.json`);
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  return { ...evidence, evidenceFile: canonical(evidenceFile), note: '全ページ画像を1枚ずつ Read して目視すること。確認項目: ①見出し・注記・表の分離 ②半分以上の空白 ③社内向け記載 ④生成元・寸法・金額・社名の一致 ⑤文字化け・語途中改行・1文字行 ⑥画像欠け・空白' };
}

export function installMupdf() {
  if (fs.existsSync(MUPDF_ENTRY)) return { installed: true, path: MUPDF_ENTRY };
  fs.mkdirSync(PDF_RENDER_DIR, { recursive: true });
  const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (!fs.existsSync(npm)) throw new Error(`node と同じ場所に npm がありません: ${npm}`);
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund', 'mupdf'], { cwd: PDF_RENDER_DIR, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0 || !fs.existsSync(MUPDF_ENTRY)) throw new Error(`mupdf の導入に失敗しました (exit ${result.status}): ${result.stderr || result.stdout}`);
  return { installed: true, path: MUPDF_ENTRY };
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
