import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectPdf, PDF_RENDER_DIR } from './pdf-page-check.mjs';

function pdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 35} >>\nstream\nBT /F1 18 Tf 72 700 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n', offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out); out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
const mupdf = path.join(PDF_RENDER_DIR, 'node_modules', 'mupdf', 'dist', 'mupdf.js');
test('1ページ描画・証跡・空白率警告', { skip: fs.existsSync(mupdf) ? false : `mupdf未導入: ${mupdf}` }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-page-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'proposal.pdf'); fs.writeFileSync(file, pdf('Customer proposal'));
  const result = await inspectPdf(file, { outDir: path.join(root, 'out') });
  assert.equal(result.pages, 1); assert.equal(result.pngs.length, 1); assert.ok(fs.existsSync(result.pngs[0])); assert.ok(fs.existsSync(result.evidenceFile)); assert.ok(result.warnings.some(w => w.type === 'bottom-blank'));
});
test('社内向け語をfatal検出しallow-wordで明示許可', { skip: fs.existsSync(mupdf) ? false : `mupdf未導入: ${mupdf}` }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-word-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'brief.pdf'); fs.writeFileSync(file, pdf('draft'));
  assert.equal((await inspectPdf(file, { outDir: path.join(root, 'one') })).fatal, true);
  assert.equal((await inspectPdf(file, { outDir: path.join(root, 'two'), allowWords: ['draft'] })).fatal, false);
});
