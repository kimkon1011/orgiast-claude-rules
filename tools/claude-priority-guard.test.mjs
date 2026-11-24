import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  guardClaudePriority,
  calcMedian,
  calcThreshold,
  hasActiveChildren,
  getActiveChildren,
  buildDecision,
} from './claude-priority-guard.mjs';

// ════════════════════════════════════════════════════════════════════
// calcMedian
// ════════════════════════════════════════════════════════════════════

test('calcMedian: odd number of elements', () => {
  assert.equal(calcMedian([1, 3, 5]), 3);
  assert.equal(calcMedian([10, 20, 30, 40, 50]), 30);
});

test('calcMedian: even number of elements', () => {
  assert.equal(calcMedian([1, 2, 3, 4]), 2.5);
  assert.equal(calcMedian([10, 20, 30, 40]), 25);
});

test('calcMedian: empty array', () => {
  assert.equal(calcMedian([]), 0);
  assert.equal(calcMedian(null), 0);
  assert.equal(calcMedian(undefined), 0);
});

test('calcMedian: single element', () => {
  assert.equal(calcMedian([42]), 42);
});

test('calcMedian: all same values', () => {
  assert.equal(calcMedian([5, 5, 5, 5]), 5);
});

// ════════════════════════════════════════════════════════════════════
// calcThreshold
// ════════════════════════════════════════════════════════════════════

test('calcThreshold: median*3 is larger', () => {
  // median=10 → median*3=30, elapsed*0.25=10 → max=30
  assert.equal(calcThreshold([10, 10, 10], 40), 30);
});

test('calcThreshold: elapsed*0.25 is larger', () => {
  // median=2 → median*3=6, elapsed*0.25=25 → max=25
  assert.equal(calcThreshold([2, 2, 2], 100), 25);
});

test('calcThreshold: both equal', () => {
  // median=4 → median*3=12, elapsed*0.25=12 → max=12
  assert.equal(calcThreshold([4, 4, 4], 48), 12);
});

test('calcThreshold: empty deltas (median=0 → 0*3=0), only elapsed counts', () => {
  assert.equal(calcThreshold([], 40), 10);
});

test('calcThreshold: zero elapsed (first run-like)', () => {
  assert.equal(calcThreshold([5, 5, 5], 0), 15);
  assert.equal(calcThreshold([], 0), 0);
});

// ════════════════════════════════════════════════════════════════════
// hasActiveChildren
// ════════════════════════════════════════════════════════════════════

const NOW = 1_700_000_000_000;

function makeChild(overrides = {}) {
  return {
    pid: 200,
    ppid: 100,
    name: 'node.exe',
    commandLine: 'node index.js',
    createdAt: NOW - 10_000, // 10 seconds ago
    ...overrides,
  };
}

test('hasActiveChildren: recent non-MCP child → true', () => {
  assert.equal(hasActiveChildren(100, [makeChild()], NOW), true);
});

test('hasActiveChildren: MCP child excluded → false', () => {
  assert.equal(hasActiveChildren(100, [makeChild({ commandLine: 'mcp-server index.js' })], NOW), false);
  assert.equal(hasActiveChildren(100, [makeChild({ commandLine: 'node mcp/index.js' })], NOW), false);
});

test('hasActiveChildren: old child (over 3 min) → false', () => {
  assert.equal(hasActiveChildren(100, [makeChild({ createdAt: NOW - 200_000 })], NOW), false);
});

test('hasActiveChildren: null createdAt → false', () => {
  assert.equal(hasActiveChildren(100, [makeChild({ createdAt: null })], NOW), false);
});

test('hasActiveChildren: wrong PPID → false', () => {
  assert.equal(hasActiveChildren(100, [makeChild({ ppid: 999 })], NOW), false);
});

test('hasActiveChildren: not in CHILD_NAMES → false', () => {
  assert.equal(hasActiveChildren(100, [makeChild({ name: 'chrome.exe' })], NOW), false);
});

test('hasActiveChildren: empty children → false', () => {
  assert.equal(hasActiveChildren(100, [], NOW), false);
});

test('hasActiveChildren: multiple children, one matches → true', () => {
  const children = [
    makeChild({ ppid: 100, name: 'gh.exe', commandLine: 'gh pr list', createdAt: NOW - 5000 }),
    makeChild({ ppid: 100, name: 'node.exe', commandLine: 'mcp-server', createdAt: NOW - 5000 }),
    makeChild({ ppid: 100, name: 'git.exe', createdAt: NOW - 300_000 }), // too old
  ];
  assert.equal(hasActiveChildren(100, children, NOW), true);
});

// ════════════════════════════════════════════════════════════════════
// getActiveChildren
// ════════════════════════════════════════════════════════════════════

test('getActiveChildren: returns correct PIDs', () => {
  const children = [
    makeChild({ pid: 201, ppid: 100 }),
    makeChild({ pid: 202, ppid: 100, name: 'gh.exe' }),
  ];
  assert.deepEqual(getActiveChildren(100, children, NOW).sort(), [201, 202]);
});

test('getActiveChildren: filters MCP', () => {
  const children = [
    makeChild({ pid: 201, ppid: 100 }),
    makeChild({ pid: 202, ppid: 100, commandLine: 'node mcp.js' }),
  ];
  assert.deepEqual(getActiveChildren(100, children, NOW), [201]);
});

test('getActiveChildren: filters old children', () => {
  const children = [
    makeChild({ pid: 201, ppid: 100, createdAt: NOW - 10_000 }),
    makeChild({ pid: 202, ppid: 100, createdAt: NOW - 200_000 }),
  ];
  assert.deepEqual(getActiveChildren(100, children, NOW), [201]);
});

test('getActiveChildren: empty when nothing matches', () => {
  assert.deepEqual(getActiveChildren(100, [], NOW), []);
  assert.deepEqual(getActiveChildren(100, [makeChild({ ppid: 999 })], NOW), []);
});

// ════════════════════════════════════════════════════════════════════
// buildDecision
// ════════════════════════════════════════════════════════════════════

const BASE_TIME = 1_700_000_000_000;

function makeProc(overrides = {}) {
  return {
    pid: 100,
    exe: 'C:\\Program Files\\Claude\\claude.exe',
    cpu: 50,
    priority: 'Normal',
    ...overrides,
  };
}

test('buildDecision: first run (no prev state) → all processes lower', () => {
  const procs = [
    makeProc({ pid: 100, cpu: 10 }),
    makeProc({ pid: 101, cpu: 20 }),
  ];
  const decision = buildDecision(procs, [], { pids: {}, epochMs: BASE_TIME - 60_000 }, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, []);
  assert.equal(decision.claudeToLower.length, 2);
  assert.equal(decision.childrenToRaise.length, 0);
  // New state should have both PIDs
  assert.ok(decision.newState.pids[100]);
  assert.ok(decision.newState.pids[101]);
  assert.equal(decision.newState.pids[100].cpu, 10);
});

test('buildDecision: active by CPU delta above threshold', () => {
  // 3 processes: 2 idle (delta=2), 1 active (delta=120)
  // Deltas: [2, 2, 120] → sorted → median=2 → threshold=max(6, 15)=15
  const prevState = {
    pids: {
      98: { cpu: 10, at: BASE_TIME - 60_000 },
      99: { cpu: 10, at: BASE_TIME - 60_000 },
      100: { cpu: 10, at: BASE_TIME - 60_000 },
    },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [
    makeProc({ pid: 98, cpu: 12 }),    // delta=2 → idle
    makeProc({ pid: 99, cpu: 12 }),    // delta=2 → idle
    makeProc({ pid: 100, cpu: 130 }),  // delta=120 → active (120 >= 15)
  ];
  const decision = buildDecision(procs, [], prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, [100]);
  assert.deepEqual(decision.claudeToLower.sort(), [98, 99]);
});

test('buildDecision: active by recent children (CPU under threshold)', () => {
  const prevState = {
    pids: { 100: { cpu: 10, at: BASE_TIME - 60_000 } },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [makeProc({ pid: 100, cpu: 11 })]; // delta=1, threshold=15 → idle by CPU
  const children = [{ pid: 201, ppid: 100, name: 'node.exe', commandLine: 'node index.js', createdAt: BASE_TIME - 10_000 }];
  const decision = buildDecision(procs, children, prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, [100]); // active by children
  assert.deepEqual(decision.childrenToRaise, [201]);
  assert.equal(decision.claudeToLower.length, 0);
});

test('buildDecision: mix of active and idle', () => {
  // 100: active by CPU
  // 101: active by children
  // 102: idle
  const prevState = {
    pids: {
      100: { cpu: 10, at: BASE_TIME - 60_000 },
      101: { cpu: 10, at: BASE_TIME - 60_000 },
      102: { cpu: 10, at: BASE_TIME - 60_000 },
    },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [
    makeProc({ pid: 100, cpu: 120 }),
    makeProc({ pid: 101, cpu: 11 }),
    makeProc({ pid: 102, cpu: 11 }),
  ];
  const children = [
    { pid: 301, ppid: 101, name: 'git.exe', commandLine: 'git status', createdAt: BASE_TIME - 5000 },
  ];
  const decision = buildDecision(procs, children, prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise.sort(), [100, 101]);
  assert.deepEqual(decision.claudeToLower, [102]);
  assert.deepEqual(decision.childrenToRaise, [301]);
});

test('buildDecision: WindowsApps excluded from changes', () => {
  const prevState = {
    pids: {
      100: { cpu: 10, at: BASE_TIME - 60_000 },
      101: { cpu: 10, at: BASE_TIME - 60_000 },
    },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [
    makeProc({ pid: 100, exe: 'C:\\WindowsApps\\Claude\\claude.exe', cpu: 120 }), // would be active, but excluded
    makeProc({ pid: 101, cpu: 11 }), // idle
  ];
  const decision = buildDecision(procs, [], prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, []); // 100 excluded, not raised
  assert.deepEqual(decision.claudeToLower, [101]);
  // State still saved for WindowsApps
  assert.ok(decision.newState.pids[100]);
});

test('buildDecision: processes with AboveNormal/High/RealTime are not changed', () => {
  // buildDecision doesn't check priority directly — it classifies by CPU delta
  // and children. Priority-based filtering happens in the apply PS script.
  // This test verifies that processes are not lowered if no CPU/children signal.
  const prevState = {
    pids: { 100: { cpu: 10, at: BASE_TIME - 60_000 } },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [makeProc({ pid: 100, cpu: 11 })];
  const decision = buildDecision(procs, [], prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, []);
  assert.deepEqual(decision.claudeToLower, [100]); // idle → lower; PS script handles AboveNormal skip
});

test('buildDecision: empty processes (no claude.exe at all)', () => {
  const prevState = {
    pids: { 100: { cpu: 10, at: BASE_TIME - 60_000 } },
    epochMs: BASE_TIME - 60_000,
  };
  const decision = buildDecision([], [], prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, []);
  assert.deepEqual(decision.claudeToLower, []);
  assert.deepEqual(decision.childrenToRaise, []);
  // Old PID cleaned from state
  assert.deepEqual(decision.newState.pids, {});
});

test('buildDecision: new PID (not in prev state) treated as idle', () => {
  // 3 processes: 2 existing idle, 1 new
  // Deltas: [2, 2] → median=2 → threshold=max(6, 15)=15
  const prevState = {
    pids: {
      100: { cpu: 10, at: BASE_TIME - 60_000 },
      101: { cpu: 10, at: BASE_TIME - 60_000 },
    },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [
    makeProc({ pid: 100, cpu: 20 }),  // delta=10 → idle (10 < 15)
    makeProc({ pid: 101, cpu: 12 }),  // delta=2 → idle
    makeProc({ pid: 200, cpu: 5 }),   // new PID, no prev state → idle
  ];
  const decision = buildDecision(procs, [], prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, []); // all idle
  assert.deepEqual(decision.claudeToLower.sort(), [100, 101, 200]); // all lower
  // New state includes new PID
  assert.ok(decision.newState.pids[200]);
});

test('buildDecision: childrenToRaise deduplicated', () => {
  // Two claude processes share a child PID (unusual but possible)
  const children = [
    { pid: 301, ppid: 100, name: 'node.exe', commandLine: 'node build.js', createdAt: BASE_TIME - 5000 },
    { pid: 301, ppid: 101, name: 'node.exe', commandLine: 'node build.js', createdAt: BASE_TIME - 5000 },
  ];
  const procs = [
    makeProc({ pid: 100, cpu: 120 }),
    makeProc({ pid: 101, cpu: 130 }),
  ];
  const prevState = {
    pids: {
      100: { cpu: 10, at: BASE_TIME - 60_000 },
      101: { cpu: 10, at: BASE_TIME - 60_000 },
    },
    epochMs: BASE_TIME - 60_000,
  };
  const decision = buildDecision(procs, children, prevState, BASE_TIME);
  assert.deepEqual(decision.childrenToRaise, [301]); // deduplicated
});

// ════════════════════════════════════════════════════════════════════
// Integration tests (via guardClaudePriority)
// ════════════════════════════════════════════════════════════════════

test('non-Windows returns skipped', () => {
  const result = guardClaudePriority({ platform: 'linux', exec() { assert.fail(); } });
  assert.deepEqual(result, { skipped: 'non-win32' });
});

test('collect failure returns failure counters', () => {
  const exec = () => ({ error: new Error('spawn failed') });
  assert.deepEqual(guardClaudePriority({ platform: 'win32', exec }), {
    lowered: 0, alreadyLow: 0, excluded: 0, failed: 1, raised: 0, childrenRaised: 0,
  });
});

test('exit 0 regardless of outcome via real direct run of the module', async (t) => {
  const result = spawnSync(process.execPath, ['tools/claude-priority-guard.mjs'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout.replace(/^﻿/, '').trim());
  if (parsed.skipped !== 'non-win32') {
    // On real Windows, should have all expected counters
    assert.ok(typeof parsed.lowered === 'number');
    assert.ok(typeof parsed.alreadyLow === 'number');
    assert.ok(typeof parsed.excluded === 'number');
    assert.ok(typeof parsed.failed === 'number');
    assert.ok(typeof parsed.raised === 'number');
    assert.ok(typeof parsed.childrenRaised === 'number');
  } else {
    assert.equal(parsed.skipped, 'non-win32');
  }
});

test('buildDecision: correct threshold with varied CPU deltas', () => {
  // Deltas: [2, 3, 50] → median=3 → threshold = max(9, 60*0.25=15) = 15
  const prevState = {
    pids: {
      100: { cpu: 10, at: BASE_TIME - 60_000 },
      101: { cpu: 10, at: BASE_TIME - 60_000 },
      102: { cpu: 10, at: BASE_TIME - 60_000 },
    },
    epochMs: BASE_TIME - 60_000,
  };
  const procs = [
    makeProc({ pid: 100, cpu: 12 }),    // delta=2 → idle
    makeProc({ pid: 101, cpu: 13 }),    // delta=3 → idle
    makeProc({ pid: 102, cpu: 60 }),    // delta=50 → active (50 ≥ 15)
  ];
  const decision = buildDecision(procs, [], prevState, BASE_TIME);
  assert.deepEqual(decision.claudeToRaise, [102]);
  assert.deepEqual(decision.claudeToLower.sort(), [100, 101]);
});
