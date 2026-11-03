#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../is-entry.mjs';

const PARAM_DIMS = {
  floor_panel: (i) => [i.w_mm ?? 400, i.d_mm ?? 400, i.h_mm ?? 18],
  system_panel: (i) => [i.w_mm, i.d_mm ?? i.t_mm ?? 40, i.h_mm],
  ledup: (i) => [i.w_mm, i.d_mm ?? 120, i.h_mm],
};

export function loadLibrary(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(value) ? value : value.assets;
}

export function basicSpecProblems(spec) {
  const p = [];
  if (!spec || typeof spec !== 'object') return [{ code: 'invalid_spec', message: 'JSON object required' }];
  if (!spec.case_id || !spec.title) p.push({ code: 'invalid_spec', message: 'case_id/title are required' });
  for (const key of ['w_mm', 'd_mm', 'height_limit_mm']) if (!(spec.booth?.[key] > 0)) p.push({ code: 'invalid_spec', message: `booth.${key} must be positive` });
  if (!Array.isArray(spec.items)) p.push({ code: 'invalid_spec', message: 'items must be an array' });
  return p;
}

export function itemDims(item, assets) {
  if (item.asset_id) return assets.get(item.asset_id)?.dims_mm ?? null;
  const fn = PARAM_DIMS[item.param];
  if (!fn) return null;
  const dims = fn(item);
  return dims.every((v) => Number.isFinite(v) && v > 0) ? dims : null;
}

export function rotatedAabb(item, dims) {
  const [w, d, h] = dims;
  const rz = (item.rot_deg ?? 0) * Math.PI / 180;
  const pitch = (item.pitch_deg ?? 0) * Math.PI / 180;
  const cp = Math.abs(Math.cos(pitch));
  const sp = Math.abs(Math.sin(pitch));
  const pitchedD = d * cp + h * sp;
  const pitchedH = d * sp + h * cp;
  const c = Math.abs(Math.cos(rz));
  const s = Math.abs(Math.sin(rz));
  const rw = w * c + pitchedD * s;
  const rd = w * s + pitchedD * c;
  const [x, y, z] = item.pos_mm ?? [];
  return { min: [x - rw / 2, y - rd / 2, z], max: [x + rw / 2, y + rd / 2, z + pitchedH], dims: [rw, rd, pitchedH] };
}

function overlapSize(a, b) { return [0, 1, 2].map((i) => Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i])); }

export function validateSpec(spec, library, { toleranceMm = 5, overlapMm = 50 } = {}) {
  const errors = basicSpecProblems(spec);
  const warnings = [];
  if (errors.length) return { valid: false, errors, warnings, items: [] };
  const assets = new Map(library.map((a) => [a.asset_id, a]));
  const placed = [];
  const usage = new Map();
  for (let index = 0; index < spec.items.length; index += 1) {
    const item = spec.items[index];
    const count = item.count ?? 1;
    if (!Array.isArray(item.pos_mm) || item.pos_mm.length !== 3 || !item.pos_mm.every(Number.isFinite) || !Number.isInteger(count) || count < 1) {
      errors.push({ code: 'invalid_item', item_index: index, message: 'pos_mm[3] and positive integer count are required' }); continue;
    }
    const dims = itemDims(item, assets);
    if (!dims) { errors.push({ code: 'unknown_asset', item_index: index, asset_id: item.asset_id, param: item.param }); continue; }
    const box = rotatedAabb(item, dims);
    const outside = box.min[0] < -toleranceMm || box.min[1] < -toleranceMm || box.min[2] < -toleranceMm || box.max[0] > spec.booth.w_mm + toleranceMm || box.max[1] > spec.booth.d_mm + toleranceMm;
    if (outside) errors.push({ code: 'out_of_bounds', item_index: index, id: item.asset_id ?? item.param, aabb_mm: box });
    if (box.max[2] > spec.booth.height_limit_mm + toleranceMm) errors.push({ code: 'height_limit', item_index: index, id: item.asset_id ?? item.param, top_mm: box.max[2], limit_mm: spec.booth.height_limit_mm });
    placed.push({ index, item, box, dims, count });
    if (item.asset_id) usage.set(item.asset_id, (usage.get(item.asset_id) ?? 0) + count);
  }
  for (const [assetId, used] of usage) {
    const asset = assets.get(assetId); const available = asset.inventory ?? asset.count_in_stl;
    if (available != null && used > available) errors.push({ code: 'inventory_exceeded', asset_id: assetId, used, available });
  }
  for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1) {
    const o = overlapSize(placed[i].box, placed[j].box);
    if (o.every((v) => v > overlapMm)) warnings.push({ code: 'aabb_overlap', item_indices: [placed[i].index, placed[j].index], overlap_mm: o.map((v) => Math.round(v * 1000) / 1000) });
  }
  return { valid: errors.length === 0, errors, warnings, items: placed.map(({ index, box }) => ({ index, aabb_mm: box })) };
}

export function buildBom(spec, library) {
  const assets = new Map(library.map((a) => [a.asset_id, a])); const rows = new Map();
  for (const item of spec.items) {
    const id = item.asset_id ?? `param:${item.param}_${item.w_mm ?? 400}x${item.d_mm ?? item.t_mm ?? 120}x${item.h_mm ?? 18}`;
    const asset = assets.get(item.asset_id); const dims = itemDims(item, assets); const quantity = item.count ?? 1;
    const available = asset ? (asset.inventory ?? asset.count_in_stl) : null;
    const row = rows.get(id) ?? { asset_id: id, name: asset?.source_file ?? item.param, dims_mm: dims, quantity: 0, inventory: available, exceeded: false };
    row.quantity += quantity; row.exceeded = available != null && row.quantity > available; rows.set(id, row);
  }
  return [...rows.values()];
}

if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const specAt = args.indexOf('--spec'); const libAt = args.indexOf('--library');
    if (specAt < 0) throw new Error('--spec is required');
    const spec = JSON.parse(readFileSync(path.resolve(args[specAt + 1]), 'utf8'));
    const lib = loadLibrary(path.resolve(libAt >= 0 ? args[libAt + 1] : path.join(process.env.USERPROFILE, '.claude/booth-3d/library/library.json')));
    const result = validateSpec(spec, lib); console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1;
  } catch (err) { console.log(JSON.stringify({ valid: false, errors: [{ code: 'invalid_input', message: err.message }], warnings: [] }, null, 2)); process.exitCode = 1; }
}
