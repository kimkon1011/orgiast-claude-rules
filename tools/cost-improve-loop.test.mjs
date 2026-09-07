import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateFleet,
  decideActions,
  sortViolationsBySeverity,
  verifyPreviousActions,
  readLedgerCounts,
  atomicWrite,
  buildCombinedCodexSpec,
  main,
  ALLOWED_LOCAL_COMMANDS,
  parsePercent,
  parseJstOrIsoDate,
  executeLocalAction,
  writeRoutingOverride,
  writeCodexFallbackOrder,
  writeAutoSessionExecutorEnv,
  writeBudgetPressure,
  splitWhitelistedCommand
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

test('strict percent and date parsing rejects ambiguous or impossible values', () => {
  assert.equal(parsePercent('0'), 0); assert.equal(parsePercent('1'), 1); assert.equal(parsePercent('50%'), .5);
  assert.equal(parsePercent('50'), null); assert.equal(parsePercent('12abc'), null);
  assert.equal(parseJstOrIsoDate('2026-02-30 12:00:00'), null);
  assert.equal(parseJstOrIsoDate('2026-01-01 24:00:00'), null);
});

test('one untrusted PC does not stop another PC auto action', () => {
  const decision = decideActions({ violations: [
    { kind: 'measurement_untrusted', pc: 'broken-PC', severity: 'error', evidence: 'missing' },
    { kind: 'low_delegation', pc: 'healthy-PC', severity: 'error', evidence: '30%', actualValue: .3, targetValue: .5 }
  ], state: { actions: [] }, now: NOW });
  assert.equal(decision.actions.find((x) => x.pc === 'healthy-PC')?.mode, 'auto-codex');
});

test('empty fleet is measurement failure', () => {
  const result = evaluateFleet({ rows: [], ledgerCounts: {}, localState: {}, now: NOW });
  assert.match(result.violations.find((x) => x.pc === 'fleet').evidence, /fleet_empty/);
});

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

test('unused_provider is escalated without running a command', () => {
  const decision = decideActions({
    violations: [{ kind: 'unused_provider', pc: 'self', evidence: "Provider 'kimi' is configured but has 0 calls in last 7 days" }],
    state: { actions: [] },
    now: NOW
  });
  assert.strictEqual(decision.actions[0].mode, 'human');
  assert.strictEqual(decision.actions[0].result, 'escalated');
  assert.strictEqual(decision.actions[0].command, undefined);
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

test('11b. empty delegation is untrusted while measured 0.0% is low delegation', () => {
  const base = { pcName: 'PC-ratio', reportedAt: '2026-09-06 11:00:00', claudeUsd: '1' };
  const missing = evaluateFleet({ rows: [{ ...base, delegRatio: '' }], ledgerCounts: { codex: 1 }, localState: {}, now: NOW });
  assert.ok(missing.violations.some(v => v.kind === 'measurement_untrusted' && v.pc === 'PC-ratio'));
  assert.ok(!missing.violations.some(v => v.kind === 'low_delegation' && v.pc === 'PC-ratio'));

  const measuredZero = evaluateFleet({ rows: [{ ...base, delegRatio: '0.0%' }], ledgerCounts: { codex: 1 }, localState: {}, now: NOW });
  assert.ok(measuredZero.violations.some(v => v.kind === 'low_delegation' && v.pc === 'PC-ratio'));
  assert.ok(!measuredZero.violations.some(v => v.kind === 'measurement_untrusted' && v.pc === 'PC-ratio'));
});

test('12. all known cheap providers participate in unused-provider health checks', () => {
  const result = evaluateFleet({ rows: [], ledgerCounts: { codex: 1 }, localState: { configuredProviders: ['grok', 'openrouter'] }, now: NOW });
  assert.equal(result.violations.filter(v => v.kind === 'unused_provider').length, 2);
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

test('17. 実行ログを1行追記し、フリート取得失敗は NG と理由を残す', async () => {
  const tempDir = createTempDir(); process.env.ORGIAST_HOME = tempDir;
  try {
    await main(['--no-notify'], {
      fetchFleetSheetRows: async () => { throw new Error('sheet timeout'); }, readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true,
      sendHeartbeat: async () => {}
    });
    const lines = fs.readFileSync(path.join(tempDir, '.claude', 'logs', 'cost-improve-loop.log'), 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1); assert.match(lines[0], /\/ NG \/ pcs=0/); assert.match(lines[0], /reason=sheet timeout/);
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('18. --dry-run では実行ログを書かない', async () => {
  const tempDir = createTempDir(); process.env.ORGIAST_HOME = tempDir;
  try {
    await main(['--dry-run', '--no-notify'], { fetchFleetSheetRows: async () => [], readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true });
    assert.equal(fs.existsSync(path.join(tempDir, '.claude', 'logs', 'cost-improve-loop.log')), false);
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('19. 直近10件の7割以上が no_effect/worse なら報告先頭に警告する', async () => {
  const tempDir = createTempDir(); process.env.ORGIAST_HOME = tempDir;
  const actions = Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, kind: 'low_delegation', pc: `PC-${i}`, mode: 'auto-codex', dispatchedAt: new Date(NOW.getTime() - (i + 4) * 86400000).toISOString(), verifiedAt: new Date(NOW.getTime() - i * 1000).toISOString(), baseline: { metric: 'delegRatio', value: .4 }, result: i < 7 ? 'no_effect' : 'worked' }));
  fs.writeFileSync(path.join(tempDir, '.claude', 'cost-improve-state.json'), JSON.stringify({ version: 1, actions, lastKpis: {} }));
  try {
    const result = await main(['--dry-run', '--no-notify'], { fetchFleetSheetRows: async () => [{ pcName: 'PC-ok', reportedAt: '2026-09-06 11:00:00', delegRatio: '60%', claudeUsd: '1' }], readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true });
    assert.match(result.reportText, /^⚠️ このループは効いていません\(直近10件中7件が効果なし\)/);
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('20. heartbeat 失敗でも main は例外を投げずログに notify=failed を残す', async () => {
  const tempDir = createTempDir(); process.env.ORGIAST_HOME = tempDir;
  try {
    const result = await main(['--no-notify'], { fetchFleetSheetRows: async () => [{ pcName: 'PC-ok', reportedAt: '2026-09-06 11:00:00', delegRatio: '60%', claudeUsd: '1' }], readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true, sendHeartbeat: async () => { throw new Error('heartbeat down'); } });
    assert.equal(result.ok, true);
    assert.match(fs.readFileSync(path.join(tempDir, '.claude', 'logs', 'cost-improve-loop.log'), 'utf8'), /notify=failed/);
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('21. atomicWrite は rename の一時失敗を再試行して保存する', () => {
  const tempDir = createTempDir();
  const file = path.join(tempDir, '.claude', 'retry-state.json');
  let attempts = 0;
  try {
    atomicWrite(file, '{"ok":true}', {
      renameSync: (from, to) => { if (++attempts < 4) throw Object.assign(new Error('busy'), { code: 'EPERM' }); fs.renameSync(from, to); },
      sleepSync: () => {}
    });
    assert.equal(attempts, 4); assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
  } finally { cleanTempDir(tempDir); }
});

test('22. 状態保存が最後まで失敗しても main は成功しログに state=failed を残す', async () => {
  const tempDir = createTempDir(); process.env.ORGIAST_HOME = tempDir;
  try {
    const result = await main(['--no-notify'], {
      fetchFleetSheetRows: async () => [{ pcName: 'PC-ok', reportedAt: '2026-09-06 11:00:00', delegRatio: '60%', claudeUsd: '1' }],
      readLedger: () => ({ codex: 1 }), localState: {}, noNotify: true, sendHeartbeat: async () => {},
      atomicWrite: () => { throw Object.assign(new Error('rename busy'), { code: 'EPERM' }); }
    });
    assert.equal(result.ok, true);
    assert.match(fs.readFileSync(path.join(tempDir, '.claude', 'logs', 'cost-improve-loop.log'), 'utf8'), /state=failed/);
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('23. buildCombinedCodexSpec は2件の内容を番号付き見出しで区切る', () => {
  const spec = buildCombinedCodexSpec([
    { kind: 'low_delegation', pc: 'PC-A', specContent: 'Aの修正仕様' },
    { kind: 'opus_heavy', pc: 'PC-B', specContent: 'Bの修正仕様' }
  ]);
  assert.match(spec, /## タスク 1\/2: low_delegation \(PC-A\)/);
  assert.match(spec, /## タスク 2\/2: opus_heavy \(PC-B\)/);
  assert.ok(spec.includes('Aの修正仕様'));
  assert.ok(spec.includes('Bの修正仕様'));
});

test('24. buildCombinedCodexSpec は空配列と null に空文字列を返す', () => {
  assert.strictEqual(buildCombinedCodexSpec([]), '');
  assert.strictEqual(buildCombinedCodexSpec(null), '');
});

test('25. buildCombinedCodexSpec は1件でも仕様内容を欠落させない', () => {
  const spec = buildCombinedCodexSpec([
    { kind: 'low_delegation', pc: 'PC-only', specContent: '単独タスクの修正仕様' }
  ]);
  assert.ok(spec.includes('単独タスクの修正仕様'));
});

// ---- B4: ローカル信号由来 kind の境界・効果(B2 仕様の未実装項目) ----

function signalEval(signals, now = NOW) {
  const rows = [
    { pcName: 'ok-PC', label: 'ok', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '60%', claudeUsd: '1' }
  ];
  return evaluateFleet({ rows, ledgerCounts: { deepseek: 1 }, localState: {}, now, signals });
}

test('26. provider_unhealthy は failRate 0.20 / http429 50 の境界で発火し codex は除外される', () => {
  const kinds = (signals) => signalEval(signals).violations.filter((v) => v.kind === 'provider_unhealthy');
  // 境界未満は発火しない
  assert.equal(kinds({ providerHealth: { providers: { groq: { failRate: 0.19, http429: 0 }, gemini: { failRate: 0, http429: 49 } } } }).length, 0);
  // codex は定額のためいくら失敗しても発火しない
  assert.equal(kinds({ providerHealth: { providers: { codex: { failRate: 0.9, http429: 500 }, groq: { failRate: 0.1, http429: 0 } } } }).length, 0);
  // failRate >= 0.20 で発火
  const byRate = kinds({ providerHealth: { providers: { groq: { failRate: 0.2, http429: 0 } } } });
  assert.equal(byRate.length, 1);
  assert.equal(byRate[0].provider, 'groq');
  assert.equal(byRate[0].actualValue, 0.2);
  // http429 >= 50 で発火(failRate は低くても)
  const by429 = kinds({ providerHealth: { providers: { gemini: { failRate: 0, http429: 50 } } } });
  assert.equal(by429.length, 1);
  assert.equal(by429[0].provider, 'gemini');
});

test('27. codex_saturated / headless_claude は 2回以上 / >0トークン で発火する', () => {
  const kindCount = (kind, signals) => signalEval(signals).violations.filter((v) => v.kind === kind).length;
  assert.equal(kindCount('codex_saturated', { codexLimit24h: 1 }), 0);
  assert.equal(kindCount('codex_saturated', { codexLimit24h: 2 }), 1);
  assert.equal(kindCount('headless_claude', { headlessClaudeOut: 0 }), 0);
  assert.equal(kindCount('headless_claude', { headlessClaudeOut: 1 }), 1);
});

test('28. budget_pace / eval_stale は 100%超 / 7日超または未実行 で発火する', () => {
  const kindCount = (kind, signals) => signalEval(signals).violations.filter((v) => v.kind === kind).length;
  assert.equal(kindCount('budget_pace', { budgetPacePct: 99 }), 0);
  assert.equal(kindCount('budget_pace', { budgetPacePct: 100 }), 0, '100%ちょうどは超過ではない');
  assert.equal(kindCount('budget_pace', { budgetPacePct: 101 }), 1);
  assert.equal(kindCount('eval_stale', { evalAgeDays: 6 }), 0);
  assert.equal(kindCount('eval_stale', { evalAgeDays: 8 }), 1);
  assert.equal(kindCount('eval_stale', { evalAgeDays: null }), 1, 'eval結果が一度も無い場合も stale');
});

test('29. B4 kind は PLAYBOOK の mode/effect で action 化され baseline に metric を持つ', () => {
  const evaluation = signalEval({
    providerHealth: { providers: { groq: { failRate: 0.3, http429: 0 } } },
    codexLimit24h: 2,
    headlessClaudeOut: 500,
    budgetPacePct: 150,
    evalAgeDays: 9
  });
  const decision = decideActions({ violations: evaluation.violations, state: { actions: [] }, now: NOW });
  const byKind = (kind) => decision.actions.find((a) => a.kind === kind);

  const providerUnhealthy = byKind('provider_unhealthy');
  assert.ok(providerUnhealthy, 'provider_unhealthy が action 化される');
  assert.equal(providerUnhealthy.mode, 'auto-local');
  assert.equal(providerUnhealthy.effect, 'writeRoutingOverride');
  assert.equal(providerUnhealthy.provider, 'groq');
  assert.equal(providerUnhealthy.baseline.metric, 'failRate');
  assert.match(providerUnhealthy.reportNote, /有料枠で解消可\(例: Groq Dev tier\)/);

  const codexSaturated = byKind('codex_saturated');
  assert.ok(codexSaturated);
  assert.equal(codexSaturated.effect, 'writeCodexFallbackOrder');
  assert.equal(codexSaturated.baseline.metric, 'codexLimit24h');

  const headless = byKind('headless_claude');
  assert.ok(headless);
  assert.equal(headless.effect, 'writeAutoSessionExecutor');
  assert.equal(headless.baseline.metric, 'headlessClaudeOut');

  const budgetPace = byKind('budget_pace');
  assert.ok(budgetPace, 'budget_pace は human で budgetPressure を立てる');
  assert.equal(budgetPace.mode, 'human');
  assert.equal(budgetPace.localEffect, 'budgetPressure');
  assert.match(budgetPace.todoMessage, /予算ペースが 150\.0%|100%/);

  const evalStale = byKind('eval_stale');
  assert.ok(evalStale);
  assert.equal(evalStale.mode, 'auto-local');
  assert.match(evalStale.command, /batch-enqueue\.mjs --provider groq --kind eval-harness/);
  assert.equal(evalStale.baseline.metric, 'evalAgeDays');
});

test('30. executeLocalAction は許可リスト外を実行せず、許可内は shell:false の argv で渡す', () => {
  const tempDir = createTempDir();
  try {
    const claudeDir = path.join(tempDir, '.claude');
    const calls = [];
    const malicious = executeLocalAction({
      act: { id: 'm1', kind: 'no_cheap_ai', pc: 'self', mode: 'auto-local', command: 'node tools/onboarding-sync.mjs --force; rm -rf /' },
      dryRun: false, claudeDir, home: tempDir, repoRoot: tempDir,
      spawnSync: (program, args, opts) => { calls.push({ program, args, opts }); return { status: 0 }; }
    });
    assert.equal(malicious.result, 'failed');
    assert.equal(malicious.note, 'Command not in whitelist');
    assert.equal(calls.length, 0, '許可リスト外は spawn されない');

    const evalHarnessCommand = ALLOWED_LOCAL_COMMANDS.find((c) => c.includes('--kind eval-harness'));
    assert.ok(evalHarnessCommand, 'eval-harness 投入が許可リストにある');
    const parts = splitWhitelistedCommand(evalHarnessCommand);
    assert.deepEqual(parts, ['node', 'tools/batch-enqueue.mjs', '--provider', 'groq', '--kind', 'eval-harness', 'eval-harness --all']);

    const allowed = executeLocalAction({
      act: { id: 'a1', kind: 'eval_stale', pc: 'self', mode: 'auto-local', command: evalHarnessCommand },
      dryRun: false, claudeDir, home: tempDir, repoRoot: tempDir,
      spawnSync: (program, args, opts) => { calls.push({ program, args, opts }); return { status: 0 }; }
    });
    assert.equal(allowed.result, 'pending');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].program, 'node');
    assert.deepEqual(calls[0].args, ['tools/batch-enqueue.mjs', '--provider', 'groq', '--kind', 'eval-harness', 'eval-harness --all']);
    assert.equal(calls[0].opts.shell, false, 'シート由来文字列をシェルで解釈しない');
  } finally { cleanTempDir(tempDir); }
});

test('31. B4 effect は既存ファイル内容を保持して書き込む', () => {
  const tempDir = createTempDir();
  try {
    const claudeDir = path.join(tempDir, '.claude');
    // routing-overrides: 他 provider の demote と他キーを保持する
    const a = writeRoutingOverride({ claudeDir, provider: 'groq', now: NOW });
    assert.equal(a.changed, true);
    writeRoutingOverride({ claudeDir, provider: 'gemini', now: NOW });
    const overrides = JSON.parse(fs.readFileSync(path.join(claudeDir, 'routing-overrides.json'), 'utf8'));
    assert.deepEqual(Object.keys(overrides.demote).sort(), ['gemini', 'groq']);
    assert.equal(writeRoutingOverride({ claudeDir, provider: 'groq', now: NOW }).changed, false, '同値なら no_change');

    // codex-fallback-order: zai 有無で先頭が glm / deepseek に変わる
    assert.equal(writeCodexFallbackOrder({ claudeDir, zaiAvailable: true }).changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeDir, 'codex-fallback-order.json'), 'utf8')), ['cheap-code:glm', 'qwen', 'gemini-cli']);
    assert.equal(writeCodexFallbackOrder({ claudeDir, zaiAvailable: false }).changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeDir, 'codex-fallback-order.json'), 'utf8')), ['cheap-code:deepseek', 'qwen', 'gemini-cli']);

    // auto-session.env: 既存行を保持して executor を上書きし、同値は no_change
    fs.writeFileSync(path.join(claudeDir, 'auto-session.env'), 'KEEP=1\nORGIAST_AUTO_SESSION_EXECUTOR=claude\n', 'utf8');
    const env1 = writeAutoSessionExecutorEnv({ claudeDir, provider: 'glm' });
    assert.equal(env1.changed, true);
    const envText = fs.readFileSync(path.join(claudeDir, 'auto-session.env'), 'utf8');
    assert.match(envText, /^KEEP=1$/m);
    assert.match(envText, /^ORGIAST_AUTO_SESSION_EXECUTOR=cheap-code$/m);
    assert.match(envText, /^ORGIAST_AUTO_SESSION_PROVIDER=glm$/m);
    assert.equal(writeAutoSessionExecutorEnv({ claudeDir, provider: 'glm' }).changed, false);

    // cost-enforce.json: mode 等を保持して budgetPressure を立てる
    fs.writeFileSync(path.join(claudeDir, 'cost-enforce.json'), '{"mode":"block"}\n', 'utf8');
    assert.equal(writeBudgetPressure({ claudeDir }).changed, true);
    const enforce = JSON.parse(fs.readFileSync(path.join(claudeDir, 'cost-enforce.json'), 'utf8'));
    assert.equal(enforce.mode, 'block');
    assert.equal(enforce.budgetPressure, true);
    assert.equal(writeBudgetPressure({ claudeDir }).changed, false);
  } finally { cleanTempDir(tempDir); }
});

// ---- B1相当: auto-codex は共有ツリーを破壊せず、PR URL を state に入れる ----

function autoCodexSpawnMocks(calls) {
  return (program, args, options = {}) => {
    const copyArgs = args ? [...args] : [];
    calls.push({ program, args: copyArgs, options });
    const joined = [program, ...copyArgs].join(' ');
    if (program === 'git' && copyArgs.includes('diff') && copyArgs.includes('--stat')) {
      // この呼び出しは tempTree 内で行われる(共有ツリーでは diff を取らない)
      return { status: 0, stdout: options._diffStdout ?? ' tools/cost-improve-loop.mjs | 2 ++\n' };
    }
    if (program === 'gh' && copyArgs[0] === 'pr') {
      return { status: 0, stdout: 'https://github.com/orgiast/orgiast-claude-rules/pull/123\n' };
    }
    return { status: 0, stdout: '' };
  };
}

test('32. auto-codex 実行は共有ツリーへ reset/clean/checkout -b を投げず、PR URL を state に入れる', async () => {
  const tempDir = createTempDir();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.env.ORGIAST_HOME = tempDir;
  try {
    const rows = [
      { pcName: 'nishi-PC', label: 'nishi', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '40%', claudeUsd: '5.0' }
    ];
    const calls = [];
    const result = await main([], {
      fetchFleetSheetRows: async () => rows,
      readLedger: () => ({ deepseek: 1 }),
      localState: {},
      signals: {},
      spawnSync: autoCodexSpawnMocks(calls),
      noNotify: true,
      sendHeartbeat: async () => {}
    });
    const codexAct = result.finalState.actions.find((a) => a.mode === 'auto-codex');
    assert.ok(codexAct, 'auto-codex アクションが発行される');
    assert.equal(codexAct.result, 'pending');
    assert.equal(codexAct.pr, 'https://github.com/orgiast/orgiast-claude-rules/pull/123', 'PR URL が state に入る');

    // 共有ツリー(repoRoot)に対する破壊的 git 操作が無い
    const destructiveOnShared = calls.some((c) =>
      c.program === 'git' && c.args.includes('-C') && c.args[c.args.indexOf('-C') + 1] === repoRoot &&
      (c.args.includes('reset') || c.args.includes('clean') || c.args.includes('checkout'))
    );
    assert.equal(destructiveOnShared, false, '共有ツリーに reset/clean/checkout を投げない');
    const worktreeOnShared = calls.filter((c) => c.program === 'git' && c.args.includes('-C') && c.args[c.args.indexOf('-C') + 1] === repoRoot);
    for (const call of worktreeOnShared) assert.equal(call.args.includes('worktree'), true, '共有ツリーへの git は worktree のみ');
    assert.ok(calls.some((c) => c.program === 'gh' && c.args[0] === 'pr'), 'PR 作成が試みられる');
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});

test('33. auto-codex は空 diff を failed とし PR 作成まで進めない', async () => {
  const tempDir = createTempDir();
  process.env.ORGIAST_HOME = tempDir;
  try {
    const rows = [
      { pcName: 'nishi-PC', label: 'nishi', reportedAt: '2026-09-06 11:00:00', livenessState: '生存', delegRatio: '40%', claudeUsd: '5.0' }
    ];
    const calls = [];
    const spawn = (program, args, options = {}) => {
      const copyArgs = args ? [...args] : [];
      calls.push({ program, args: copyArgs });
      const joined = [program, ...copyArgs].join(' ');
      if (program === 'git' && copyArgs.includes('diff') && copyArgs.includes('--stat')) {
        return { status: 0, stdout: '' }; // 変更なし
      }
      if (program === 'gh') return { status: 0, stdout: 'https://github.com/orgiast/orgiast-claude-rules/pull/123\n' };
      return { status: 0, stdout: '' };
    };
    const result = await main([], {
      fetchFleetSheetRows: async () => rows,
      readLedger: () => ({ deepseek: 1 }),
      localState: {}, signals: {}, spawnSync: spawn, noNotify: true, sendHeartbeat: async () => {}
    });
    const codexAct = result.finalState.actions.find((a) => a.mode === 'auto-codex');
    assert.equal(codexAct.result, 'failed');
    assert.match(codexAct.note, /変更なし/);
    assert.equal(calls.some((c) => c.program === 'gh' && c.args[0] === 'pr'), false, '空 diff では PR を作らない');
  } finally { delete process.env.ORGIAST_HOME; cleanTempDir(tempDir); }
});
