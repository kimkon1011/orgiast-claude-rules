import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeCheckForBash, executeCheck, preflightCheck } from './auto-progress-check.mjs';
import { addCheck, auditChecks } from './auto-progress.mjs';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';
import { run as watch } from './auto-progress-watch.mjs';

function temp(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-crash-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const crash = 'node:internal/modules/cjs/loader:1404\n  throw err;\nError: Cannot find module x\nMODULE_NOT_FOUND';
test('normalize quoted and unquoted drive paths, preserving unrelated escapes', () => {
  assert.equal(normalizeCheckForBash(String.raw`node C:\Users\uers\.claude\check.mjs`), 'node C:/Users/uers/.claude/check.mjs');
  assert.equal(normalizeCheckForBash(String.raw`"C:\Program Files\node.exe" 'D:\some folder\check.mjs'`), '"C:/Program Files/node.exe" \'D:/some folder/check.mjs\'');
  const escapes = String.raw`node -e "console.log(\"hello\"); process.exit(1)"`;
  assert.equal(normalizeCheckForBash(escapes), escapes);
  assert.equal(normalizeCheckForBash(String.raw`node C:\checks\a.mjs && printf '\n'`), String.raw`node C:/checks/a.mjs && printf '\n'`);
});
test('only explicit bash receives normalized paths', () => {
  const check = String.raw`node C:\checks\a.mjs`;
  executeCheck({ check }, { shellPath: 'bash', spawnImpl: (_, args) => {
    assert.deepEqual(args, ['-c', 'node C:/checks/a.mjs']); return { status: 1 };
  } });
  executeCheck({ check }, { shellPath: null, spawnImpl: command => {
    assert.equal(command, check); return { status: 1 };
  } });
});
for (const stderr of [crash, 'TypeError: broken\n    at main (file:1:1)', 'bash: x: command not found', 'bash: x: No such file or directory']) {
  test(`exit 1 crash is an error: ${stderr.split('\n')[0]}`, () => {
    const result = executeCheck({ check: 'x' }, { spawnImpl: () => ({ status: 1, stderr, stdout: 'misleading success' }) });
    assert.equal(result.code, null);
    assert.equal(result.text, `check エラー: ${stderr.split('\n')[0]}`);
  });
}
test('ordinary exit 1 remains unmet', () => {
  const result = executeCheck({ check: 'x' }, { spawnImpl: () => ({ status: 1, stderr: 'まだ未達' }) });
  assert.equal(result.code, 1); assert.equal(result.text, '未達');
});
test('preflight and CLI reject missing module even with force and do not write ledger', t => {
  const home = temp(t), check = 'node missing-auto-progress-probe.mjs';
  for (const forceCheck of [false, true]) {
    const pf = preflightCheck({ check, checkCwd: home }, { home, forceCheck });
    assert.equal(pf.ok, false); assert.equal(pf.preflight, 'exec_error');
    assert.throws(() => addCheck({ home, session: 's', label: 'x', check, deadline: '+24h', probe: row => executeCheck(row, { home }) }), /実行できません/);
    const result = spawnSync(process.execPath, ['tools/auto-progress.mjs', '--add-check', '--session', 's', '--label', 'x', '--check', check, '--deadline', '+24h', ...(forceCheck ? ['--force-check'] : [])], { env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8' });
    assert.equal(result.status, 2); assert.match(result.stderr, /check エラー/);
    assert.equal(readLedger(ledgerFile(home)).length, 0);
  }
});
test('audit executes open checks in order and leaves ledger byte-identical', t => {
  const home = temp(t), file = ledgerFile(home);
  writeLedger(file, [
    { status: 'open', check: 'bad', label: '故障' }, { status: 'open', check: 'pending', label: '待機' },
    { status: 'done', check: 'ignored' }, { status: 'open' },
  ]);
  const before = fs.readFileSync(file), seen = [];
  const report = auditChecks({ home, execute: row => { seen.push(row.check); return row.check === 'bad' ? { code: null, stderr: crash } : { code: 1 }; } });
  assert.deepEqual(seen, ['bad', 'pending']);
  assert.deepEqual(report, { checked: 2, errorCount: 1, errors: [{ label: '故障', stderr: crash.split('\n')[0] }] });
  assert.deepEqual(fs.readFileSync(file), before);
});
test('watch persists check_error and notifies owner exactly once across runs', async t => {
  const home = temp(t), now = Date.parse('2026-11-06T03:00:00Z'), messages = [];
  addCheck({ home, now, session: 's', check: 'node missing.mjs', label: '故障確認', deadline: '+24h' });
  const io = { sheetConfig: () => null, digest: async () => ({}),
    executeCheck: row => executeCheck(row, { spawnImpl: () => ({ status: 1, stderr: crash }) }),
    notifyOwner: async (_, message) => { messages.push(message); return { delivered: 'inbox' }; },
    resume: () => assert.fail('must not resume'), askLlm: () => assert.fail('must not infer') };
  await watch({ home, now, io }); await watch({ home, now: now + 60000, io });
  const row = readLedger(ledgerFile(home))[0];
  assert.equal(row.checkResult, 'error'); assert.equal(row.verdict, 'check_error');
  assert.equal(row.checkNotifiedResult, 'error'); assert.equal(messages.length, 1);
  assert.match(messages[0], /確認処理エラー: 故障確認 node:internal/);
});
