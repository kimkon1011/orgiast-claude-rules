import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateBoothPlan, renderBoothPlanSvg } from './booth-plan-svg.mjs';

const examplePath = fileURLToPath(new URL('../docs/booth-plan-example.json', import.meta.url));
const cliPath = fileURLToPath(new URL('./booth-plan-svg.mjs', import.meta.url));
const example = JSON.parse(readFileSync(examplePath, 'utf8'));
const fresh = () => structuredClone(example);
const run = (args, input) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', input });

test('例JSONは検証に通る', () => {
  assert.deepEqual(validateBoothPlan(example), { ok: true, errors: [] });
});

const cases = [
  ['範囲外', s => { s.items[0].x = s.booth.width; }, '範囲外: counter-reception'],
  ['重なり', s => { s.items[2].x = s.items[3].x; }, '重なり: chair-1 x chair-2'],
  ['前面動線侵入', s => { s.items[2].y = 700; }, '前面動線侵入: chair-1'],
  ['前面開口不足', s => { s.rules.frontBandCounterMaxWidthRatio = 0.1; }, '前面開口不足'],
  ['id重複', s => { s.items[1].id = s.items[0].id; }, 'id重複: counter-reception'],
  ['未知type', s => { s.items[0].type = 'unknown'; }, '未知type: counter-reception'],
  ['units不正', s => { s.meta.units = 'cm'; }, 'meta.units は mm のみです'],
];
for (const [name, mutate, message] of cases) test(name, () => {
  const spec = fresh(); mutate(spec);
  const result = validateBoothPlan(spec);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes(message), result.errors.join('\n'));
});

test('構造の不正を拒否する', () => {
  for (const mutate of [s => { s.booth.width = 0; }, s => { s.booth.depth = 1.5; }, s => { s.items = {}; }, s => { delete s.meta.name; }, s => { s.items[0].x = -1; }, s => { s.items[0].y = 0.5; }, s => { s.items[0].w = 0; }, s => { s.items[0].d = -1; }, s => { s.items[0].h = 0; }, s => { delete s.items[0].label; }, s => { delete s.items[0].id; }, s => { delete s.items[0].type; }]) {
    const spec = fresh(); mutate(spec); assert.equal(validateBoothPlan(spec).ok, false);
  }
  assert.equal(validateBoothPlan(null).ok, false);
  const spec = fresh(); delete spec.items[0].h;
  assert.equal(validateBoothPlan(spec).ok, true);
});

test('辺の接触と前面バンド境界は許可される', () => {
  const spec = fresh();
  spec.items = [
    { id: 'a', type: 'table', label: 'A', x: 0, y: 900, w: 500, d: 500 },
    { id: 'b', type: 'table', label: 'B', x: 500, y: 900, w: 500, d: 500 },
  ];
  assert.equal(validateBoothPlan(spec).ok, true);
});

test('SVGの内容と決定論性', () => {
  const svg = renderBoothPlanSvg(example);
  for (const value of ['<svg ', example.meta.name, ...example.items.map(i => i.label), 'OPEN', '18.00 m²', example.meta.scale, example.meta.date, 'item数: 10', '1800×600', 'viewBox="-600 -600 7200 5800"']) assert.ok(svg.includes(value), value);
  assert.equal((svg.match(/<svg\b/g) ?? []).length, 1);
  assert.equal(svg, renderBoothPlanSvg(example));
});

test('SVGは文字列をエスケープする', () => {
  const spec = fresh(); spec.items[0].label = '<script>&"\'';
  const svg = renderBoothPlanSvg(spec);
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;&apos;'));
  assert.ok(!svg.includes('<script>'));
});

test('CLI: check、out、stdin、help、エラー', () => {
  const dir = mkdtempSync(join(tmpdir(), 'booth-plan-svg-'));
  try {
    const check = run(['--spec', examplePath, '--check']);
    assert.equal(check.status, 0, check.stderr); assert.equal(check.stdout, '');
    const outPath = join(dir, 'plan.svg');
    const out = run(['--spec', examplePath, '--out', outPath]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFileSync(outPath, 'utf8'), renderBoothPlanSvg(example));
    const stdin = run(['--spec', '-'], JSON.stringify(example));
    assert.equal(stdin.status, 0, stdin.stderr); assert.equal(stdin.stdout, renderBoothPlanSvg(example));
    assert.equal(run(['--spec', join(dir, 'missing.json')]).status, 1);
    assert.equal(run(['--help']).status, 0);
    const invalid = run(['--spec', '-'], '{');
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /JSON構文エラー/);
    const bad = fresh(); bad.meta.units = 'cm';
    const badPath = join(dir, 'invalid.json'); writeFileSync(badPath, JSON.stringify(bad));
    const rejected = run(['--spec', badPath, '--check']);
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /meta.units は mm のみです/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
