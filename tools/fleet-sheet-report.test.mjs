import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { post } from './fleet-sheet-report.mjs';

const script = new URL('./fleet-sheet-report.mjs', import.meta.url);

function reportPayload(files = {}, codexAuth) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sheet-report-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/report\nFLEET_SHEET_TOKEN=test-token\n');
  fs.writeFileSync(path.join(claude, 'cost-reporter.env'), 'REPORTER_LABEL=fleet-sheet-test\n');
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(claude, name), JSON.stringify(value));
  try {
    if (codexAuth) {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify(codexAuth));
    }
    const result = spawnSync(process.execPath, [fileURLToPath(script), '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, VERSION_DRIFT_SKIP: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('adoption state が無くても認証ファイルの Codex アカウントとプランを報告する', () => {
  const payload = { email: 'codex@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'prolite' } };
  const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.dummy-signature`;
  assert.equal(reportPayload({}, { tokens: { id_token: token } }).codexLogin, '済(codex@example.com/prolite)');
});

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

test('keyserve status を既存 status payload に相乗りさせる', () => {
  const checkedAt = '2026-09-12T00:00:00.000Z';
  const old = process.env.ORGIAST_KEYSERVE_STATUS_JSON;
  process.env.ORGIAST_KEYSERVE_STATUS_JSON = JSON.stringify({ auth: 'legacy', success: true, status: 200, checkedAt });
  try {
    const payload = reportPayload();
    assert.equal(payload.keyserveAuth, 'legacy');
    assert.equal(payload.keyserveStatus, 200);
    assert.equal(payload.keyserveCheckedAt, checkedAt);
  } finally {
    if (old === undefined) delete process.env.ORGIAST_KEYSERVE_STATUS_JSON; else process.env.ORGIAST_KEYSERVE_STATUS_JSON = old;
  }
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

const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
test('HTTP 200 + ok:false は3回再送して失敗ログを残す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-post-')), logFile = path.join(dir, 'report.log'); let calls = 0;
  const result = await post('secret-url', 'status', { token: 'secret' }, { fetchFn: async () => { calls++; return response({ ok: false, error: 'busy' }); }, sleepFn: async () => {}, random: () => 0, logFile });
  assert.equal(result.ok, false); assert.equal(calls, 3); assert.match(fs.readFileSync(logFile, 'utf8'), /kind=status attempts=3 result=failed error=busy/);
});
test('busy 後の成功は2回目で完了する', async () => { let calls = 0; const result = await post('u', 'status', {}, { fetchFn: async () => response(++calls === 1 ? { ok: false, error: 'busy' } : { ok: true }), sleepFn: async () => {}, logFile: path.join(os.tmpdir(), `fleet-${Date.now()}.log`) }); assert.equal(result.ok, true); assert.equal(calls, 2); });
test('timeout は再送する', async () => { let calls = 0; const result = await post('u', 'status', {}, { fetchFn: async () => { calls++; if (calls === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); return response({ ok: true }); }, sleepFn: async () => {}, logFile: path.join(os.tmpdir(), `fleet-${Date.now()}-t.log`) }); assert.equal(result.ok, true); assert.equal(calls, 2); });
