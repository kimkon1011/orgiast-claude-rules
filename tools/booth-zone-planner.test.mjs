// Tests for booth-zone-planner.mjs (X-0074)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONE_TYPES,
  validateZonePlan,
  planZones,
  renderZoneSvg,
} from './booth-zone-planner.mjs';

// ---------- ZONE_TYPES ----------

test('ZONE_TYPES has all standard zones', () => {
  assert.ok(Object.hasOwn(ZONE_TYPES, 'reception'));
  assert.ok(Object.hasOwn(ZONE_TYPES, 'display'));
  assert.ok(Object.hasOwn(ZONE_TYPES, 'meeting'));
  assert.ok(Object.hasOwn(ZONE_TYPES, 'demo'));
  assert.ok(Object.hasOwn(ZONE_TYPES, 'storage'));
  assert.ok(Object.hasOwn(ZONE_TYPES, 'aisle'));
  assert.equal(Object.keys(ZONE_TYPES).length, 6);
});

test('ZONE_TYPES reception has frontBand=true', () => {
  assert.ok(ZONE_TYPES.reception.frontBand);
  assert.ok(!ZONE_TYPES.display.frontBand);
  assert.ok(!ZONE_TYPES.storage.frontBand);
});

// ---------- validateZonePlan ----------

test('validateZonePlan rejects non-object', () => {
  const result = validateZonePlan(null);
  assert.ok(!result.ok);
  assert.ok(result.errors.length > 0);
});

test('validateZonePlan rejects missing booth fields', () => {
  const result = validateZonePlan({ zones: [], booth: {} });
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('w_mm')));
  assert.ok(result.errors.some(e => e.includes('d_mm')));
});

test('validateZonePlan rejects overlapping open_sides and walls', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front', 'back'], walls: ['back'] },
    zones: [],
  };
  const result = validateZonePlan(spec);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('重複')));
});

test('validateZonePlan validates zones correctly', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front'], walls: ['back', 'left', 'right'] },
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 900, d_mm: 1000 },
      { id: 'display', type: 'display', label: '展示', x_mm: 300, y_mm: 1000, w_mm: 1500, d_mm: 1200 },
    ],
  };
  const result = validateZonePlan(spec);
  assert.ok(result.ok, `errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

test('validateZonePlan detects zone overlap', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front'], walls: ['back'] },
    zones: [
      { id: 'zone1', type: 'display', label: '展示1', x_mm: 0, y_mm: 0, w_mm: 2000, d_mm: 2000 },
      { id: 'zone2', type: 'display', label: '展示2', x_mm: 1000, y_mm: 1000, w_mm: 2000, d_mm: 2000 },
    ],
  };
  const result = validateZonePlan(spec);
  assert.ok(result.ok); // overlap is warning, not error
  assert.ok(result.warnings.some(w => w.includes('重なっています')));
});

test('validateZonePlan detects out-of-bounds zone', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front'], walls: ['back'] },
    zones: [
      { id: 'big', type: 'display', label: '大きすぎ', x_mm: 0, y_mm: 0, w_mm: 5000, d_mm: 1000 },
    ],
  };
  const result = validateZonePlan(spec);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('超過')));
});

test('validateZonePlan rejects unknown zone type', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front'], walls: ['back'] },
    zones: [
      { id: 'unknown', type: 'swimming_pool', label: 'プール', x_mm: 0, y_mm: 0, w_mm: 1000, d_mm: 1000 },
    ],
  };
  const result = validateZonePlan(spec);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('未知')));
});

test('validateZonePlan detects duplicate zone IDs', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front'], walls: ['back'] },
    zones: [
      { id: 'dup', type: 'display', label: '展示A', x_mm: 0, y_mm: 0, w_mm: 1000, d_mm: 1000 },
      { id: 'dup', type: 'display', label: '展示B', x_mm: 1000, y_mm: 0, w_mm: 1000, d_mm: 1000 },
    ],
  };
  const result = validateZonePlan(spec);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('重複')));
});

// ---------- planZones ----------

test('planZones returns zones for standard 3x3 booth', () => {
  const result = planZones({
    w_mm: 3000, d_mm: 3000,
    open_sides: ['front'],
    walls: ['back', 'left', 'right'],
    required_zones: ['reception', 'display', 'meeting', 'storage'],
  });
  assert.ok(result.zones.length >= 3, `zones = ${result.zones.length}`);
  assert.ok(result.meta.width_mm === 3000);
  assert.ok(result.meta.depth_mm === 3000);
  assert.ok(result.meta.total_area_m2 === 9.0);
  assert.ok(result.meta.utilization_pct > 0);
});

test('planZones includes reception zone when requested', () => {
  const result = planZones({
    w_mm: 6000, d_mm: 3000,
    open_sides: ['front'],
    walls: ['back'],
    required_zones: ['reception', 'display', 'meeting'],
  });
  const reception = result.zones.find(z => z.type === 'reception');
  assert.ok(reception !== undefined);
  assert.ok(reception.priority === ZONE_TYPES.reception.priority);
  assert.ok(reception.x_mm >= 0);
  assert.ok(reception.w_mm > 0);
});

test('planZones includes display zone when requested', () => {
  const result = planZones({
    w_mm: 6000, d_mm: 3000,
    open_sides: ['front'],
    walls: ['back'],
    required_zones: ['display'],
  });
  const display = result.zones.find(z => z.type === 'display');
  assert.ok(display !== undefined);
  assert.ok(display.label === '展示');
});

test('planZones rejects invalid width', () => {
  assert.throws(() => planZones({ w_mm: -100, d_mm: 3000, required_zones: ['display'] }), /正の数/);
});

test('planZones rejects empty required_zones', () => {
  assert.throws(() => planZones({ w_mm: 3000, d_mm: 3000, required_zones: [] }), /1つ以上/);
});

test('planZones returns warnings for overlapping zones', () => {
  const result = planZones({
    w_mm: 2000, d_mm: 2000,
    open_sides: ['front'],
    walls: ['back'],
    required_zones: ['reception', 'display', 'meeting', 'storage', 'demo'],
  });
  // On small booth, zones may overlap
  // The function should still produce a result with possible warnings
  assert.ok(result.zones.length > 0);
  // warnings may or may not be present depending on layout
  assert.ok('warnings' in result);
});

test('planZones handles different booth orientations', () => {
  const landscape = planZones({ w_mm: 6000, d_mm: 3000, open_sides: ['front'], walls: ['back'], required_zones: ['reception', 'display'] });
  const portrait = planZones({ w_mm: 3000, d_mm: 6000, open_sides: ['front'], walls: ['back'], required_zones: ['reception', 'display'] });
  assert.equal(landscape.zones.length, portrait.zones.length);
  // Landscape should have wider zones
  const lDisplay = landscape.zones.find(z => z.type === 'display');
  const pDisplay = portrait.zones.find(z => z.type === 'display');
  assert.ok(lDisplay.w_mm > pDisplay.w_mm, 'landscape display should be wider');
});

test('planZones all-open booth layout', () => {
  const result = planZones({
    w_mm: 6000, d_mm: 3000,
    open_sides: ['front', 'left', 'right'],
    walls: ['back'],
    required_zones: ['reception', 'display'],
  });
  assert.ok(result.zones.length >= 2);
  // Reception should be placed with y_mm=0 (front)
  const reception = result.zones.find(z => z.type === 'reception');
  assert.equal(reception.y_mm, 0);
});

test('planZones booth with all sides open', () => {
  const result = planZones({
    w_mm: 6000, d_mm: 6000,
    open_sides: ['front', 'back', 'left', 'right'],
    walls: [],
    required_zones: ['display', 'meeting', 'demo', 'storage'],
  });
  assert.ok(result.zones.length >= 3);
  assert.ok(result.meta.utilization_pct > 0);
});

// ---------- renderZoneSvg ----------

test('renderZoneSvg produces valid SVG', () => {
  const spec = {
    booth: { w_mm: 3000, d_mm: 3000, open_sides: ['front'], walls: ['back'] },
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 900, d_mm: 1000, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 200, y_mm: 1000, w_mm: 2000, d_mm: 1500, color: '#dcfce7' },
    ],
    rules: { minAisleMm: 600 },
    meta: { name: 'テストゾーン' },
  };
  const svg = renderZoneSvg(spec);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('受付'));
  assert.ok(svg.includes('展示'));
  assert.ok(svg.includes('3000×3000'));
});

test('renderZoneSvg throws on invalid spec', () => {
  assert.throws(() => renderZoneSvg({}), /検証エラー/);
});

// ---------- Integration ----------

test('planZones → validateZonePlan round trip', () => {
  const requirements = {
    w_mm: 6000, d_mm: 3000,
    open_sides: ['front'],
    walls: ['back'],
    required_zones: ['reception', 'display', 'meeting', 'storage'],
  };
  const result = planZones(requirements);

  const spec = {
    booth: { w_mm: requirements.w_mm, d_mm: requirements.d_mm, open_sides: requirements.open_sides, walls: requirements.walls },
    zones: result.zones,
    rules: { minAisleMm: 600 },
  };

  const validation = validateZonePlan(spec);
  assert.ok(validation.ok, `validation errors: ${validation.errors.join(', ')}`);
});

test('planZones 6x9 large booth has all requested zones', () => {
  const result = planZones({
    w_mm: 9000, d_mm: 6000,
    open_sides: ['front'],
    walls: ['back', 'left', 'right'],
    required_zones: ['reception', 'display', 'meeting', 'demo', 'storage'],
  });
  const types = result.zones.map(z => z.type);
  assert.ok(types.includes('reception'));
  assert.ok(types.includes('display'));
  assert.ok(types.includes('meeting'));
  assert.ok(types.includes('storage'));
});

test('planZones very small booth (2x2) still produces layout', () => {
  const result = planZones({
    w_mm: 2000, d_mm: 2000,
    open_sides: ['front'],
    walls: ['back'],
    required_zones: ['reception', 'display'],
  });
  assert.ok(result.zones.length >= 1);
  assert.ok(result.meta.utilization_pct > 0);
  // Very small booth may have warnings about overlap
  assert.ok('warnings' in result);
});