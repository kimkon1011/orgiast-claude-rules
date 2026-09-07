import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const script = new URL('./fleet-sheet-report.mjs', import.meta.url);

function reportPayload(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sheet-report-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/report\nFLEET_SHEET_TOKEN=test-token\n');
  fs.writeFileSync(path.join(claude, 'cost-reporter.env'), 'REPORTER_LABEL=fleet-sheet-test\n');
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(claude, name), JSON.stringify(value));
  try {
    const result = spawnSync(process.execPath, [script.pathname, '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, VERSION_DRIFT_SKIP: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('stateに計測値が無ければ数値0へ変換しない', () => {
  const payload = reportPayload();
  assert.equal(payload.delegRatio, '');
  assert.equal(payload.delegRatioLegacy, '');
  assert.equal(payload.claudeUsd, '');
});

test('stateに計測値があればパーセント表記で送る', () => {
  const payload = reportPayload({
    'cost-loop-state.json': { nonClaudeDelegRatio: 0.286, delegRatio: 0.286, claudeUSD: 1.234 },
  });
  assert.equal(payload.delegRatio, '28.6%');
  assert.equal(payload.delegRatioLegacy, '28.6%');
  assert.equal(payload.claudeUsd, 1.23);
});

test('GAS upsertは空の計測値で既存セルを上書きせず、実測0は更新する', () => {
  const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/UpsertLogic.gs', import.meta.url), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);
  const headers = Object.values(context.FLEET_HEADERS_);
  const columns = context.fleetResolveColumns(headers);
  const row = headers.map(() => '');
  row[columns.hostname] = 'fleet-sheet-test';
  row[columns.claudeUsd] = 9.87;
  row[columns.delegRatio] = '28.6%';
  row[columns.delegRatioLegacy] = '20.0%';

  const unknown = context.fleetPlanUpsert(headers, [row], {
    label: 'fleet-sheet-test', claudeUsd: '', delegRatio: '', delegRatioLegacy: '',
  });
  assert.ok(!Object.hasOwn(unknown.values, String(columns.claudeUsd)));
  assert.ok(!Object.hasOwn(unknown.values, String(columns.delegRatio)));
  assert.ok(!Object.hasOwn(unknown.values, String(columns.delegRatioLegacy)));

  const zero = context.fleetPlanUpsert(headers, [row], {
    label: 'fleet-sheet-test', claudeUsd: 0, delegRatio: '0.0%', delegRatioLegacy: '0.0%',
  });
  assert.equal(zero.values[columns.claudeUsd], 0);
  assert.equal(zero.values[columns.delegRatio], '0.0%');
  assert.equal(zero.values[columns.delegRatioLegacy], '0.0%');
});
