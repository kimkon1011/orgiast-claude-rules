// Tests for booth-layout-optimizer.mjs (X-0074)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EQUIPMENT_CATALOG,
  validateLayoutPlan,
  optimizeLayout,
  renderLayoutSvg,
} from './booth-layout-optimizer.mjs';

// ---------- EQUIPMENT_CATALOG ----------

test('EQUIPMENT_CATALOG has all standard equipment', () => {
  assert.ok(Object.hasOwn(EQUIPMENT_CATALOG, 'counter_table'));
  assert.ok(Object.hasOwn(EQUIPMENT_CATALOG, 'display_shelf'));
  assert.ok(Object.hasOwn(EQUIPMENT_CATALOG, 'meeting_table'));
  assert.ok(Object.hasOwn(EQUIPMENT_CATALOG, 'chair'));
  assert.ok(Object.hasOwn(EQUIPMENT_CATALOG, 'storage_box'));
  assert.ok(Object.hasOwn(EQUIPMENT_CATALOG, 'led_sign'));
  assert.equal(Object.keys(EQUIPMENT_CATALOG).length, 10);
});

test('EQUIPMENT_CATALOG reception items include counter_table', () => {
  assert.ok(EQUIPMENT_CATALOG.counter_table.zones.includes('reception'));
  assert.ok(EQUIPMENT_CATALOG.brochure_rack.zones.includes('reception'));
});

test('EQUIPMENT_CATALOG display items include display_shelf', () => {
  assert.ok(EQUIPMENT_CATALOG.display_shelf.zones.includes('display'));
});

// ---------- validateLayoutPlan ----------

test('validateLayoutPlan rejects null', () => {
  const result = validateLayoutPlan(null);
  assert.ok(!result.ok);
  assert.equal(result.totalCost, 0);
});

test('validateLayoutPlan validates simple layout', () => {
  const plan = {
    booth: { w_mm: 3000, d_mm: 3000 },
    items: [
      { id: 'table1', type: 'table', label: 'テーブル', x_mm: 100, y_mm: 100, w_mm: 900, d_mm: 450, price: 15000 },
    ],
  };
  const result = validateLayoutPlan(plan);
  assert.ok(result.ok, `errors: ${result.errors.join(', ')}`);
  assert.equal(result.totalCost, 15000);
});

test('validateLayoutPlan detects out-of-bounds items', () => {
  const plan = {
    booth: { w_mm: 3000, d_mm: 3000 },
    items: [
      { id: 'big', type: 'table', label: '大きい', x_mm: 2500, y_mm: 100, w_mm: 1000, d_mm: 500 },
    ],
  };
  const result = validateLayoutPlan(plan);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('超過')));
});

test('validateLayoutPlan detects item overlap', () => {
  const plan = {
    booth: { w_mm: 3000, d_mm: 3000 },
    items: [
      { id: 'a', type: 'table', label: 'A', x_mm: 100, y_mm: 100, w_mm: 1000, d_mm: 1000 },
      { id: 'b', type: 'chair', label: 'B', x_mm: 500, y_mm: 500, w_mm: 500, d_mm: 500 },
    ],
  };
  const result = validateLayoutPlan(plan);
  assert.ok(result.ok); // overlap is warning
  assert.ok(result.warnings.some(w => w.includes('重なり')));
});

test('validateLayoutPlan detects duplicate IDs', () => {
  const plan = {
    booth: { w_mm: 3000, d_mm: 3000 },
    items: [
      { id: 'dup', type: 'table', label: 'A', x_mm: 100, y_mm: 100, w_mm: 500, d_mm: 500 },
      { id: 'dup', type: 'chair', label: 'B', x_mm: 1000, y_mm: 100, w_mm: 500, d_mm: 500 },
    ],
  };
  const result = validateLayoutPlan(plan);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('重複')));
});

test('validateLayoutPlan detects missing required fields', () => {
  const plan = {
    booth: { w_mm: 3000, d_mm: 3000 },
    items: [
      { id: 'test', x_mm: 100, y_mm: 100 }, // missing type, label, w_mm, d_mm
    ],
  };
  const result = validateLayoutPlan(plan);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('type')));
  assert.ok(result.errors.some(e => e.includes('label')));
});

test('validateLayoutPlan accumulates totalCost across items', () => {
  const plan = {
    booth: { w_mm: 3000, d_mm: 3000 },
    items: [
      { id: 'a', type: 'a', label: 'A', x_mm: 0, y_mm: 0, w_mm: 100, d_mm: 100, price: 10000 },
      { id: 'b', type: 'b', label: 'B', x_mm: 100, y_mm: 0, w_mm: 100, d_mm: 100, price: 25000 },
      { id: 'c', type: 'c', label: 'C', x_mm: 200, y_mm: 0, w_mm: 100, d_mm: 100, price: 5000 },
    ],
  };
  const result = validateLayoutPlan(plan);
  assert.ok(result.ok);
  assert.equal(result.totalCost, 40000);
});

// ---------- optimizeLayout ----------

const sampleZonePlan = {
  zones: [
    { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 2700, d_mm: 1000, priority: 1, color: '#dbeafe' },
    { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 1000, w_mm: 3000, d_mm: 1200, priority: 2, color: '#dcfce7' },
  ],
  meta: { width_mm: 3000, depth_mm: 3000, min_aisle_mm: 600 },
};

test('optimizeLayout generates items from zone plan', () => {
  const result = optimizeLayout(sampleZonePlan);
  assert.ok(result.items.length > 0, `items = ${result.items.length}`);
  assert.ok(result.zones.length === 2);
  assert.ok(result.totalCost > 0);
  assert.ok('meta' in result);
});

test('optimizeLayout includes reception and display items', () => {
  const result = optimizeLayout(sampleZonePlan);
  const receptionItems = result.items.filter(i => i.zone === 'reception');
  const displayItems = result.items.filter(i => i.zone === 'display');
  assert.ok(receptionItems.length > 0, `reception items = ${receptionItems.length}`);
  assert.ok(displayItems.length > 0, `display items = ${displayItems.length}`);
});

test('optimizeLayout respects budget constraint', () => {
  const tightBudget = 50000;
  const result = optimizeLayout(sampleZonePlan, { budget: tightBudget });
  assert.ok(result.totalCost <= tightBudget,
    `cost ${result.totalCost} > budget ${tightBudget}`);
  assert.ok(result.meta.within_budget === true);
});

test('optimizeLayout handles zero budget', () => {
  // With budget=0, no items should be placed (all would exceed budget)
  const result = optimizeLayout({ zones: [{ id: 'test', type: 'display', label: 'テスト', x_mm: 0, y_mm: 0, w_mm: 3000, d_mm: 3000, priority: 1 }], meta: { width_mm: 3000, depth_mm: 3000, min_aisle_mm: 600 } }, { budget: 0 });
  assert.ok(result.items.length === 0);
  assert.equal(result.totalCost, 0);
});

test('optimizeLayout with priority items', () => {
  const result = optimizeLayout(sampleZonePlan, {
    budget: 300000,
    priority_items: ['counter_table', 'led_sign'],
  });
  const counterItem = result.items.find(i => i.id.startsWith('counter_table'));
  // counter table should be placed
  assert.ok(counterItem !== undefined, 'counter_table should be placed');
});

test('optimizeLayout produces warnings for small zone', () => {
  const tinyZone = {
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 500, d_mm: 500, priority: 1, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 500, w_mm: 500, d_mm: 500, priority: 2, color: '#dcfce7' },
    ],
    meta: { width_mm: 500, depth_mm: 1000, min_aisle_mm: 300 },
  };
  const result = optimizeLayout(tinyZone);
  // May have warnings about capacity
  assert.ok('warnings' in result);
});

test('optimizeLayout throws on invalid zone plan', () => {
  assert.throws(() => optimizeLayout(null), /配列/);
  assert.throws(() => optimizeLayout({}), /配列/);
});

test('optimizeLayout handles all zone types', () => {
  const fullZonePlan = {
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 3000, d_mm: 1000, priority: 1, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 1000, w_mm: 3000, d_mm: 1500, priority: 2, color: '#dcfce7' },
      { id: 'meeting', type: 'meeting', label: '商談', x_mm: 0, y_mm: 2500, w_mm: 3000, d_mm: 1500, priority: 3, color: '#fef9c3' },
      { id: 'demo', type: 'demo', label: 'デモ', x_mm: 0, y_mm: 4000, w_mm: 3000, d_mm: 1200, priority: 4, color: '#cffafe' },
      { id: 'storage', type: 'storage', label: '收納', x_mm: 0, y_mm: 5200, w_mm: 3000, d_mm: 800, priority: 5, color: '#e2e8f0' },
    ],
    meta: { width_mm: 3000, depth_mm: 6000, min_aisle_mm: 600 },
  };
  const result = optimizeLayout(fullZonePlan, { budget: 2000000 });
  assert.ok(result.items.length > 0);
  // Each zone should have at least its primary equipment
  const types = result.items.map(i => i.zone);
  assert.ok(types.includes('reception'));
  assert.ok(types.includes('display'));
  assert.ok(types.includes('meeting'));
  assert.ok(types.includes('storage'));
});

// ---------- renderLayoutSvg ----------

test('renderLayoutSvg produces valid SVG', () => {
  const result = optimizeLayout(sampleZonePlan);
  const svg = renderLayoutSvg(result);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('3000×3000'));
});

test('renderLayoutSvg throws on invalid input', () => {
  assert.throws(() => renderLayoutSvg({}), /レイアウトデータ/);
  assert.throws(() => renderLayoutSvg(null), /レイアウトデータ/);
});

// ---------- Integration ----------

test('optimizeLayout → validateLayoutPlan round trip', () => {
  const result = optimizeLayout(sampleZonePlan, { budget: 300000 });
  const plan = {
    booth: { w_mm: result.meta.width_mm, d_mm: result.meta.depth_mm },
    items: result.items,
  };
  const validation = validateLayoutPlan(plan);
  assert.ok(validation.ok, `validation errors: ${validation.errors.join(', ')}`);
  // Total cost should match
  assert.equal(validation.totalCost, result.totalCost);
});

test('Large booth with generous budget places all equipment types', () => {
  const largeZonePlan = {
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 6000, d_mm: 1500, priority: 1, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 1500, w_mm: 6000, d_mm: 3000, priority: 2, color: '#dcfce7' },
      { id: 'meeting', type: 'meeting', label: '商談', x_mm: 0, y_mm: 4500, w_mm: 6000, d_mm: 1500, priority: 3, color: '#fef9c3' },
    ],
    meta: { width_mm: 6000, depth_mm: 6000, min_aisle_mm: 800 },
  };
  const result = optimizeLayout(largeZonePlan, { budget: 5000000 });
  assert.ok(result.items.length >= 5, `items = ${result.items.length}`);
  assert.ok(result.meta.within_budget);
});

test('Cost calculation matches sum of individual item prices', () => {
  const result = optimizeLayout(sampleZonePlan);
  const sum = result.items.reduce((s, i) => s + i.price, 0);
  assert.equal(result.totalCost, sum);
});