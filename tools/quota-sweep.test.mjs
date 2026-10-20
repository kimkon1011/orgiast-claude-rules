import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DEFAULT_GOAL, MAX_TICKS, selectGoal, tickPrompt, contractPrompt, canRunWindow, interactiveClaude, main, makeLedger, runSweep, parseOutput, acquireLock } from './quota-sweep.mjs';
import { runBounded, killTree } from './lib/quota-sweep-process.mjs';
import { interactiveCodex, wslPath } from './lib/quota-sweep-host.mjs';
const now = Date.UTC(2026, 9, 21), minute = 60_000;
const decision = { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 60 * minute, deadline: now + 57 * minute };
const windows = [{ provider: 'claude', window: '5h', usedPercent: 40, resetsAt: decision.resetsAt }, { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute }];
const temp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
test('goal selection priority and none fallback', () => {
  const handoff = '## 残TODO\n1. fix import\n';
  assert.deepEqual(selectGoal({ goals: '- [x] done\n- [ ] test goal', handoff }), { goal: 'test goal', goalSource: 'quota-sweep-goals.md' });
  assert.equal(selectGoal({ handoff }).goal, 'fix import');
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. なし\n' }).goal, DEFAULT_GOAL);
});
test('prompt binds slug, cumulative cap and proven FINAL', () => {
  assert.match(tickPrompt('quota-sweep-claude'), /^\[headless:quota-sweep\]/);
  assert.match(tickPrompt('quota-sweep-claude'), /\.loop\/quota-sweep-claude.md/);
  assert.match(tickPrompt('quota-sweep-claude'), /FINAL only when every criterion is proved/);
  assert.match(contractPrompt('codex', 'quota-sweep-codex', 'goal'), /\$makeloop:makeloop/);
  assert.ok(contractPrompt('claude', 'slug', 'goal').includes(`累積上限 ${MAX_TICKS}`));
});
test('terminal windows never rerun; failed/running gets one retry only', () => {
  assert.equal(canRunWindow({}, decision), true);
  for (const outcome of ['final', 'ceiling', 'exhausted', 'deadline', 'no-goal']) assert.equal(canRunWindow({ lastRun: { claude: { [decision.resetsAt]: { outcome } } } }, decision), false);
  for (const outcome of ['failed', 'running']) {
    assert.equal(canRunWindow({ lastRun: { claude: { [decision.resetsAt]: { outcome, attempts: 1 } } } }, decision), true);
    assert.equal(canRunWindow({ lastRun: { claude: { [decision.resetsAt]: { outcome, attempts: 2 } } } }, decision), false);
  }
});
test('interactive transcript detection distinguishes headless, age and first prompt', t => {
  const home = temp(t), dir = path.join(home, '.claude/projects/repo'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const write = prompt => { fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: prompt }] } }) + '\n'); fs.utimesSync(file, now / 1000, now / 1000); };
  write('[headless:quota-sweep]\ngoal'); assert.equal(interactiveClaude({ home, now }), false);
  write('help'); assert.equal(interactiveClaude({ home, now }), true);
  assert.equal(interactiveClaude({ home, now: now + 11 * minute }), false);
});
test('Codex TUI vs exec and host path conversion', () => {
  assert.equal(interactiveCodex('/usr/bin/node /usr/bin/codex --model model'), true);
  assert.equal(interactiveCodex('/usr/bin/codex exec -s workspace-write -'), false);
  assert.equal(interactiveCodex('/bin/ps -eo args='), false);
  assert.equal(wslPath('C:\\Users\\kim\\repo'), '/mnt/c/Users/kim/repo');
});
test('dry run calls no spawn and creates no state, even with eligible windows', async t => {
  const home = temp(t); let calls = 0;
  const result = await main(['--dry-run', '--json', '--home', home], { now: () => now, readWindows: async () => windows, spawnImpl: () => { calls++; throw new Error('unexpected spawn'); }, print: () => {} });
  assert.equal(result.decision.length, 1); assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(home, '.claude/quota-sweep-state.json')), false);
});
test('ledger schema preserves unknown usage and elapsed seconds', () => {
  const row = makeLedger({ decision, startedAt: now, endedAt: now + 2000, goal: 'test', goalSource: 'builtin', outcome: 'deadline' });
  assert.deepEqual(Object.keys(row), ['ts', 'provider', 'window', 'resetsAt', 'usedBefore', 'usedAfter', 'ticks', 'outcome', 'goal', 'goalSource', 'branch', 'prUrl', 'durationSec']);
  assert.equal(row.durationSec, 2); assert.equal(row.usedAfter, null);
});
test('deadline kills process tree, never spawns after deadline', async () => {
  const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let callback, killed = 0, calls = 0;
  const result = runBounded('fixture', [], { deadline: now + 1000, now: () => now, watchdog: false, platform: 'win32', spawnImpl: () => { calls++; return child; }, setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {}, kill: pid => { assert.equal(pid, 123); killed++; child.emit('close', null); } });
  callback(); assert.equal((await result).timedOut, true); assert.equal(killed, 1);
  assert.equal((await runBounded('fixture', [], { deadline: now, now: () => now, spawnImpl: () => calls++ })).timedOut, true);
  assert.equal(calls, 1);
  let args; killTree(123, { platform: 'win32', spawnImpl: (exe, argv) => { assert.equal(exe, 'taskkill'); args = argv; return { status: 0 }; } });
  assert.deepEqual(args, ['/PID', '123', '/T', '/F']);
});
test('FINAL only from final structured message, never quoted tool text', () => {
  assert.equal(parseOutput(JSON.stringify({ result: 'ITERATING: FINAL is not proven' })).final, false);
  assert.equal(parseOutput(JSON.stringify({ result: 'FINAL\nall evidence recorded', usage: { input_tokens: 4, output_tokens: 5 } })).final, true);
  assert.equal(parseOutput(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'FINAL' } })).final, false);
  assert.equal(parseOutput(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FINAL' } })).final, true);
});
test('lock respects live/unknown owner and reclaims dead PID', t => {
  const file = path.join(temp(t), 'lock'); fs.writeFileSync(file, JSON.stringify({ pid: 999, startedAt: 'old' }));
  assert.equal(acquireLock(file, { alive: () => true }), null);
  const release = acquireLock(file, { alive: () => false }); assert.equal(typeof release, 'function'); release(); assert.equal(fs.existsSync(file), false);
});
function context(t, child) {
  const home = temp(t), tree = path.join(home, 'tree'); fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(tree);
  const state = {};
  return { home, tree, state, save: () => {}, windows: async () => windows, active: async () => false, log: () => {}, env: {}, now: () => now, claudeExe: 'fixture',
    prepareTree: () => ({ tree, branch: 'quota-sweep/test', base: 'base' }), command: (_exe, args) => args[0] === 'branch' ? 'quota-sweep/test' : '0', runChild: child, notify: async () => {} };
}
test('fallback contract after generator failure, then final; ledger and usage persisted', async t => {
  let calls = 0;
  const ctx = context(t, async () => ++calls === 1 ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify({ result: 'FINAL', usage: { input_tokens: 10, output_tokens: 2 } }) });
  await runSweep(decision, ctx);
  const row = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/quota-sweep.jsonl')));
  assert.equal(row.outcome, 'final'); assert.equal(row.ticks, 1); assert.equal(calls, 2);
  const contract = fs.readFileSync(path.join(ctx.tree, '.loop/quota-sweep-claude.md'), 'utf8');
  assert.ok(contract.includes(DEFAULT_GOAL)); assert.doesNotMatch(contract, /{{\w+}}/);
  const usage = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/executor-usage.jsonl'))); assert.equal(usage.tokens, 12);
});
test('two failed ticks stop; before-spawn reservations survive interruption', async t => {
  const ctx = context(t, async () => ({ code: 1, stdout: '' }));
  await runSweep(decision, ctx);
  assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'failed');
  assert.equal(ctx.state.lastRun.claude[decision.resetsAt].ticks, 2);
  const budget = JSON.parse(fs.readFileSync(path.join(ctx.tree, '.loop/quota-sweep-claude-budget.json'))); assert.equal(budget.ticks, 2);
});
test('ceiling refreshed before Phase A prevents any model invocation', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; });
  ctx.windows = async () => windows.map(w => ({ ...w, usedPercent: 98 }));
  await runSweep(decision, ctx); assert.equal(calls, 0); assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'ceiling');
});

test('fresh remaining below minimum blocks Phase A even before ceiling', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; });
  ctx.windows = async () => windows.map(w => ({ ...w, usedPercent: 90 }));
  await runSweep(decision, ctx); assert.equal(calls, 0); assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'exhausted');
});
test('new reset archives old state and starts again, same-window retry keeps cumulative budget', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; return { code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }; });
  await runSweep(decision, ctx);
  const firstCalls = calls;
  const nextDecision = { ...decision, resetsAt: decision.resetsAt + minute, deadline: decision.deadline + minute };
  ctx.windows = async () => windows.map(w => w.window === '5h' ? { ...w, resetsAt: nextDecision.resetsAt } : w);
  await runSweep(nextDecision, ctx);
  assert.equal(calls, firstCalls + 1); // contract reused; one new tick
  assert.equal(ctx.state.lastRun.claude[nextDecision.resetsAt].outcome, 'final');
  assert.ok(fs.readdirSync(path.join(ctx.tree, '.loop')).some(n => n.startsWith('archive-')));
});
test('eight ticks is hard cap and a retry cannot reset it', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; return { code: 0, stdout: JSON.stringify({ result: 'ITERATING' }) }; });
  await runSweep(decision, ctx);
  assert.equal(ctx.state.lastRun.claude[decision.resetsAt].ticks, MAX_TICKS);
  assert.equal(calls, MAX_TICKS + 1); // generation + ticks
  await runSweep(decision, ctx);
  assert.equal(calls, MAX_TICKS + 1);
});
test('PR only for new commits; notification failure is nonfatal', async t => {
  const commands = []; const ctx = context(t, async () => ({ code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }));
  ctx.command = (exe, args) => {
    commands.push([exe, ...args]);
    if (args[0] === 'branch') return 'quota-sweep/test';
    if (args[0] === 'rev-list') return '1';
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/example/repo/pull/1';
    return '';
  };
  ctx.notify = async () => { throw new Error('offline'); };
  await runSweep(decision, ctx);
  assert.ok(commands.some(c => c[1] === 'push'));
  assert.ok(commands.some(c => c[1] === 'pr' && c[2] === 'create'));
  assert.equal(commands.some(c => c.includes('merge')), false);
  assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'final');
});
test('disable guard precedes observation and locking', async t => {
  const home = temp(t); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/auto-session.env'), 'ORGIAST_QUOTA_SWEEP=0\n');
  const result = await main(['--home', home], { platform: 'win32', print: () => {}, readWindows: () => { throw new Error('unexpected read'); } });
  assert.equal(result.skipped, true); assert.equal(fs.existsSync(path.join(home, '.claude/quota-sweep.lock')), false);
});

test('real child is reaped at deadline with independent watchdog', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const start = Date.now();
  const result = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { deadline: start + 500 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - start < 5000);
});
test('usage monitor stops active process before its time limit', async () => {
  const child = new EventEmitter(); child.pid = 321; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const callbacks = [];
  const result = runBounded('fixture', [], { deadline: now + 1000, now: () => now, watchdog: false, platform: 'win32', spawnImpl: () => child,
    setTimer: fn => { callbacks.push(fn); return callbacks.length; }, clearTimer: () => {}, monitor: async () => 'ceiling',
    kill: () => child.emit('close', null) });
  await callbacks[1]();
  const stopped = await result; assert.equal(stopped.stopReason, 'ceiling'); assert.equal(stopped.timedOut, false);
});

test('single Codex usage record is counted once', () => {
  const parsed = parseOutput(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } }));
  assert.equal(parsed.input, 11); assert.equal(parsed.output, 7);
});

test('live reset timestamp millisecond jitter does not stop an eligible tick', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; return { code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }; });
  ctx.windows = async () => windows.map(w => ({ ...w, resetsAt: w.resetsAt + 971 }));
  await runSweep(decision, ctx);
  assert.equal(calls, 2); assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'final');
});

test('external rescue branch switch stops ticks and never pushes the wrong ref', async t => {
  const commands = []; let currentBranch = 'quota-sweep/test';
  const ctx = context(t, async () => { currentBranch = 'rescue/external'; return { code: 0, stdout: JSON.stringify({ result: 'ITERATING' }) }; });
  ctx.command = (exe, args) => { commands.push([exe, ...args]); return args[0] === 'branch' ? currentBranch : '1'; };
  await runSweep(decision, ctx);
  assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'failed');
  assert.equal(commands.some(c => c[1] === 'push'), false);
});
