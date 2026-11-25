import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPdf, installMupdf, PDF_RENDER_DIR } from './pdf-page-check.mjs';

function pdf(text, secondPage) {
  const stream = value => `BT /F1 18 Tf 72 700 Td (${value}) Tj ET`;
  const content = value => `<< /Length ${Buffer.byteLength(stream(value))} >>\nstream\n${stream(value)}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${secondPage ? '6 0 R' : ''}] /Count ${secondPage ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    content(text),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (secondPage) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', content(secondPage));
  let out = '%PDF-1.4\n', offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out); out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
const mupdf = path.join(PDF_RENDER_DIR, 'node_modules', 'mupdf', 'dist', 'mupdf.js');
test('1ページ描画・証跡・空白率警告', { skip: fs.existsSync(mupdf) ? false : `mupdf未導入: ${mupdf}` }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-page-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'proposal.pdf'); fs.writeFileSync(file, pdf('Customer proposal'));
  const result = await inspectPdf(file, { outDir: path.join(root, 'out'), evidenceDir: path.join(root, 'pdf-evidence') });
  assert.equal(result.pages, 1); assert.equal(result.pngs.length, 1); assert.ok(fs.existsSync(result.pngs[0])); assert.ok(fs.existsSync(result.evidenceFile)); assert.ok(result.warnings.some(w => w.type === 'bottom-blank'));
  assert.equal(result.fatal, false);
  assert.deepEqual([...fs.readFileSync(result.pngs[0]).subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const blank = result.warnings.find(w => w.type === 'bottom-blank');
  assert.ok(blank.ratio > 0.8 && blank.ratio < 0.9, String(blank.ratio));
  const evidence = JSON.parse(fs.readFileSync(result.evidenceFile));
  assert.equal(evidence.sha256, result.sha256); assert.deepEqual(evidence.pngs, result.pngs);
});
test('社内向け語をfatal検出しallow-wordで明示許可', { skip: fs.existsSync(mupdf) ? false : `mupdf未導入: ${mupdf}` }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-word-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'brief.pdf'); fs.writeFileSync(file, pdf('draft'));
  const options = { evidenceDir: path.join(root, 'pdf-evidence') };
  const denied = await inspectPdf(file, { ...options, outDir: path.join(root, 'one') });
  assert.equal(denied.fatal, true); assert.equal(denied.warnings.find(w => w.type === 'internal-word').word, 'draft');
  const allowed = await inspectPdf(file, { ...options, outDir: path.join(root, 'two'), allowWords: ['draft'] });
  assert.equal(allowed.fatal, false); assert.ok(allowed.renderedAt >= denied.renderedAt);
});

test('構造化ブロック末尾の見出し疑いと本文末尾を区別する', { skip: fs.existsSync(mupdf) ? false : 'mupdf未導入' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-heading-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'proposal.pdf');
  const options = { outDir: path.join(root, 'out'), evidenceDir: path.join(root, 'pdf-evidence') };
  fs.writeFileSync(file, pdf('Next steps', 'This paragraph explains the next steps in detail.'));
  assert.ok((await inspectPdf(file, options)).warnings.some(w => w.type === 'orphaned-heading' && w.page === 1));
  fs.writeFileSync(file, pdf('This is body text.', 'This paragraph explains the next steps in detail.'));
  assert.ok(!(await inspectPdf(file, options)).warnings.some(w => w.type === 'orphaned-heading'));
});

test('CLIのfatalはexit 1、許可語はexit 0、scale不正はexit 1', { skip: fs.existsSync(mupdf) ? false : 'mupdf未導入' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, '.claude/pdf-render/node_modules'); fs.mkdirSync(engine, { recursive: true });
  fs.symlinkSync(path.dirname(path.dirname(mupdf)), path.join(engine, 'mupdf'), process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(root, 'proposal.pdf'); fs.writeFileSync(file, pdf('TODO draft'));
  const run = extra => spawnSync(process.execPath, [fileURLToPath(new URL('./pdf-page-check.mjs', import.meta.url)), '--pdf', file, ...extra], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: root } });
  const denied = run([]); assert.equal(denied.status, 1, denied.stderr); assert.equal(JSON.parse(denied.stdout).fatal, true);
  const allowed = run(['--allow-word', 'TODO', '--allow-word', 'draft']); assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(run(['--scale', '0']).status, 1);
});

test('installは同じNodeでnpmのJS入口を起動し、失敗理由を残す', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-install-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const run = (exe, args, options) => {
    calls++; assert.equal(exe, process.execPath); assert.match(args[0], /npm(?:-cli\.js)?$/);
    assert.deepEqual(args.slice(1), ['install', '--prefix', options.cwd, '--no-audit', '--no-fund', 'mupdf']); assert.equal(options.shell, undefined);
    assert.equal(options.env.INIT_CWD, options.cwd);
    const dist = path.join(options.cwd, 'node_modules/mupdf/dist'); fs.mkdirSync(dist, { recursive: true }); fs.writeFileSync(path.join(dist, 'mupdf.js'), '// fixture');
    return { status: 0 };
  };
  assert.equal(installMupdf({ renderDir: root, run }).installed, true);
  installMupdf({ renderDir: root, run }); assert.equal(calls, 1);
  assert.throws(() => installMupdf({ renderDir: path.join(root, 'failed'), run: () => ({ status: 1, stderr: 'network unavailable' }) }), /network unavailable/);
});
