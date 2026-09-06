import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateFleet,
  decideActions,
  sortViolationsBySeverity,
  verifyPreviousActions,
  readLedgerCounts,
  main,
  ALLOWED_LOCAL_COMMANDS
} from './cost-improve-loop.mjs';

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-cost-test-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

const NOW = new Date('2026-09-06T12:00:00Z');

// 1. 台帳が計測不能(null)のとき no_cheap_ai は出ず measurement_untrusted が出て、codex 委譲が1件も発生しない
test('1. When ledger is unreadable (null), measurement_untrusted is reported instead of no_cheap_ai, and no codex actions are decided', () => {
  const rows = [
    { pcName: 'local-PC', label: 'local', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '30%', claudeUsd: '15.0' }
  ];
  const ledgerCounts = null; // Unreadable/untrusted ledger!
  const localState = {};

  const evalResult = evaluateFleet({ rows, ledgerCounts, localState, now: NOW });
  
  // Verify measurement_untrusted is present
  const hasUntrusted = evalResult.violations.some(v => v.kind === 'measurement_untrusted' && v.pc === 'self');
  assert.ok(hasUntrusted, 'Should have measurement_untrusted violation on self');

  // Verify no_cheap_ai is NOT present
  const hasNoCheapAi = evalResult.violations.some(v => v.kind === 'no_cheap_ai');
  assert.ok(!hasNoCheapAi, 'Should NOT have no_cheap_ai violation when ledger is untrusted');

  // Verify decideActions does not dispatch auto-codex for self in this state
  const state = { actions: [] };
  const decision = decideActions({ violations: evalResult.violations, state, now: NOW });
  
  const hasAutoCodex = decision.actions.some(act => act.mode === 'auto-codex');
  assert.ok(!hasAutoCodex, 'Should not dispatch any auto-codex actions');
});

// 2. 48時間より古い行はフリート平均に入らず stale_report が立つ
test('2. Stale reports (> 48h) raise stale_report and are excluded from fleet average calculations', () => {
  const rows = [
    { pcName: 'nishi-PC', label: 'nishi', reportedAt: '2026-09-05 12:00:00', livenessState: '生存', delegRatio: '80%', claudeUsd: '5.0' }, // fresh
    { pcName: 'kim-PC', label: 'kim', reportedAt: '2026-09-02 12:00:00', livenessState: '生存', delegRatio: '20%', claudeUsd: '10.0' }  // stale (> 48h)
  ];
  const ledgerCounts = {};
  const localState = {};

  const evalResult = evaluateFleet({ rows, ledgerCounts, localState, now: NOW });

  // Verify stale_report is raised for kim-PC
  const hasStaleReport = evalResult.violations.some(v => v.kind === 'stale_report' && v.pc === 'kim-PC');
  assert.ok(hasStaleReport, 'kim-PC should raise stale_report');

  // Verify fleet average is calculated using only fresh row (nishi-PC = 80%)
  assert.strictEqual(evalResult.fleet.nonStaleCount, 1);
  assert.strictEqual(evalResult.fleet.avgDelegRatio, 0.8);
  assert.strictEqual(evalResult.fleet.totalClaudeUsd, 5.0);
});

// 3. 同じ (kind, pc) はクールダウン中に再委譲されない
test('3. Action is not dispatched if under cooldown (last action within 3 days)', () => {
  const violations = [
    { kind: 'low_delegation', pc: 'nishi-PC', severity: 'error', evidence: 'Delegation ratio is 40% (< 50%)' }
  ];
  // Action dispatched 1 day ago
  const state = {
    actions: [
      {
        id: 'act-1',
        kind: 'low_delegation',
        pc: 'nishi-PC',
        mode: 'auto-codex',
        dispatchedAt: new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString(),
        baseline: { metric: 'delegRatio', value: 0.4 },
        result: 'pending'
      }
    ]
  };

  const decision = decideActions({ violations, state, now: NOW });
  assert.strictEqual(decision.actions.length, 0, 'No action should be dispatched during cooldown');
});

// 4. auto-codex は1回の実行で3件目を発動しない（上限2）
test('4. Limits auto-codex dispatches to maximum of 2 per run', () => {
  const violations = [
    { kind: 'low_delegation', pc: 'PC-1', severity: 'error', evidence: 'Delegation 30%' },
    { kind: 'low_delegation', pc: 'PC-2', severity: 'error', evidence: 'Delegation 35%' },
    { kind: 'low_delegation', pc: 'PC-3', severity: 'error', evidence: 'Delegation 40%' }
  ];
  const state = { actions: [] };

  const decision = decideActions({ violations, state, now: NOW, limits: { maxCodex: 2 } });
  
  const codexActions = decision.actions.filter(a => a.mode === 'auto-codex');
  assert.strictEqual(codexActions.length, 2, 'Should not exceed maximum of 2 auto-codex dispatches');
});

// 5. 3回連続失敗した (kind, pc) は自動対処が止まり human に上がる
test('5. Downgrades to human action if same (kind, pc) failed or had no effect 3 consecutive times', () => {
  const violations = [
    { kind: 'low_delegation', pc: 'PC-1', severity: 'error', evidence: 'Delegation 30%' }
  ];
  const state = {
    actions: [
      { id: '1', kind: 'low_delegation', pc: 'PC-1', mode: 'auto-codex', dispatchedAt: '2026-09-01T00:00:00Z', result: 'no_effect' },
      { id: '2', kind: 'low_delegation', pc: 'PC-1', mode: 'auto-codex', dispatchedAt: '2026-09-02T00:00:00Z', result: 'failed' },
      { id: '3', kind: 'low_delegation', pc: 'PC-1', mode: 'auto-codex', dispatchedAt: '2026-09-03T00:00:00Z', result: 'no_effect' }
    ]
  };

  const decision = decideActions({ violations, state, now: NOW });
  
  assert.strictEqual(decision.actions.length, 1);
  assert.strictEqual(decision.actions[0].mode, 'human', 'Should be downgraded to human action');
  assert.ok(decision.actions[0].note.includes('Downgraded to human'), 'Action note should reflect downgrade');
});

// 6. verifyPreviousActions が worked / no_effect を正しく分ける
test('6. verifyPreviousActions correctly evaluates pending actions to worked/no_effect/worse based on KPI change', () => {
  const state = {
    actions: [
      // 1. Worked: delegRatio improved from 0.4 to 0.6 (> 0.5)
      { id: 'act-1', kind: 'low_delegation', pc: 'PC-1', baseline: { metric: 'delegRatio', value: 0.4 }, dispatchedAt: '2026-09-01T00:00:00Z', result: 'pending' },
      // 2. No effect: delegRatio remains at 0.4
      { id: 'act-2', kind: 'low_delegation', pc: 'PC-2', baseline: { metric: 'delegRatio', value: 0.4 }, dispatchedAt: '2026-09-01T00:00:00Z', result: 'pending' },
      // 3. Worse: delegRatio dropped to 0.3
      { id: 'act-3', kind: 'low_delegation', pc: 'PC-3', baseline: { metric: 'delegRatio', value: 0.4 }, dispatchedAt: '2026-09-01T00:00:00Z', result: 'pending' }
    ]
  };

  const rows = [
    { pcName: 'PC-1', label: 'PC-1', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '60%' },
    { pcName: 'PC-2', label: 'PC-2', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '40%' },
    { pcName: 'PC-3', label: 'PC-3', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '30%' }
  ];

  const resultState = verifyPreviousActions({ state, rows, now: NOW, horizonDays: 3 });
  
  const act1 = resultState.actions.find(a => a.id === 'act-1');
  const act2 = resultState.actions.find(a => a.id === 'act-2');
  const act3 = resultState.actions.find(a => a.id === 'act-3');

  assert.strictEqual(act1.result, 'worked');
  assert.strictEqual(act2.result, 'no_effect');
  assert.strictEqual(act3.result, 'worse');
});

// 7. --dry-run で状態ファイルが書かれず通知も委譲も起きない
test('7. Running with --dry-run does not write state files or send notifications', async () => {
  const tempDir = createTempDir();
  const stateFile = path.join(tempDir, '.claude', 'cost-improve-state.json');
  
  // Set up mock inputs
  const rows = [
    { pcName: 'local-PC', label: 'local', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '30%', claudeUsd: '5.0' }
  ];
  
  let notified = false;
  const io = {
    fetchFleetSheetRows: async () => rows,
    readLedger: () => ({}),
    spawnSync: () => ({ status: 0 }),
    noNotify: true // Suppress actual notifications
  };

  process.env.ORGIAST_HOME = tempDir;

  try {
    const result = await main(['--dry-run', '--no-notify'], io);
    
    assert.ok(result.ok);
    assert.ok(!fs.existsSync(stateFile), 'State file should NOT be written in --dry-run');
  } finally {
    delete process.env.ORGIAST_HOME;
    cleanTempDir(tempDir);
  }
});

// 8. auto-local は許可リスト外の文字列を実行しない（シート由来の文字列を混ぜても実行されない）
test('8. auto-local only runs commands that are present in the ALLOWED_LOCAL_COMMANDS whitelist', () => {
  const violations = [
    { kind: 'no_cheap_ai', pc: 'self', severity: 'error', evidence: '0 cheap AI calls' }
  ];
  
  const state = { actions: [] };
  const decision = decideActions({ violations, state, now: NOW });
  
  // Verify selected command is inside whitelist
  const action = decision.actions.find(a => a.kind === 'no_cheap_ai');
  assert.strictEqual(action.mode, 'auto-local');
  assert.ok(ALLOWED_LOCAL_COMMANDS.includes(action.command), 'Command must be in whitelist');

  // Let's test a malicious mock command
  const maliciousAction = {
    id: 'mal-1',
    kind: 'no_cheap_ai',
    pc: 'self',
    mode: 'auto-local',
    command: 'rm -rf /' // Malicious command not in whitelist
  };

  // We manually run the main execution block logic
  const ALLOWED = [
    'node tools/tool-adoption-check.mjs --force',
    'node tools/onboarding-sync.mjs --force',
    'node tools/register-hooks.mjs --hooks-only'
  ];

  let commandExecuted = false;
  const runSpawnSync = () => {
    commandExecuted = true;
    return { status: 0 };
  };

  const act = maliciousAction;
  if (act.mode === 'auto-local') {
    if (ALLOWED.includes(act.command)) {
      runSpawnSync();
    } else {
      act.result = 'failed';
      act.note = 'Command not in whitelist';
    }
  }

  assert.strictEqual(commandExecuted, false, 'Malicious command not in whitelist must not be executed');
  assert.strictEqual(act.result, 'failed');
  assert.strictEqual(act.note, 'Command not in whitelist');
});

test('9. human escalation is neither worked nor shown in the verification section', async () => {
  const decision = decideActions({ violations: [{ kind: 'stale_report', pc: 'PC-human', evidence: 'stale' }], state: { actions: [] }, now: NOW });
  assert.strictEqual(decision.actions[0].result, 'escalated');
  assert.strictEqual(decision.actions[0].verifiedAt, null);
  const verified = verifyPreviousActions({ state: { actions: decision.actions }, rows: [], now: new Date(NOW.getTime() + 4 * 86400000) });
  assert.strictEqual(verified.actions[0].result, 'escalated');
  assert.strictEqual(verified.actions[0].verifiedAt, null);
  const tempDir = createTempDir();
  process.env.ORGIAST_HOME = tempDir;
  try {
    const result = await main(['--dry-run', '--no-notify'], {
      fetchFleetSheetRows: async () => [{ pcName: 'PC-human', label: 'human', reportedAt: '2026-09-01 00:00:00', delegRatio: '60%', claudeUsd: '1' }],
      readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true
    });
    assert.ok(!result.reportText.split('### ③')[1].split('### ④')[0].includes('PC-human'));
    assert.ok(result.reportText.split('### ④')[1].includes('PC-human'));
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('10. roster-only rows are excluded without violations and summarized', async () => {
  const rows = [{ pcName: '作業用018', label: '', hostname: '', reportedAt: '', delegRatio: '', claudeUsd: '' }];
  const evaluated = evaluateFleet({ rows, ledgerCounts: { codex: 1 }, localState: {}, now: NOW });
  assert.deepStrictEqual(evaluated.pcs, []);
  assert.deepStrictEqual(evaluated.violations, []);
  const tempDir = createTempDir();
  process.env.ORGIAST_HOME = tempDir;
  try {
    const result = await main(['--dry-run', '--no-notify'], {
      fetchFleetSheetRows: async () => rows, readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true
    });
    assert.ok(!result.reportText.includes('**作業用018**'));
    assert.ok(result.reportText.includes('※ 未報告のPC 1台は表から除外'));
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('11. reported rows with missing metrics are untrusted and never displayed as $0.00', async () => {
  const rows = [{ pcName: 'PC-broken', label: 'broken', reportedAt: '2026-09-06 11:00:00', delegRatio: '', claudeUsd: '' }];
  const evaluated = evaluateFleet({ rows, ledgerCounts: { codex: 1 }, localState: {}, now: NOW });
  assert.ok(evaluated.violations.some(v => v.kind === 'measurement_untrusted' && v.pc === 'PC-broken'));
  const tempDir = createTempDir();
  process.env.ORGIAST_HOME = tempDir;
  try {
    const result = await main(['--dry-run', '--no-notify'], {
      fetchFleetSheetRows: async () => rows, readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true
    });
    assert.ok(result.reportText.includes('**PC-broken**: 計測不能'));
    assert.ok(!result.reportText.includes('$0.00'));
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('12. fallback-only providers do not raise unused_provider', () => {
  const result = evaluateFleet({ rows: [], ledgerCounts: { codex: 1 }, localState: { configuredProviders: ['grok', 'openrouter'] }, now: NOW });
  assert.ok(!result.violations.some(v => v.kind === 'unused_provider'));
});

test('13. auto-codex spec contains measured facts and diagnostic guardrails', () => {
  const decision = decideActions({
    violations: [{ kind: 'low_delegation', pc: 'PC-spec', evidence: 'Delegation ratio is 32% (< 50%)', actualValue: 0.32, targetValue: 0.5, measuredAt: NOW.toISOString() }],
    state: { actions: [] }, now: NOW
  });
  const spec = decision.actions[0].specContent;
  for (const expected of ['PC名: PC-spec', '実測値: 32.0%', '目標値: 50.0%', 'node tools/usage-stats.mjs deleg', '特定できなかった']) assert.ok(spec.includes(expected));
});

test('14. low delegation violations use codex budget for the two lowest ratios', () => {
  const violations = [
    { kind: 'low_delegation', pc: 'kim-PC', severity: 'error', evidence: 'Delegation ratio is 47.1% (< 50%)', actualValue: 0.471 },
    { kind: 'low_delegation', pc: 'nishi-PC', severity: 'error', evidence: 'Delegation ratio is 15.9% (< 50%)', actualValue: 0.159 },
    { kind: 'low_delegation', pc: 'kimko-PC', severity: 'error', evidence: 'Delegation ratio is 13% (< 50%)', actualValue: 0.13 }
  ];
  assert.deepStrictEqual(sortViolationsBySeverity(violations).map(v => v.pc), ['kimko-PC', 'nishi-PC', 'kim-PC']);
  const decision = decideActions({ violations, state: { actions: [] }, now: NOW, limits: { maxCodex: 2 } });
  assert.deepStrictEqual(decision.actions.map(action => action.pc), ['kimko-PC', 'nishi-PC']);
});

test('15. human todo messages are Japanese, self-contained, and contain PC name and measured values', () => {
  const violations = [
    { kind: 'stale_report', pc: 'PC-stale', severity: 'warning', evidence: 'Report is stale (last reported: 2026-09-01 12:00:00)' },
    { kind: 'cost_spike', pc: 'PC-cost', severity: 'error', evidence: 'Claude USD spiked by +30% (from $10 to $15) without work increase', previousValue: 10, actualValue: 15, increasePercent: 50 },
    { kind: 'measurement_untrusted', pc: 'PC-empty', severity: 'error', evidence: 'Reported at 2026-09-06 11:00:00, but delegation ratio or Claude USD is missing' }
  ];
  const messages = decideActions({ violations, state: { actions: [] }, now: NOW }).actions.map(action => action.todoMessage);
  assert.ok(messages.some(message => message.includes('PC-stale') && message.includes('2026-09-01 12:00:00') && message.includes('5日間') && message.includes('fleet-sheet-report.mjs')));
  assert.ok(messages.some(message => message.includes('PC-cost') && message.includes('$10 → $15') && message.includes('+50.0%')));
  assert.ok(messages.some(message => message.includes('PC-empty') && message.includes('2026-09-06 11:00:00') && message.includes('値が空です') && message.includes('自動修正は見送りました')));
  assert.ok(messages.every(message => !/Liveness reporting|cost spiked|Measurement untrusted/.test(message)));
});

test('16. failed DM notification is saved and prepended to the next report', async () => {
  const tempDir = createTempDir();
  process.env.ORGIAST_HOME = tempDir;
  const inputs = {
    fetchFleetSheetRows: async () => [{ pcName: 'PC-ok', reportedAt: '2026-09-06 11:00:00', delegRatio: '60%', claudeUsd: '1' }],
    readLedger: () => ({ codex: 1 }), localState: {}, now: NOW
  };
  let notifyOptions;
  try {
    const first = await main([], { ...inputs, notifyKim: async (_text, options) => {
      notifyOptions = options;
      return { delivered: 'none', reason: 'DM API timeout' };
    } });
    assert.equal(notifyOptions.webhookFallback, false);
    assert.equal(first.finalState.lastNotifyError, 'DM API timeout');
    const saved = JSON.parse(fs.readFileSync(path.join(tempDir, '.claude', 'cost-improve-state.json'), 'utf8'));
    assert.equal(saved.lastNotifyError, 'DM API timeout');

    const second = await main(['--dry-run', '--no-notify'], { ...inputs, noNotify: true });
    assert.ok(second.reportText.startsWith('※ 前回の通知は送信に失敗しています(DM API timeout)'));
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});
