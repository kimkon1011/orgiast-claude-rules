import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GOAL, MAX_TICKS, TERMINAL_OUTCOMES, RETRY_AFTER_CAP_MS,
  selectGoal, parseArgs, makeLedger, parseOutput, canRunWindow,
  isTransientWindowReadError, acquireLock, normalizeLandedChecks,
  normalizeLandedContract, filterWindowsForCurrentAuth,
  sweepFailureStop, tickPrompt, contractPrompt,
  interactiveClaude, commandRunner, atomic, read, json,
  readWorktreePointer, writeWorktreePointer, pointerFile, accessDenied,
} from '../../tools/quota-sweep.mjs';
import { decideSweep, resetKey, sameReset } from '../../tools/lib/quota-windows.mjs';

const now = Date.UTC(2026, 9, 21);
const minute = 60_000;
const decision = { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 60 * minute, deadline: now + 57 * minute };
const windows = [
  { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: decision.resetsAt },
  { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute },
];

const temp = t => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-e2e-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
};

// ── 1. Module export completeness ──────────────────────────────────────────────

test('all key functions and constants are exported from the module', () => {
  // Constants
  assert.equal(typeof DEFAULT_GOAL, 'string');
  assert.ok(DEFAULT_GOAL.length > 50);
  assert.equal(MAX_TICKS, 8);
  assert.ok(TERMINAL_OUTCOMES instanceof Set);
  assert.equal(TERMINAL_OUTCOMES.size, 5);
  assert.equal(RETRY_AFTER_CAP_MS, 10 * 60_000);

  // Functions — pure / synchronous utilities
  assert.equal(typeof selectGoal, 'function');
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof makeLedger, 'function');
  assert.equal(typeof parseOutput, 'function');
  assert.equal(typeof canRunWindow, 'function');
  assert.equal(typeof isTransientWindowReadError, 'function');
  assert.equal(typeof acquireLock, 'function');
  assert.equal(typeof normalizeLandedChecks, 'function');
  assert.equal(typeof normalizeLandedContract, 'function');
  assert.equal(typeof filterWindowsForCurrentAuth, 'function');
  assert.equal(typeof sweepFailureStop, 'function');
  assert.equal(typeof tickPrompt, 'function');
  assert.equal(typeof contractPrompt, 'function');
  assert.equal(typeof interactiveClaude, 'function');
  assert.equal(typeof commandRunner, 'function');
  assert.equal(typeof readWorktreePointer, 'function');
  assert.equal(typeof writeWorktreePointer, 'function');
  assert.equal(typeof pointerFile, 'function');
  assert.equal(typeof accessDenied, 'function');
  assert.equal(typeof atomic, 'function');
  assert.equal(typeof read, 'function');
  assert.equal(typeof json, 'function');

  // Submodule utilities
  assert.equal(typeof decideSweep, 'function');
  assert.equal(typeof resetKey, 'function');
  assert.equal(typeof sameReset, 'function');
});

// ── 2. parseArgs — real argument processing ───────────────────────────────────

test('parseArgs returns defaults with no args', () => {
  const o = parseArgs([]);
  assert.equal(o.provider, 'all');
  assert.equal(o.leadMinutes, 90);
  assert.equal(o.minRemainingPercent, 15);
  assert.equal(o['dry-run'], undefined);
  assert.equal(o['json'], undefined);
});

test('parseArgs parses --dry-run and --json flags', () => {
  const o = parseArgs(['--dry-run', '--json', '--home', os.tmpdir()]);
  assert.equal(o['dry-run'], true);
  assert.equal(o['json'], true);
  assert.ok(o.home);
});

test('parseArgs --provider accepts claude, codex, all', () => {
  assert.equal(parseArgs(['--provider', 'claude']).provider, 'claude');
  assert.equal(parseArgs(['--provider', 'codex']).provider, 'codex');
  assert.equal(parseArgs(['--provider', 'all']).provider, 'all');
});

test('parseArgs --resume only accepts claude or codex', () => {
  assert.equal(parseArgs(['--resume', 'claude']).resume, 'claude');
  assert.equal(parseArgs(['--resume', 'codex']).resume, 'codex');
  assert.throws(() => parseArgs(['--resume', 'gemini']), /Invalid resume provider/);
});

test('parseArgs rejects invalid provider', () => {
  assert.throws(() => parseArgs(['--provider', 'gemini']), /Invalid sweep options/);
});

test('parseArgs rejects negative lead minutes', () => {
  assert.throws(() => parseArgs(['--lead-min', '-1']), /Invalid sweep options/);
});

test('parseArgs rejects out-of-range min-remaining', () => {
  assert.throws(() => parseArgs(['--min-remaining', '101']), /Invalid sweep options/);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});

// ── 3. TERMINAL_OUTCOMES and canRunWindow integration ─────────────────────────

test('TERMINAL_OUTCOMES contains all terminal states', () => {
  for (const outcome of ['exhausted', 'final', 'ceiling', 'deadline', 'no-goal']) {
    assert.ok(TERMINAL_OUTCOMES.has(outcome), `${outcome} should be terminal`);
  }
  // Non-terminal outcomes are NOT in the set
  assert.equal(TERMINAL_OUTCOMES.has('failed'), false);
  assert.equal(TERMINAL_OUTCOMES.has('running'), false);
  assert.equal(TERMINAL_OUTCOMES.has('partial'), false);
  assert.equal(TERMINAL_OUTCOMES.has('deferred'), false);
});

test('canRunWindow with TERMINAL_OUTCOMES: each terminal outcome blocks rerun', () => {
  for (const outcome of TERMINAL_OUTCOMES) {
    const state = { lastRun: { claude: { [decision.resetsAt]: { outcome } } } };
    assert.equal(canRunWindow(state, decision), false,
      `canRunWindow should be false for terminal outcome: ${outcome}`);
  }
});

test('canRunWindow allows one retry for failed outcome', () => {
  const state = { lastRun: { claude: { [decision.resetsAt]: { outcome: 'failed', attempts: 1 } } } };
  assert.equal(canRunWindow(state, decision), true);
});

test('canRunWindow blocks second retry for failed', () => {
  const state = { lastRun: { claude: { [decision.resetsAt]: { outcome: 'failed', attempts: 2 } } } };
  assert.equal(canRunWindow(state, decision), false);
});

// ── 4. selectGoal integration with real file content ─────────────────────────

test('selectGoal prioritizes goals file over handoff', () => {
  const result = selectGoal({
    goals: '- [ ] fix import\n- [x] done\n',
    handoff: '## 残TODO\n1. cleanup\n',
  });
  assert.equal(result.goal, 'fix import');
  assert.equal(result.goalSource, 'quota-sweep-goals.md');
});

test('selectGoal falls back to handoff when goals have no actionable items', () => {
  const result = selectGoal({
    goals: '- [x] done\n- [x] completed already\n',
    handoff: '## 残TODO\n1. fix memory leak\n',
  });
  assert.equal(result.goal, 'fix memory leak');
  assert.equal(result.goalSource, 'next-session.md');
});

test('selectGoal returns null goal for empty handoff and no goals', () => {
  assert.equal(selectGoal({}).goal, null);
  assert.equal(selectGoal({ goals: '' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. なし\n' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. 完了\n' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. none (done)\n' }).goal, null);
});

// ── 5. sweepFailureStop ──────────────────────────────────────────────────────

test('sweepFailureStop detects 3 consecutive failures', () => {
  const rows = [
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed', stopOutcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'failed', stopOutcome: 'failed' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'claude', outcome: 'failed', stopOutcome: 'failed' },
  ];
  const result = sweepFailureStop(rows, 'claude');
  assert.ok(result !== null);
  assert.equal(result.failures, 3);
});

test('sweepFailureStop resets count on final outcome', () => {
  const rows = [
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'final' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
  ];
  const result = sweepFailureStop(rows, 'claude');
  assert.equal(result, null);
});

test('sweepFailureStop only counts same provider', () => {
  const rows = [
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'codex', outcome: 'failed' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'codex', outcome: 'failed' },
  ];
  assert.equal(sweepFailureStop(rows, 'claude'), null); // only 1 claude failure
  assert.equal(sweepFailureStop(rows, 'codex'), null);  // only 2 codex failures
});

test('sweepFailureStop respects since threshold', () => {
  const rows = [
    { ts: new Date(now - 20 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
  ];
  assert.equal(sweepFailureStop(rows, 'claude', { since: now - 15 * minute }), null);
  assert.ok(sweepFailureStop(rows, 'claude', { since: now - 25 * minute }) !== null);
});

test('sweepFailureStop respects custom threshold', () => {
  const rows = [
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
  ];
  assert.equal(sweepFailureStop(rows, 'claude', { threshold: 2 }).failures, 2);
  assert.equal(sweepFailureStop(rows, 'claude', { threshold: 3 }), null);
});

// ── 6. makeLedger schema integration ─────────────────────────────────────────

test('makeLedger creates valid ledger entry', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now + 3000,
    goal: 'test-goal', goalSource: 'quota-sweep-goals.md',
    outcome: 'final', ticks: 3,
    branch: 'quota-sweep/test-branch',
  });
  assert.equal(row.provider, 'claude');
  assert.equal(row.window, '5h');
  assert.equal(row.outcome, 'final');
  assert.equal(row.ticks, 3);
  assert.equal(row.durationSec, 3);
  assert.equal(row.goal, 'test-goal');
  assert.equal(row.usedAfter, null);
  assert.ok(row.ts);
  assert.ok(row.resetsAt);
});

test('makeLedger preserves failureKey and deliveryError', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now + 1000,
    goal: 'fix', goalSource: 'builtin',
    outcome: 'failed', failureKey: 'child-1',
    reason: 'child exit 1', deliveryError: 'push timeout',
  });
  assert.equal(row.failureKey, 'child-1');
  assert.equal(row.reason, 'child exit 1');
  assert.equal(row.deliveryError, 'push timeout');
});

// ── 7. parseOutput ───────────────────────────────────────────────────────────

test('parseOutput detects FINAL from structured JSON result', () => {
  const out = JSON.stringify({ result: 'FINAL\nall tests green', usage: { input_tokens: 10, output_tokens: 5 } });
  const parsed = parseOutput(out);
  assert.equal(parsed.final, true);
  assert.equal(parsed.input, 10);
  assert.equal(parsed.output, 5);
});

test('parseOutput detects ITERATING (non-FINAL)', () => {
  const out = JSON.stringify({ result: 'ITERATING: fixing import errors' });
  assert.equal(parseOutput(out).final, false);
});

test('parseOutput detects FINAL from JSONL agent_message', () => {
  const lines = [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FINAL\nAll criteria satisfied' } }),
  ];
  const parsed = parseOutput(lines.join('\n'));
  assert.equal(parsed.final, true);
  assert.equal(parsed.input, 7);
  assert.equal(parsed.output, 3);
});

test('parseOutput ignores non-agent_message items', () => {
  const lines = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'FINAL' } }),
  ];
  assert.equal(parseOutput(lines.join('\n')).final, false);
});

test('parseOutput handles malformed JSON gracefully', () => {
  const parsed = parseOutput('not json at all\nmore noise');
  assert.equal(parsed.final, false);
  assert.equal(parsed.input, 0);
  assert.equal(parsed.output, 0);
});

test('parseOutput aggregates tokens across multiple turn.completed lines', () => {
  const lines = [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 20 } }),
  ];
  const parsed = parseOutput(lines.join('\n'));
  assert.equal(parsed.final, false);
  assert.equal(parsed.input, 130);
  assert.equal(parsed.output, 70);
});

// ── 8. isTransientWindowReadError ────────────────────────────────────────────

test('isTransientWindowReadError classifies transient errors', () => {
  for (const reason of ['HTTP 429', 'HTTP 503', 'HTTP 408', 'HTTP 500', 'HTTP 502', 'network: TimeoutError', 'network: ConnectionRefused']) {
    assert.ok(isTransientWindowReadError(reason), `${reason} should be transient`);
  }
});

test('isTransientWindowReadError classifies non-transient errors', () => {
  for (const reason of ['HTTP 401', 'HTTP 403', 'HTTP 400', 'HTTP 404', 'accessToken 未設定', 'credentials: ENOENT', 'usage response の形式が未対応', '', undefined, null]) {
    assert.equal(isTransientWindowReadError(reason), false, `${reason} should NOT be transient`);
  }
});

// ── 9. normalizeLandedChecks ────────────────────────────────────────────────

test('normalizeLandedChecks replaces git merge-base with commit-landed.mjs', () => {
  const input = '```\ngit merge-base --is-ancestor eee266e origin/main\n```';
  const output = normalizeLandedChecks(input);
  assert.ok(output.includes('node tools/commit-landed.mjs eee266e'));
  assert.equal(output.includes('git merge-base --is-ancestor'), false);
});

test('normalizeLandedChecks does not replace other git commands', () => {
  const input = 'git merge-base --is-ancestor abc origin/main-other';
  assert.equal(normalizeLandedChecks(input), input);
});

test('normalizeLandedChecks is idempotent', () => {
  const input = '`git merge-base --is-ancestor eee266e origin/main`';
  const once = normalizeLandedChecks(input);
  const twice = normalizeLandedChecks(once);
  assert.equal(once, twice);
});

// ── 10. normalizeLandedContract (file-level) ─────────────────────────────────

test('normalizeLandedContract normalizes .md files in-place', t => {
  const dir = temp(t);
  const file = path.join(dir, 'contract.md');
  fs.writeFileSync(file, 'Check: `git merge-base --is-ancestor abc123 origin/main`\n');
  normalizeLandedContract(file);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('node tools/commit-landed.mjs abc123'));
  assert.equal(content.includes('git merge-base --is-ancestor'), false);
});

test('normalizeLandedContract does nothing if file does not exist', () => {
  // Should not throw
  normalizeLandedContract('/nonexistent/path/contract.md');
});

test('normalizeLandedContract does nothing to already-normalized files', t => {
  const dir = temp(t);
  const file = path.join(dir, 'clean.md');
  const content = 'Check: `node tools/commit-landed.mjs abc123`\n';
  fs.writeFileSync(file, content);
  normalizeLandedContract(file);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

// ── 11. filterWindowsForCurrentAuth ──────────────────────────────────────────

test('filterWindowsForCurrentAuth keeps all windows when no auth change', () => {
  const windows = Object.assign(
    [{ provider: 'claude', window: '5h' }, { provider: 'codex', observedAt: 100, window: 'primary' }],
    { reasons: { claude: null, codex: null } }
  );
  const filtered = filterWindowsForCurrentAuth(windows, {});
  assert.equal(filtered.length, 2);
  assert.ok(filtered.reasons);
});

test('filterWindowsForCurrentAuth filters codex windows before auth change', () => {
  const windows = Object.assign(
    [{ provider: 'claude', window: '5h' }, { provider: 'codex', observedAt: 50, window: 'primary' }],
    { reasons: { claude: null, codex: 'HTTP 401' } }
  );
  const filtered = filterWindowsForCurrentAuth(windows, { codexAuthChangedAt: 100 });
  assert.equal(filtered.length, 1); // codex removed
  assert.equal(filtered[0].provider, 'claude');
  assert.ok(filtered.reasons);
});

test('filterWindowsForCurrentAuth keeps reasons property', () => {
  const all = Object.assign([], { reasons: { claude: 'HTTP 429', codex: null } });
  const filtered = filterWindowsForCurrentAuth(all, {});
  assert.deepEqual(filtered.reasons, { claude: 'HTTP 429', codex: null });
});

// ── 12. tickPrompt and contractPrompt ────────────────────────────────────────

test('tickPrompt formats correctly for claude slug', () => {
  const prompt = tickPrompt('quota-sweep-claude');
  assert.ok(prompt.startsWith('[headless:quota-sweep]'));
  assert.ok(prompt.includes('.loop/quota-sweep-claude.md'));
  assert.ok(prompt.includes('FINAL'));
  assert.ok(prompt.includes('ITERATING'));
  assert.ok(prompt.includes('.loop/quota-sweep-claude-state.md'));
});

test('tickPrompt forbids push/PR/merge', () => {
  const prompt = tickPrompt('quota-sweep-codex');
  assert.ok(prompt.includes('push/PR/merge は行わない'));
});

test('contractPrompt includes makeloop command', () => {
  const prompt = contractPrompt('claude', 'quota-sweep-claude', 'fix tests');
  assert.ok(prompt.includes('/makeloop'));
  assert.ok(prompt.includes('fix tests'));
  assert.ok(prompt.includes('closed'));
  assert.ok(prompt.includes('日本語'));
});

test('contractPrompt uses $makeloop for codex', () => {
  const prompt = contractPrompt('codex', 'quota-sweep-codex', 'goal');
  assert.ok(prompt.includes('$makeloop:makeloop'));
});

// ── 13. atomic file write ────────────────────────────────────────────────────

test('atomic writes JSON content to file', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.json');
  atomic(file, { key: 'value', num: 42 });
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('"key": "value"'));
  assert.ok(content.includes('"num": 42'));
  assert.ok(content.endsWith('\n'));
});

// ── 14. read / json helpers ──────────────────────────────────────────────────

test('read returns content of existing file', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.txt');
  fs.writeFileSync(file, 'hello\nworld\n');
  assert.equal(read(file), 'hello\nworld\n');
});

test('read returns empty string for missing file', () => {
  assert.equal(read('/nonexistent/path.txt'), '');
});

test('read throws for non-ENOENT errors', t => {
  const dir = temp(t);
  const file = path.join(dir, 'sub'); // directory, not a file
  fs.mkdirSync(file);
  assert.throws(() => read(file));
});

test('json returns parsed content or fallback', t => {
  const dir = temp(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{"a":1}');
  assert.deepEqual(json(file), { a: 1 });
  assert.deepEqual(json(path.join(dir, 'missing.json')), {});
  assert.deepEqual(json(path.join(dir, 'missing.json'), { default: true }), { default: true });
});

// ── 15. acquireLock with real filesystem ─────────────────────────────────────

test('acquireLock creates lock file and returns release function', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.lock');
  const release = acquireLock(file);
  assert.equal(typeof release, 'function');
  assert.ok(fs.existsSync(file));
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.ok(content.startedAt);
  release();
  assert.equal(fs.existsSync(file), false);
});

test('acquireLock returns null when lock is held by live process', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.lock');
  const release = acquireLock(file);
  assert.equal(acquireLock(file, { alive: () => true }), null);
  release();
});

test('acquireLock reclaims lock from dead process', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999, startedAt: 'old' }));
  const release = acquireLock(file, { alive: () => false });
  assert.equal(typeof release, 'function');
  assert.ok(fs.existsSync(file));
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(content.pid, process.pid, 'should contain new PID after reclaim');
  release();
});

// ── 16. pointerFile and accessDenied ─────────────────────────────────────────

test('pointerFile returns .git path', () => {
  assert.equal(pointerFile('/my/repo'), path.join('/my/repo', '.git'));
  assert.equal(pointerFile('C:\\repo'), path.join('C:\\repo', '.git'));
  assert.equal(pointerFile('/my/repo').endsWith('.git'), true);
});

test('accessDenied detects EPERM and EACCES', () => {
  assert.ok(accessDenied(Object.assign(new Error('perm'), { code: 'EPERM' })));
  assert.ok(accessDenied(Object.assign(new Error('acc'), { code: 'EACCES' })));
  assert.equal(accessDenied(Object.assign(new Error('enoent'), { code: 'ENOENT' })), false);
  assert.equal(!!accessDenied(null), false);    // null → null (falsy)
  assert.equal(!!accessDenied(undefined), false); // undefined → undefined (falsy)
});

// ── 17. readWorktreePointer / writeWorktreePointer with real filesystem ──────

test('readWorktreePointer reads gitdir pointer from file', t => {
  const dir = temp(t);
  const file = path.join(dir, '.git');
  fs.writeFileSync(file, 'gitdir: ../nightly-repo/.git/worktrees/sweep\n');
  assert.equal(readWorktreePointer(file), '../nightly-repo/.git/worktrees/sweep');
});

test('readWorktreePointer returns null for non-matching content', t => {
  const dir = temp(t);
  const file = path.join(dir, '.git');
  fs.writeFileSync(file, 'not a gitdir pointer\n');
  assert.equal(readWorktreePointer(file), null);
});

test('readWorktreePointer throws for non-EPERM errors', t => {
  // Windows では chmod による読み取り権限除去が機能しないためスキップ
  if (process.platform === 'win32') return;
  const dir = temp(t);
  const file = path.join(dir, '.git');
  fs.writeFileSync(file, 'gitdir: x\n');
  try { fs.chmodSync(file, 0o000); } catch { return; }
  assert.throws(() => readWorktreePointer(file));
});

test('writeWorktreePointer writes gitdir pointer', t => {
  const dir = temp(t);
  const file = path.join(dir, '.git');
  writeWorktreePointer(file, 'gitdir: ../relative\n');
  assert.ok(fs.readFileSync(file, 'utf8').includes('gitdir: ../relative'));
});

// ── 18. commandRunner — network retry ────────────────────────────────────────

test('commandRunner retries network commands once', () => {
  let calls = 0;
  const run = commandRunner(() => {
    calls++;
    return { error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stderr: '' };
  });
  assert.throws(() => run('git', ['fetch'], '/tmp'));
  assert.equal(calls, 2);
});

test('commandRunner succeeds on retry', () => {
  let calls = 0;
  const run = commandRunner(() => ++calls === 1
    ? { status: 128, stderr: "fatal: Unable to create 'C:/repo/.git/worktrees/sweep/index.lock': File exists.\nAnother git process seems to be running" }
    : { status: 0, stdout: 'ok\n' });
  assert.equal(run('git', ['checkout', 'main'], '/tmp'), 'ok');
  assert.equal(calls, 2);
});

test('commandRunner does not retry non-network commands on first failure', () => {
  let calls = 0;
  const run = commandRunner(() => {
    calls++;
    return { error: new Error('command not found'), status: null };
  });
  assert.throws(() => run('node', ['--version'], '/tmp'));
  assert.equal(calls, 1);
});

test('commandRunner retries lock contention exactly once', () => {
  let calls = 0;
  const run = commandRunner(() => {
    calls++;
    return { status: 128, stderr: "fatal: Unable to create 'index.lock': File exists.\nAnother git process seems to be running" };
  });
  assert.throws(() => run('git', ['checkout', '--detach', 'origin/main'], '/tmp'));
  assert.equal(calls, 2);
});

// ── 19. interactiveClaude — transcript detection ────────────────────────────

test('interactiveClaude returns false for headless transcripts', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const row = { type: 'user', message: { content: [{ type: 'text', text: '[headless:quota-sweep]\ngoal' }] } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  fs.utimesSync(file, now / 1000, now / 1000);
  assert.equal(interactiveClaude({ home, now }), false);
});

test('interactiveClaude returns false for sdk-cli entries', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'probe.jsonl');
  const rows = [
    { type: 'attachment', entrypoint: 'sdk-cli' },
    { type: 'user', message: { content: [{ type: 'text', text: 'OK とだけ返してください' }] } },
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, now / 1000, now / 1000);
  assert.equal(interactiveClaude({ home, now }), false);
});

test('interactiveClaude returns true for interactive entries', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const row = { type: 'user', message: { content: [{ type: 'text', text: 'help with this code' }] } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  fs.utimesSync(file, now / 1000, now / 1000);
  assert.equal(interactiveClaude({ home, now }), true);
});

// ── 20. decideSweep + sameReset integration ─────────────────────────────────

test('sameReset tolerates minute-boundary jitter', () => {
  const base = Date.UTC(2026, 9, 21, 2, 0, 0);
  assert.ok(sameReset(base - 1500, base));
  assert.ok(sameReset(base + 971, base));
  assert.equal(sameReset(base + 5 * minute, base), false);
});

test('resetKey rounds to nearest minute', () => {
  const base = Date.UTC(2026, 9, 21, 2, 0, 0);
  assert.equal(resetKey(base - 400), base);
  assert.equal(resetKey(base + 192), base);
});

test('decideSweep returns no decisions for empty windows', () => {
  const decisions = decideSweep({ windows: [], now });
  assert.equal(decisions.length, 0);
});

test('decideSweep skips fully utilized windows', () => {
  const decisions = decideSweep({ windows: [{ provider: 'claude', window: '5h', usedPercent: 99, resetsAt: now + 30 * minute }], now });
  assert.equal(decisions.length, 0);
});

test('decideSweep picks the earliest resetting window within lead time', () => {
  const windows = [
    { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 30 * minute },
    { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute },
  ];
  const decisions = decideSweep({ windows, now, leadMinutes: 60 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].window, '5h');
});

// ── 21. Parse contracted todo items ──────────────────────────────────────────

test('contractPrompt template includes all mandatory fields', () => {
  const prompt = contractPrompt('claude', 'quota-sweep-claude', 'test-goal');
  assert.ok(prompt.includes('検証ゲート'));
  assert.ok(prompt.includes('累積上限'));
  assert.ok(prompt.includes('日本語'));
  assert.ok(prompt.includes('kind=closed'));
  assert.ok(prompt.includes('/makeloop'));
  assert.ok(prompt.includes('test-goal'));
});

// ── 22. Full pipeline: parseArgs → decideSweep equivalence ──────────────────

test('parseArgs outputs are compatible with decideSweep options', () => {
  const opts = parseArgs(['--lead-min', '60', '--min-remaining', '20']);
  assert.equal(opts.leadMinutes, 60);
  assert.equal(opts.minRemainingPercent, 20);
  // These values are consumed by main() → decideSweep()
  const decisions = decideSweep({ windows, now, leadMinutes: 60, minRemainingPercent: 20 });
  assert.ok(Array.isArray(decisions));
});

// ── 23. makeLedger duration rounding ─────────────────────────────────────────

test('makeLedger calculates non-negative duration', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now - 1000, // negative span
    goal: 'test', goalSource: 'builtin', outcome: 'failed',
  });
  assert.equal(row.durationSec, 0);
});

test('makeLedger records usedAfter when provided', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now + 2000,
    goal: 'test', goalSource: 'builtin', outcome: 'final',
    usedAfter: 55,
  });
  assert.equal(row.usedAfter, 55);
});

// ── 24. TERMINAL_OUTCOMES — never contains non-terminal outcomes ─────────────

test('TERMINAL_OUTCOMES excludes non-terminal outcomes used by the module', () => {
  const nonTerminal = ['failed', 'running', 'partial', 'deferred', null, undefined, ''];
  for (const name of nonTerminal) {
    const strName = String(name);
    if (name !== null && name !== undefined) {
      assert.equal(TERMINAL_OUTCOMES.has(name), false, `${strName} should not be terminal`);
    }
  }
});

// ── 25. Edge: empty goals file combined with empty handoff ───────────────────

test('selectGoal cascades correctly through empty/falsy inputs', () => {
  // All empty
  assert.equal(selectGoal({}).goal, null);
  // Empty goals, empty handoff
  assert.equal(selectGoal({ goals: '', handoff: '' }).goal, null);
  // Goals with only completed items, empty handoff
  assert.equal(selectGoal({ goals: '- [x] all done\n- [x] every item\n' }).goal, null);
  // Handoff with "none" marker
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. なし（完了）\n' }).goal, null);
});

// ── 26. normalizeLandedChecks: handles multiple occurrences ──────────────────

test('normalizeLandedChecks replaces all occurrences', () => {
  const input = 'A: `git merge-base --is-ancestor aaa origin/main`\nB: `git merge-base --is-ancestor bbb origin/main`';
  const output = normalizeLandedChecks(input);
  assert.ok(output.includes('commit-landed.mjs aaa'));
  assert.ok(output.includes('commit-landed.mjs bbb'));
});

// ── 27. Interactive detection: old transcript beyond time limit ──────────────

test('interactiveClaude ignores transcripts older than 10 minutes', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old.jsonl');
  const row = { type: 'user', message: { content: [{ type: 'text', text: 'help' }] } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  // Set mtime to 20 minutes ago
  const old = (now - 20 * minute) / 1000;
  fs.utimesSync(file, old, old);
  assert.equal(interactiveClaude({ home, now }), false);
});

// ── 28. parseOutput: empty string ───────────────────────────────────────────

test('parseOutput returns empty result for empty input', () => {
  const parsed = parseOutput('');
  assert.equal(parsed.final, false);
  assert.equal(parsed.input, 0);
  assert.equal(parsed.output, 0);
  assert.equal(parsed.message, '');
});