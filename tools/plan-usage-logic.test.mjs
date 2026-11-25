import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const logic = fs.readFileSync(new URL('../gas/fleet-status-sheet/PlanUsageLogic.gs', import.meta.url), 'utf8');
const writer = fs.readFileSync(new URL('../gas/fleet-status-sheet/PlanUsage.gs', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(logic, context);
const payload = {
  label: 'kim-PC', hostname: 'host', claudeAccount: 'User@Example.com', reportedAt: '2026-10-21 09:15', available: true,
  fiveHourPct: 20, sevenDayPct: 72, fiveHourResetsAt: '2026-10-21T03:00:00Z', sevenDayResetsAt: '2026-10-24T00:00:00Z',
  scoped: [{ label: 'Fable', percent: 72, resetsAt: '2026-10-24T00:00:00Z' }],
};
const create = () => context.planUsageUpsert([], payload).row;

test('新規アカウントは13列の行を追加、B/DはNOWで日時値を比較する割合数式', () => {
  const plan = context.planUsageUpsert([], payload);
  assert.equal(plan.action, 'inserted');
  assert.equal(plan.rowIndex, 0);
  assert.equal(plan.row.length, 13);
  assert.equal(plan.row[0], 'user@example.com');
  assert.equal(plan.row[9], 20);
  assert.equal(plan.row[10], 72);
  assert.equal(plan.row[11].toISOString(), payload.fiveHourResetsAt.replace('Z', '.000Z'));
  assert.match(plan.row[1], /NOW\(\)>L2\),1,/);
  assert.match(plan.row[3], /NOW\(\)>M2\),1,/);
  assert.equal(plan.row[2], '=IF(L2="","",L2)');
  assert.equal(plan.row[4], '=IF(M2="","",M2)');
  assert.equal(plan.row[6], 'OK');
});

test('同じアカウントは大小文字・PCが違っても新しい報告で上書きする', () => {
  const row = create();
  const plan = context.planUsageUpsert([row], { ...payload, claudeAccount: 'USER@example.com', label: 'second-PC', fiveHourPct: 90, reportedAt: '2026-10-21 09:16' });
  assert.equal(plan.action, 'updated');
  assert.equal(plan.rowIndex, 0);
  assert.equal(plan.row[9], 90);
  assert.equal(plan.row[8], 'second-PC (host)');
  assert.equal(row[9], 20, 'input stays unchanged');
});

test('古いreportedAtは成功報告も失敗報告も上書きしない', () => {
  for (const available of [true, false]) {
    const row = create();
    const plan = context.planUsageUpsert([row], { ...payload, available, reportedAt: '2026-10-20 23:59' });
    assert.equal(plan.action, 'ignored');
    assert.equal(plan.row, undefined);
    assert.equal(row[6], 'OK');
  }
});

test('available:falseは数値・リセット日時・モデル枠を保持し状態と報告元を更新', () => {
  const row = create();
  const plan = context.planUsageUpsert([row], { ...payload, available: false, reason: 'HTTP 401', label: 'other', reportedAt: '2026-10-21 09:16', fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null, scoped: [] });
  assert.deepEqual(plan.row.slice(9), row.slice(9));
  assert.equal(plan.row[5], row[5]);
  assert.equal(plan.row[6], '計測不能: HTTP 401');
  assert.equal(plan.row[7], '2026-10-21 09:16');
  assert.equal(plan.row[8], 'other (host)');
  const firstFailure = context.planUsageUpsert([], { ...payload, available: false });
  assert.ok(firstFailure.row.slice(9).every(value => value === ''));
});

test('アカウント空はラベルをキーにしてPC同士が潰し合わない', () => {
  const empty = { ...payload, claudeAccount: '' };
  const row = context.planUsageUpsert([], empty).row;
  assert.equal(row[0], '(不明) kim-PC');
  assert.equal(context.planUsageUpsert([row], empty).action, 'updated');
  assert.equal(context.planUsageUpsert([row], { ...empty, label: 'second-PC' }).rowIndex, 1);
});

test('モデル別週枠はJST日時と残量を / 区切りで表示', () => {
  assert.equal(context.planUsageScopedText([...payload.scoped, { label: 'Sonnet', percent: 20, resetsAt: '2026-10-23T23:30:00Z' }]), 'Fable 残り28%（10/24 09:00） / Sonnet 残り80%（10/24 08:30）');
  assert.equal(context.planUsageScopedText([{ label: 'bad', percent: null }]), '');
});

test('ゼロ消化率を維持、未計測・不正日時は空欄、labelとreportedAt必須', () => {
  const plan = context.planUsageUpsert([], { ...payload, fiveHourPct: 0, sevenDayPct: null, fiveHourResetsAt: 'invalid' });
  assert.equal(plan.row[9], 0);
  assert.equal(plan.row[10], '');
  assert.equal(plan.row[11], '');
  assert.throws(() => context.planUsageUpsert([], { ...payload, label: '' }), /label_required/);
  assert.throws(() => context.planUsageUpsert([], { ...payload, reportedAt: '' }), /reportedAt_required/);
});

function gasFixture({ busy = false, fail = false } = {}) {
  const calls = [], rows = [];
  const cellFormulas = new Map();
  let exists = false, header = [];
  const range = (...coords) => ({
    setValues(values) { calls.push(['values', coords]); if (coords[0] > 1) rows[coords[0] - 2] = [...values[0]]; else header = [...values[0]]; return this; },
    getDisplayValue() { return coords[0] === 1 ? (header[coords[1] - 1] ?? '') : ''; },
    getValues() { return rows; },
    setNumberFormat(format) { calls.push(['format', coords, format]); return this; },
    setFormulas(formulas) { calls.push(['formulas', coords, formulas]); return this; },
    getFormula() { return cellFormulas.get(JSON.stringify(coords)) ?? ''; },
    setFormula(formula) { calls.push(['formula', coords, formula]); cellFormulas.set(JSON.stringify(coords), formula); return this; },
    sort(spec) { calls.push(['sort', spec]); return this; },
  });
  const sheet = {
    getLastRow: () => rows.length + 1, getMaxRows: () => 1000, getRange: range,
    setFrozenRows: n => calls.push(['freeze', n]), setConditionalFormatRules: rules => calls.push(['rules', rules]),
  };
  const spreadsheet = {
    getSheetByName: name => { assert.equal(name, 'Claude上限'); return exists ? sheet : null; },
    insertSheet: name => { exists = true; calls.push(['create', name]); return sheet; },
    getSpreadsheetTimeZone: () => 'Etc/GMT',
    setSpreadsheetTimeZone: zone => calls.push(['timezone', zone]),
    setRecalculationInterval: interval => calls.push(['recalc', interval]),
  };
  const rule = () => ({ whenNumberLessThan(n) { this.threshold = n; return this; }, setBackground() { return this; }, setRanges() { return this; }, build() { return this; } });
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => { assert.equal(key, 'SHEET_ID'); return 'fleet-sheet'; } }) },
    LockService: { getScriptLock: () => ({ tryLock: n => { calls.push(['lock', n]); return !busy; }, releaseLock: () => calls.push(['release']) }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'fleet-sheet'); if (fail) throw new Error('sheet failure'); return spreadsheet; }, RecalculationInterval: { HOUR: 'HOUR' }, newConditionalFormatRule: rule, flush: () => calls.push(['flush']) },
  });
  vm.runInContext(logic + '\n' + writer, ctx);
  return { ctx, calls, rows };
}

test('GASはSHEET_ID・JST・毎時再計算で作成、週残り昇順ソート後に数式を復元、書式は初回のみ', () => {
  const { ctx, calls } = gasFixture();
  assert.equal(ctx.upsertPlanUsage(payload).ok, true);
  assert.equal(ctx.upsertPlanUsage({ ...payload, reportedAt: '2026-10-21 09:16' }).ok, true);
  assert.ok(calls.some(c => c[0] === 'recalc' && c[1] === 'HOUR'));
  assert.ok(calls.some(c => c[0] === 'timezone' && c[1] === 'Asia/Tokyo'));
  assert.equal(calls.filter(c => c[0] === 'rules').length, 1);
  assert.deepEqual(Array.from(calls.find(c => c[0] === 'rules')[1], rule => rule.threshold), [0.2, 0.5]);
  assert.ok(calls.some(c => c[0] === 'sort' && c[1].column === 4 && c[1].ascending));
  assert.ok(calls.findIndex(c => c[0] === 'sort') < calls.findIndex(c => c[0] === 'formulas'));
  assert.equal(calls.filter(c => c[0] === 'release').length, 2);
});

test('GASはタブ作成時にN1へ不具合・要望フォームを設定し、既存の数式は再設定しない', () => {
  const { ctx, calls } = gasFixture();
  const url = 'https://script.google.com/macros/s/AKfycbzzOD2hA2hNKK8SccyRGf0tFivf_WS_VjWzOS5RgVnM3VD63jpu0xcprAOxUcDmuxlC/exec?form=feedback&app=' + encodeURIComponent('Claude上限ダッシュボード');
  const expected = [['formula', [1, 14], `=HYPERLINK("${url}","不具合・要望")`]];

  assert.equal(ctx.upsertPlanUsage(payload).ok, true);
  assert.deepEqual(calls.filter(c => c[0] === 'create'), [['create', 'Claude上限']]);
  assert.deepEqual(calls.filter(c => c[0] === 'formula'), expected);

  assert.equal(ctx.upsertPlanUsage({ ...payload, reportedAt: '2026-10-21 09:16' }).ok, true);
  assert.deepEqual(calls.filter(c => c[0] === 'formula'), expected);
});

test('GASはロック取得失敗でbusy、例外でもロック解放', () => {
  const busy = gasFixture({ busy: true });
  const result = busy.ctx.upsertPlanUsage(payload);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'busy');
  assert.equal(busy.calls.length, 1);
  assert.equal(busy.calls[0][1], 20000);
  const fail = gasFixture({ fail: true });
  assert.throws(() => fail.ctx.upsertPlanUsage(payload), /sheet failure/);
  assert.equal(fail.calls.at(-1)[0], 'release');
});
