#!/usr/bin/env node
// 部材ライブラリ作成の入口: Blender 確認 → STL 取得(無ければ) → 分割・命名(build-library.py) → サムネイル(render-thumbs.py) → 検証。
// 使い方: node tools/booth-3d/build-library.mjs --out <dir> [--stl-dir <dir>] [--fetch]
//   出力: <out>/library.blend  <out>/library.json  <out>/thumbs/<asset_id>.png
//   --stl-dir  STL のキャッシュ先（既定 ~/.claude/booth-3d/stl。欠けがあれば fetch-stl で取得）
//   --fetch    STL が揃っていても Drive と照合して再取得する
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../is-entry.mjs';
import { assetBaseId, loadSources } from './asset-naming.mjs';
import { ensureBlender } from './ensure-blender.mjs';
import { defaultOutDir as defaultStlDir, fetchAll } from './fetch-stl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = '使い方: node tools/booth-3d/build-library.mjs --out <dir> [--stl-dir <dir>] [--fetch]';

export function parseArgs(argv) {
  const opts = { stlDir: defaultStlDir(), fetch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { opts.out = path.resolve(argv[i + 1] ?? ''); i += 1; }
    else if (a === '--stl-dir') { opts.stlDir = path.resolve(argv[i + 1] ?? ''); i += 1; }
    else if (a === '--fetch') opts.fetch = true;
    else throw new Error(`unknown option: ${a}\n${USAGE}`);
  }
  if (!opts.out) throw new Error(`--out is required\n${USAGE}`);
  return opts;
}

// library.json の asset_id が asset-naming.mjs の規則どおりか（Python 側との差異検出）。
export function checkNaming(library, sources) {
  const bySource = new Map(sources.map((s) => [s.name, s]));
  const problems = [];
  for (const a of library) {
    const src = bySource.get(a.source_file);
    if (!src) { problems.push(`${a.asset_id}: source_file が stl-sources.json に無い (${a.source_file})`); continue; }
    const expected = assetBaseId(src.slug, src.kind, a.dims_mm, src.step ?? 10);
    if (a.asset_id !== expected && !a.asset_id.startsWith(`${expected}_`)) problems.push(`${a.asset_id}: 期待 ${expected}`);
  }
  return problems;
}

function runBlender(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const lines = `${r.stdout ?? ''}`.split(/\r?\n/).filter((l) => /^(SRC |LIBRARY_DONE|THUMBS_DONE|Error|Traceback|\s+File |\w*Error)/.test(l));
  for (const l of lines) console.log(l);
  if (r.status !== 0) throw new Error(`Blender が失敗 (exit ${r.status}): ${(r.stderr || '').slice(-500)}\n${`${r.stdout ?? ''}`.slice(-800)}`);
}

export async function buildLibrary({ out, stlDir, fetchAlways = false }) {
  const sources = loadSources();
  const exe = await ensureBlender({ log: (m) => console.error(m) });
  const missing = sources.filter((s) => !existsSync(path.join(stlDir, s.name)));
  if (fetchAlways || missing.length) {
    console.error(`STL を Drive から取得します（不足 ${missing.length} 件）→ ${stlDir}`);
    await fetchAll({ out: stlDir, log: (m) => console.error(m) });
  }
  mkdirSync(out, { recursive: true });
  runBlender(exe, ['-b', '-P', path.join(HERE, 'build-library.py'), '--', stlDir, path.join(HERE, 'stl-sources.json'), out]);
  const blend = path.join(out, 'library.blend');
  const thumbs = path.join(out, 'thumbs');
  mkdirSync(thumbs, { recursive: true });
  // 再ビルドで廃止された asset_id の PNG を残さない。
  for (const file of readdirSync(thumbs).filter((f) => f.endsWith('.png'))) {
    rmSync(path.join(thumbs, file));
  }
  runBlender(exe, ['-b', blend, '-P', path.join(HERE, 'render-thumbs.py'), '--', thumbs]);

  const library = JSON.parse(readFileSync(path.join(out, 'library.json'), 'utf8'));
  const pngs = readdirSync(thumbs).filter((f) => f.endsWith('.png'));
  const problems = checkNaming(library, sources);
  const missingThumbs = library.filter((a) => !existsSync(path.join(out, a.thumb)));
  console.log(`assets=${library.length} thumbs=${pngs.length} namingProblems=${problems.length} missingThumbs=${missingThumbs.length}`);
  if (pngs.length !== library.length || problems.length || missingThumbs.length) {
    throw new Error(`検証失敗: ${[...problems, ...missingThumbs.map((a) => `サムネイル無し ${a.asset_id}`)].join('; ') || `PNG ${pngs.length} != アセット ${library.length}`}`);
  }
  return { library, out };
}

if (isEntry(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    await buildLibrary({ out: opts.out, stlDir: opts.stlDir, fetchAlways: opts.fetch });
  } catch (err) {
    console.error(`build-library: ${err.message}`);
    process.exitCode = 1;
  }
}
