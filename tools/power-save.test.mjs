import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePowercfgQuery, buildPlan, formatStatus, formatPost } from './power-save.mjs';

test('parsePowercfgQueryが日本語ロケールの出力からAC/DCを正しく取得し、紛れ込む0x行を無視すること', () => {
  const input = `      利用可能な設定の最大値: 0x00000064
    現在の AC 電源設定のインデックス: 0x00000050
    現在の DC 電源設定のインデックス: 0x00000032`;
  const result = parsePowercfgQuery(input);
  assert.deepEqual(result, { ac: 80, dc: 50 });
});

test('parsePowercfgQueryが英語ロケールの出力からAC/DCを正しく取得し、紛れ込む0x行を無視すること', () => {
  const input = `      Maximum Possible Setting: 0x00000064
    Current AC Power Setting Index: 0x00000050
    Current DC Power Setting Index: 0x00000032`;
  const result = parsePowercfgQuery(input);
  assert.deepEqual(result, { ac: 80, dc: 50 });
});

test('parsePowercfgQueryがAC/DC行の無い出力でnullを返し、0と混同しないこと', () => {
  const input = `      利用可能な設定の最大値: 0x00000064`;
  const result = parsePowercfgQuery(input);
  assert.deepEqual(result, { ac: null, dc: null });
});

test('buildPlanが既定では画面OFFに触らずVIDEOIDLEを含まないこと', () => {
  const plan = buildPlan({ max: 80 });
  const names = plan.map(item => item.name);
  assert.deepEqual(names, ['PROCTHROTTLEMAX', 'PROCTHROTTLEMIN', 'SYSCOOLPOL']);
});

test('buildPlanがvideoOff指定時にVIDEOIDLEを末尾に含み、値が指定通りであること', () => {
  const plan = buildPlan({ max: 80, videoOff: 120 });
  assert.equal(plan[plan.length - 1].name, 'VIDEOIDLE');
  assert.equal(plan[plan.length - 1].value, 120);
});

test('buildPlanのmaxが範囲外・不正でも0〜100に収まること', () => {
  assert.equal(buildPlan({ max: 500 })[0].value, 100);
  assert.equal(buildPlan({ max: -5 })[0].value, 0);
  assert.equal(buildPlan({ max: 'abc' })[0].value, 80);
});

test('formatStatusが推定効果の行を含み、target未指定時は含まないこと', () => {
  const values = {
    PROCTHROTTLEMAX: { ac: 80, dc: 50 },
    PROCTHROTTLEMIN: { ac: 5, dc: 5 },
    SYSCOOLPOL: { ac: 0, dc: 0 },
    VIDEOIDLE: { ac: 600, dc: 600 }
  };
  const withTarget = formatStatus(values, 80);
  assert.ok(withTarget.includes('推定効果'));
  const withoutTarget = formatStatus(values);
  assert.ok(!withoutTarget.includes('推定効果'));
});

test('formatStatusがnullの値を取得失敗と表示し、0%と表示しないこと', () => {
  const values = {
    PROCTHROTTLEMAX: { ac: null, dc: null },
    PROCTHROTTLEMIN: { ac: null, dc: null },
    SYSCOOLPOL: { ac: null, dc: null },
    VIDEOIDLE: { ac: null, dc: null }
  };
  const output = formatStatus(values);
  assert.ok(output.includes('取得失敗'));
  assert.ok(!output.includes('0%'));
});

test('formatStatusのSYSCOOLPOLが0でパッシブ、1でアクティブと表示されること', () => {
  const values = {
    PROCTHROTTLEMAX: { ac: 80, dc: 50 },
    PROCTHROTTLEMIN: { ac: 5, dc: 5 },
    SYSCOOLPOL: { ac: 0, dc: 1 },
    VIDEOIDLE: { ac: 600, dc: 600 }
  };
  const output = formatStatus(values);
  assert.ok(output.includes('冷却ポリシー(SYSCOOLPOL):     AC パッシブ / DC アクティブ'));
});

test('formatPostがhostname=をちょうど1回含み、それが最後の行であること', () => {
  const values = {
    PROCTHROTTLEMAX: { ac: 80, dc: 50 },
    PROCTHROTTLEMIN: { ac: 5, dc: 5 },
    SYSCOOLPOL: { ac: 0, dc: 0 },
    VIDEOIDLE: { ac: 600, dc: 600 }
  };
  const output = formatPost({
    label: 'test',
    hostname: 'PC001',
    before: values,
    after: values,
    failures: {}
  });
  const lines = output.split('\n');
  const hostnameLines = lines.filter(line => line.includes('hostname='));
  assert.equal(hostnameLines.length, 1);
  assert.equal(lines[lines.length - 1], '🖥 hostname=PC001');
});

test('formatPostがfailures指定でその行に⚠️を含むこと', () => {
  const values = {
    PROCTHROTTLEMAX: { ac: 80, dc: 50 },
    PROCTHROTTLEMIN: { ac: 5, dc: 5 },
    SYSCOOLPOL: { ac: 0, dc: 0 },
    VIDEOIDLE: { ac: 600, dc: 600 }
  };
  const output = formatPost({
    label: 'test',
    hostname: 'PC001',
    before: values,
    after: values,
    failures: { PROCTHROTTLEMAX: true }
  });
  const lines = output.split('\n');
  const cpuLine = lines.find(line => line.startsWith('CPU電力上限'));
  assert.ok(cpuLine.includes('⚠️'));
});
