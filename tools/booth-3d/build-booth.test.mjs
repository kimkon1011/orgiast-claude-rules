import assert from 'node:assert/strict';
import test from 'node:test';
import { bomCsv, parseArgs } from './build-booth.mjs';
import { buildBom, rotatedAabb, validateSpec } from './validate.mjs';

const library = [
  { asset_id: 'box', source_file: '箱.stl', dims_mm: [1000, 500, 800], inventory: null, count_in_stl: 2 },
  { asset_id: 'truss300_silver_L2400', source_file: 'トラス.stl', dims_mm: [300, 300, 2400], inventory: 1, count_in_stl: 1 },
];
const base = { case_id: 'T', title: 'test', booth: { w_mm: 3000, d_mm: 3000, height_limit_mm: 2700, open_sides: ['front'], walls: ['back'] }, items: [{ asset_id: 'box', pos_mm: [1500, 1000, 0] }], views: ['top'] };

test('build-booth 引数は絶対パス化し必須値を検査する', () => {
  const a = parseArgs(['--spec', 'x.json', '--out', 'out']); assert.ok(a.spec.endsWith('x.json')); assert.ok(a.out.endsWith('out'));
  assert.throws(() => parseArgs(['--out', 'x']), /required/); assert.throws(() => parseArgs(['--wat']), /unknown option/);
});

test('validate: 正常、境界外、高さ、在庫超過をコード付きで返す', () => {
  assert.equal(validateSpec(base, library).valid, true);
  const outside = structuredClone(base); outside.items[0].pos_mm = [5000, 0, 0]; assert.ok(validateSpec(outside, library).errors.some((e) => e.code === 'out_of_bounds'));
  const tall = structuredClone(base); tall.items = [{ asset_id: 'truss300_silver_L2400', pos_mm: [1500, 1500, 500] }]; assert.ok(validateSpec(tall, library).errors.some((e) => e.code === 'height_limit'));
  const stock = structuredClone(base); stock.items[0].count = 3; assert.ok(validateSpec(stock, library).errors.some((e) => e.code === 'inventory_exceeded'));
});

test('validate: 50mm超の三軸重なりは警告だが正常終了', () => {
  const spec = structuredClone(base); spec.items.push({ asset_id: 'box', pos_mm: [1550, 1000, 0] }); const r = validateSpec(spec, library);
  assert.equal(r.valid, true); assert.equal(r.warnings[0].code, 'aabb_overlap');
});

test('pitch 90度で縦長部材の高さと奥行が入れ替わる', () => {
  const box = rotatedAabb({ pos_mm: [0, 0, 100], pitch_deg: 90 }, [300, 300, 2400]); assert.ok(Math.abs(box.dims[1] - 2400) < 0.001); assert.ok(Math.abs(box.dims[2] - 300) < 0.001);
});

test('BOM は asset_id（トラスは長さ別）で集計し CSV を引用する', () => {
  const spec = structuredClone(base); spec.items.push({ asset_id: 'box', pos_mm: [2000, 1000, 0] }); spec.items.push({ asset_id: 'truss300_silver_L2400', pos_mm: [200, 200, 0] });
  const bom = buildBom(spec, library); assert.equal(bom.find((r) => r.asset_id === 'box').quantity, 2); assert.ok(bom.some((r) => r.asset_id.endsWith('L2400')));
  const csv = bomCsv(bom); assert.ok(csv.startsWith('\uFEFFasset_id')); assert.match(csv, /truss300_silver_L2400/);
});
