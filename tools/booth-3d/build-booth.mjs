#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../is-entry.mjs';
import { ensureBlender } from './ensure-blender.mjs';
import { buildBom, loadLibrary, validateSpec } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIBRARY = path.join(process.env.USERPROFILE ?? '', '.claude', 'booth-3d', 'library');
const USAGE = '使い方: node tools/booth-3d/build-booth.mjs --spec <json> --out <絶対パス> [--library <dir>]';

export function parseArgs(argv) {
  const o = { library: DEFAULT_LIBRARY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--spec') o.spec = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--out') o.out = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--library') o.library = path.resolve(argv[++i] ?? '');
    else throw new Error(`unknown option: ${argv[i]}\n${USAGE}`);
  }
  if (!o.spec || !o.out) throw new Error(`--spec and --out are required\n${USAGE}`);
  return o;
}

function csvCell(v) { const s = `${v ?? ''}`; return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
export function bomCsv(rows) {
  const values = [['asset_id', 'name', 'dimensions_mm', 'quantity', 'inventory', 'exceeded'], ...rows.map((r) => [r.asset_id, r.name, r.dims_mm.join('x'), r.quantity, r.inventory ?? '', r.exceeded])];
  return `\uFEFF${values.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export async function buildBooth({ spec: specPath, out, library }) {
  const jsonPath = path.join(library, 'library.json'); const blendPath = path.join(library, 'library.blend');
  if (!existsSync(jsonPath) || !existsSync(blendPath)) throw new Error(`library.json/library.blend がありません: ${library}`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8')); const assets = loadLibrary(jsonPath); const validation = validateSpec(spec, assets);
  if (!validation.valid) { console.log(JSON.stringify(validation, null, 2)); const error = new Error('spec validation failed'); error.exitCode = 1; throw error; }
  for (const warning of validation.warnings) console.error(`warning: ${JSON.stringify(warning)}`);
  mkdirSync(out, { recursive: true }); const bom = buildBom(spec, assets);
  writeFileSync(path.join(out, 'bom.json'), `${JSON.stringify(bom, null, 2)}\n`); writeFileSync(path.join(out, 'bom.csv'), bomCsv(bom));
  const exe = await ensureBlender({ log: (m) => console.error(m) });
  const r = spawnSync(exe, ['-b', '-P', path.join(HERE, 'build-booth.py'), '--', specPath, blendPath, out], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  for (const line of `${r.stdout ?? ''}`.split(/\r?\n/).filter((l) => /^(BOOTH_DONE|Error|Traceback|\s+File |\w*Error)/.test(l))) console.log(line);
  if (r.status !== 0 || /Traceback \(most recent call last\)/.test(r.stdout ?? '') || !/BOOTH_DONE/.test(r.stdout ?? '')) throw new Error(`Blender が失敗 (exit ${r.status}): ${(r.stderr || '').slice(-700)}\n${`${r.stdout ?? ''}`.slice(-1400)}`);
  const expected = [...spec.views.map((v) => `${v}.png`), 'scene.blend', 'bom.json', 'bom.csv'];
  const missing = expected.filter((f) => !existsSync(path.join(out, f))); if (missing.length) throw new Error(`生成物不足: ${missing.join(', ')}`);
  return { out, validation, bom, files: expected };
}

if (isEntry(import.meta.url)) {
  try { const result = await buildBooth(parseArgs(process.argv.slice(2))); console.log(JSON.stringify({ ok: true, out: result.out, files: result.files, warnings: result.validation.warnings }, null, 2)); }
  catch (err) { if (err.message !== 'spec validation failed') console.error(`build-booth: ${err.message}`); process.exitCode = err.exitCode ?? 1; }
}
