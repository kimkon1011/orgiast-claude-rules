import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { filterWindowsForCurrentAuth, isTransientWindowReadError, commandRunner, queueRepeatedFailure, writeWorktreePointer, prepareTree, preserveDirtyTree, DEFAULT_GOAL, MAX_TICKS, selectGoal, tickPrompt, contractPrompt, canRunWindow, interactiveClaude, main, makeLedger, runSweep, parseOutput, acquireLock, readWorktreePointer } from './quota-sweep.mjs';
import { runBounded, killTree } from './lib/quota-sweep-process.mjs';
import { interactiveCodex, wslPath } from './lib/quota-sweep-host.mjs';
import { decideSweep, resetKey, sameReset } from './lib/quota-windows.mjs';
const now = Date.UTC(2026, 9, 21), minute = 60_000;
const decision = { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 60 * minute, deadline: now + 57 * minute };
const windows = [{ provider: 'claude', window: '5h', usedPercent: 40, resetsAt: decision.resetsAt }, { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute }];
const temp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
test('goal selection priority and none fallback', () => {
  const handoff = '## 残TODO\n1. fix import\n';
  assert.deepEqual(selectGoal({ goals: '- [x] done\n- [ ] test goal', handoff }), { goal: 'test goal', goalSource: 'quota-sweep-goals.md' });
  assert.equal(selectGoal({ handoff }).goal, 'fix import');
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. なし\n' }).goal, null);
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
  assert.deepEqual(Object.keys(row), ['ts', 'provider', 'window', 'resetsAt', 'usedBefore', 'usedAfter', 'ticks', 'outcome', 'goal', 'goalSource', 'branch', 'prUrl', 'reason', 'failureKey', 'stopOutcome', 'deliveryError', 'durationSec']);
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
// 2026-10-21 実測: worktree の .git が EPERM で開けず prepareTree が ticks=0 で6連続 failed。
// chmod して再試行し、Windows ネイティブ git なら絶対パスのまま続行することを固定する。
function worktreeFixture(t) {
  const home = temp(t), tree = path.join(home, '.claude', 'quota-sweep-repo');
  const sharedPointer = path.join(home, '.claude', 'nightly-repo', '.git', 'worktrees', 'quota-sweep-repo');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${sharedPointer}\n`);
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
  const run = (_exe, args) => args[0] === 'rev-parse' ? 'base' : '';
  return { home, tree, sharedPointer, eperm, run };
}
test('prepareTree は dirty を commit・push してから新ブランチへ進む', t => {
  const { home } = worktreeFixture(t); const calls = []; let statuses = 0;
  const run = (_exe, args) => {
    calls.push(args);
    if (args[0] === 'status') return statuses++ === 0 ? ' M tools/work.mjs' : '';
    if (args[0] === 'branch') return 'quota-sweep/prior';
    if (args[0] === 'rev-parse') return 'base';
    return '';
  };
  assert.doesNotThrow(() => prepareTree({ home, provider: 'codex', run, previous: null }));
  const verbs = calls.map(args => args[0] === '-c' ? 'commit' : args[0]);
  assert.ok(verbs.indexOf('commit') >= 0);
  assert.ok(verbs.indexOf('commit') < verbs.indexOf('push'));
  assert.ok(verbs.indexOf('push') < verbs.indexOf('checkout'));
  assert.equal(statuses, 2);
  assert.deepEqual(calls.find(args => args[0] === 'add'), ['add', '-A', '--', '.', ':!.loop']);
});
test('prepareTree は救済 commit 後も dirty なら従来メッセージで停止する', t => {
  const { home } = worktreeFixture(t);
  const run = (_exe, args) => args[0] === 'status' ? ' M tools/work.mjs' : args[0] === 'branch' ? 'quota-sweep/prior' : '';
  assert.throws(() => prepareTree({ home, provider: 'codex', run, previous: null }), /Uncommitted prior work preserved in quota-sweep-repo; reconcile before starting a new branch/);
});
test('preserveDirtyTree は push 失敗を warning にしてローカル commit を保持する', t => {
  const { tree } = worktreeFixture(t); const logs = [];
  const result = preserveDirtyTree({ tree, now: () => Date.UTC(2026, 9, 24, 1, 2, 3), log: text => logs.push(text), run: (_exe, args) => {
    if (args[0] === 'branch') return 'quota-sweep/prior';
    if (args[0] === 'push') throw new Error('offline');
    return '';
  } });
  assert.deepEqual(result, { branch: 'quota-sweep/prior', pushed: false, warning: 'preserved locally but push failed: offline' });
  assert.match(logs[0], /push failed: offline/);
});
test('preserveDirtyTree は detached HEAD に rescue ブランチを作る', t => {
  const { tree } = worktreeFixture(t); const calls = [];
  const result = preserveDirtyTree({ tree, now: () => Date.UTC(2026, 9, 24, 1, 2, 3), run: (_exe, args) => { calls.push(args); return ''; } });
  assert.equal(result.branch, 'quota-sweep/rescue-20261024-010203');
  assert.deepEqual(calls[1], ['switch', '-c', result.branch]);
  assert.equal(result.pushed, true);
});
test('readWorktreePointer/writeWorktreePointer は EPERM のあと chmod して再試行する', t => {
  const file = path.join(temp(t), '.git');
  let reads = 0, writes = 0, chmods = 0;
  const read = readWorktreePointer(file, { readFile: () => { if (++reads === 1) throw Object.assign(new Error('x'), { code: 'EPERM' }); return 'gitdir: ../repo/.git/worktrees/x\n'; }, chmod: () => { chmods++; } });
  assert.equal(read, '../repo/.git/worktrees/x');
  assert.equal(chmods, 1); assert.equal(reads, 2);
  const seen = [];
  writeWorktreePointer(file, 'gitdir: rel\n', { writeFile: (_f, value) => { seen.push(value); if (++writes === 1) throw Object.assign(new Error('x'), { code: 'EPERM' }); }, chmod: () => { chmods++; } });
  assert.equal(writes, 2); assert.deepEqual(seen, ['gitdir: rel\n', 'gitdir: rel\n']); assert.equal(chmods, 2);
});
test('prepareTree は一時的な EPERM でも相対ポインタを書いて続行する', t => {
  const { home, tree, sharedPointer, eperm, run } = worktreeFixture(t);
  let writes = 0, chmods = 0;
  const io = { writeFile: (file, value) => { if (++writes === 1) throw eperm(); fs.writeFileSync(file, value); }, chmod: () => { chmods++; } };
  const prepared = prepareTree({ home, provider: 'codex', run, previous: null, io });
  assert.equal(prepared.tree, tree); assert.equal(prepared.base, 'base'); assert.equal(prepared.pointerWarning, undefined);
  assert.equal(writes, 2); assert.equal(chmods, 1);
  assert.equal(fs.readFileSync(path.join(tree, '.git'), 'utf8'), `gitdir: ${path.relative(tree, sharedPointer).replaceAll('\\', '/')}\n`);
});
test('prepareTree は書き込み不能でも native git なら落とさず、WSL 用の相対化が要るときだけ落とす', t => {
  const { home, tree, sharedPointer, eperm, run } = worktreeFixture(t);
  const io = { writeFile: () => { throw eperm(); }, chmod: () => {} };
  const prepared = prepareTree({ home, provider: 'codex', run, previous: null, io });
  assert.equal(prepared.tree, tree); assert.match(prepared.pointerWarning, /EPERM/);
  assert.equal(fs.readFileSync(path.join(tree, '.git'), 'utf8'), `gitdir: ${sharedPointer}\n`);
  assert.throws(() => prepareTree({ home, provider: 'codex', run, previous: null, io, needRelativePointer: true }), /EPERM/);
  // 読み取りが EPERM のままなら、native でも worktree は使えないので落とす。
  assert.throws(() => prepareTree({ home, provider: 'codex', run, previous: null, io: { readFile: () => { throw eperm(); }, chmod: () => {} } }), /EPERM/);
});
function context(t, child) {
  const home = temp(t), tree = path.join(home, 'tree'); fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(tree);
  fs.writeFileSync(path.join(home, '.claude/quota-sweep-goals.md'), `- [ ] ${DEFAULT_GOAL}\n`);
  const state = {};
  return { home, tree, state, save: () => {}, windows: async () => windows, active: async () => false, log: () => {}, env: {}, now: () => now, claudeExe: 'fixture', sleep: async () => {},
    prepareTree: () => ({ tree, branch: 'quota-sweep/test', base: 'base' }), command: (_exe, args) => args[0] === 'branch' ? 'quota-sweep/test' : args[0] === 'rev-list' ? '0' : '', runChild: child, notify: async () => {} };
}
test('runSweep は FINAL の未コミット作業を救済して同じ実行で配信する', async t => {
  const ctx = context(t, async () => ({ code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }));
  const calls = [], logs = []; let committed = false;
  ctx.log = message => logs.push(message);
  ctx.command = (_exe, args) => {
    calls.push(args);
    if (args[0] === 'branch') return 'quota-sweep/test';
    if (args[0] === 'status') return committed ? '' : ' M tools/work.mjs';
    if (args.includes('commit')) committed = true;
    if (args[0] === 'rev-list') return committed ? '1' : '0';
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/example/repo/pull/1';
    return '';
  };
  await runSweep(decision, ctx);
  const row = ctx.state.lastRun.claude[decision.resetsAt];
  assert.equal(committed, true);
  assert.equal(row.outcome, 'final');
  assert.equal(row.prUrl, 'https://github.com/example/repo/pull/1');
  assert.ok(calls.findIndex(args => args.includes('commit')) < calls.findIndex(args => args[0] === 'rev-list'));
  assert.deepEqual(calls.find(args => args[0] === 'push'), ['push', '-u', 'origin', 'quota-sweep/test']);
  assert.ok(logs.some(message => message.includes('preserved final uncommitted work')));
});
test('runSweep は終了時の救済失敗をログに残し outcome を変えない', async t => {
  const ctx = context(t, async () => ({ code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }));
  const logs = [], calls = [];
  ctx.log = message => logs.push(message);
  ctx.command = (_exe, args) => {
    calls.push(args);
    if (args[0] === 'branch') return 'quota-sweep/test';
    if (args[0] === 'status') return ' M tools/work.mjs';
    if (args.includes('commit')) throw new Error('commit failed');
    if (args[0] === 'rev-list') return '0';
    return '';
  };
  await runSweep(decision, ctx);
  assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'final');
  assert.ok(logs.some(message => message.includes('final dirty-tree preservation failed: commit failed')));
  assert.equal(calls.some(args => args[0] === 'push'), false);
});
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
test('失敗した tick の理由と failureKey は executor-usage にも残す（no_output と誤診させない）', async t => {
  const ctx = context(t, async () => ({ code: 1, stdout: '', stderr: "EPERM: operation not permitted, open '.git'" }));
  await runSweep(decision, ctx);
  const rows = fs.readFileSync(path.join(ctx.home, '.claude/executor-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.length >= 1);
  for (const usage of rows) {
    assert.equal(usage.provider, 'quota-sweep:claude');
    assert.equal(usage.status, 'failed');
    assert.match(usage.reason, /child exit=1/);
    assert.match(usage.reason, /EPERM/);
    assert.equal(usage.failureKey, 'child-1');
  }
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
// 2026-10-23T07:10Z/07:25Z 実測: 直前に窓が読めていたのに1回の読み取り失敗で ticks=0 failed になった。
test('利用窓の一時的な読み取り失敗は1回読み直して続行する', async t => {
  let reads = 0, calls = 0;
  const ctx = context(t, async () => { calls++; return { code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }; });
  ctx.windows = async () => (++reads === 1 ? Object.assign([], { reasons: { claude: 'HTTP 429' } }) : windows);
  await runSweep(decision, ctx);
  const row = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/quota-sweep.jsonl'), 'utf8').trim());
  assert.equal(row.outcome, 'final'); assert.ok(reads >= 2); assert.ok(calls >= 1);
});
test('利用窓の一時的な読み取り失敗が続く場合は理由付きで failed にする', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; });
  ctx.windows = async () => Object.assign([], { reasons: { claude: 'HTTP 503' } });
  await runSweep(decision, ctx);
  const row = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/quota-sweep.jsonl'), 'utf8').trim());
  assert.equal(row.outcome, 'failed'); assert.equal(row.failureKey, 'window-info');
  assert.match(row.reason, /HTTP 503/); assert.equal(calls, 0);
  const usage = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/executor-usage.jsonl'), 'utf8').trim());
  assert.match(usage.reason, /HTTP 503/);
});
test('一時障害の判定は 429/5xx/network だけで、認証・形式不一致は再試行しない', () => {
  for (const reason of ['HTTP 429', 'HTTP 503', 'HTTP 408', 'network: TimeoutError']) assert.equal(isTransientWindowReadError(reason), true);
  for (const reason of ['HTTP 401', 'HTTP 403', 'accessToken 未設定', 'credentials: ENOENT', 'usage response の形式が未対応', '', undefined]) assert.equal(isTransientWindowReadError(reason), false);
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
  assert.equal(commands.some(c => c.includes('commit') || c[1] === 'add'), false);
});

test('reset jitter across a minute boundary keeps one identity', () => {
  const base = Date.UTC(2026, 9, 21, 2, 0, 0);
  assert.equal(resetKey(base - 400), base);           // 01:59:59.6 → 02:00:00
  assert.equal(resetKey(base + 192), base);           // 実測の 15:00:00.192Z
  assert.equal(sameReset(base - 1500, base), true);   // floor-to-second では別キーになっていた差分
  assert.equal(sameReset(base + 5 * minute, base), false);
});

test('minute-boundary jitter during a run does not abort an eligible tick', async t => {
  let calls = 0; const ctx = context(t, async () => { calls++; return { code: 0, stdout: JSON.stringify({ result: 'FINAL' }) }; });
  // 2026-10-21 10:29 JST の実測: decision=02:00:00.000Z, 再読で 01:59:59.x に揺れた
  ctx.windows = async () => windows.map(w => w.window === '5h' ? { ...w, resetsAt: w.resetsAt - 1500 } : w);
  await runSweep(decision, ctx);
  assert.equal(calls, 2); assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'final');
});

test('unused window without resets_at does not block the resetting window', () => {
  const at = now;
  const idle5h = { provider: 'claude', window: '5h', usedPercent: 0, resetsAt: null };
  const weekly = { provider: 'claude', window: '7d', usedPercent: 40, resetsAt: at + 60 * minute };
  const decisions = decideSweep({ windows: [idle5h, weekly], now: at });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].window, '7d');
  assert.equal(decisions[0].resetsAt, resetKey(weekly.resetsAt));
  // Unknown usage (non-finite reset with consumption) stays conservative.
  assert.equal(decideSweep({ windows: [{ ...idle5h, usedPercent: 30 }, weekly], now: at }).length, 0);
});

test('empty and completed goals never start work or send DM', async t => {
  for (const goal of ['', 'なし（完了）', 'なし', 'none (done)', '完了']) {
    const ctx = context(t, () => assert.fail('child started'));
    fs.writeFileSync(path.join(ctx.home, '.claude/quota-sweep-goals.md'), goal ? `- [ ] ${goal}\n` : '');
    fs.writeFileSync(path.join(ctx.home, '.claude/next-session.md'), `## 残TODO\n1. ${goal}\n`);
    ctx.prepareTree = () => assert.fail('prepared'); ctx.notify = () => assert.fail('DM');
    await runSweep(decision, ctx);
    assert.equal(ctx.state.lastRun.claude[decision.resetsAt].outcome, 'no-goal');
  }
});
test('fetch and push get a longer timeout and exactly one retry', () => {
  for (const verb of ['fetch', 'push', 'status']) {
    let calls = 0;
    const run = commandRunner((_exe, _args, options) => {
      calls++; assert.equal(options.timeout, verb === 'status' ? 120_000 : 300_000);
      return { error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null };
    });
    assert.throws(() => run('git', [verb], '/tmp'), new RegExp(`git ${verb}:.*ETIMEDOUT`));
    assert.equal(calls, verb === 'status' ? 1 : 2);
  }
  let calls = 0;
  assert.equal(commandRunner(() => ++calls === 1 ? { status: 1 } : { status: 0, stdout: 'ok' })('git', ['fetch']), 'ok');
});
test('filtering current windows keeps provider read reasons', () => {
  const all = Object.assign([{ provider: 'claude', window: '5h', usedPercent: 0, resetsAt: null }, { provider: 'codex', observedAt: 2, window: 'primary' }], { reasons: { claude: 'HTTP 401', codex: null } });
  const filtered = filterWindowsForCurrentAuth(all, { codexAuthChangedAt: 1 });
  assert.deepEqual([...filtered], [{ provider: 'claude', window: '5h', usedPercent: 0, resetsAt: null }, { provider: 'codex', observedAt: 2, window: 'primary' }]);
  assert.deepEqual(filtered.reasons, { claude: 'HTTP 401', codex: null });
});
test('window-info failure records why the window read was empty', async t => {
  const ctx = context(t, () => assert.fail('child started'));
  ctx.windows = async () => Object.assign([], { reasons: { claude: 'HTTP 401', codex: null } });
  await runSweep(decision, ctx);
  const row = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/quota-sweep.jsonl')));
  assert.equal(row.outcome, 'failed');
  assert.equal(row.failureKey, 'window-info');
  assert.match(row.reason, /HTTP 401/);
});
test('check failures and exceptions survive in ledger and DM', async t => {
  for (const kind of ['window-info', 'interactive-active', 'monitor-error', 'prepare']) {
    const ctx = context(t, () => assert.fail('child started')); let dm;
    if (kind === 'window-info') ctx.windows = async () => [];
    if (kind === 'interactive-active') ctx.active = async () => true;
    if (kind === 'monitor-error') ctx.windows = async () => { throw new Error('usage offline'); };
    if (kind === 'prepare') ctx.prepareTree = () => { throw new Error('git fetch timed out'); };
    ctx.notify = async text => { dm = text; };
    await runSweep(decision, ctx);
    const row = JSON.parse(fs.readFileSync(path.join(ctx.home, '.claude/quota-sweep.jsonl')));
    assert.equal(row.outcome, 'failed'); assert.ok(row.reason); assert.ok(row.failureKey);
    assert.ok(dm.includes(row.reason));
  }
});
test('PR with failed child is partial, retaining exit reason', async t => {
  const ctx = context(t, async () => ({ code: 1, stderr: 'model unavailable' })); let dm;
  ctx.command = (_exe, args) => args[0] === 'branch' ? 'quota-sweep/test' : args[0] === 'rev-list' ? '1' : args[0] === 'pr' ? 'https://github.com/example/repo/pull/1' : '';
  ctx.notify = async text => { dm = text; };
  await runSweep(decision, ctx);
  const row = ctx.state.lastRun.claude[decision.resetsAt];
  assert.equal(row.outcome, 'partial'); assert.equal(row.stopOutcome, 'failed');
  assert.match(row.reason, /model unavailable/); assert.match(dm, /成果あり・未完了/);
});
test('delivery error retains original stop reason and is recorded', async t => {
  const ctx = context(t, async () => ({ code: 1, timedOut: true, stopReason: 'deadline', stderr: 'child timeout' }));
  ctx.command = (_exe, args) => {
    if (args[0] === 'branch') return 'quota-sweep/test';
    if (args[0] === 'rev-list') return '1';
    throw new Error('push timeout');
  };
  await runSweep(decision, ctx);
  const row = ctx.state.lastRun.claude[decision.resetsAt];
  assert.equal(row.outcome, 'failed'); assert.match(row.reason, /child timeout.*push timeout/);
  assert.equal(row.deliveryError, 'push timeout');
});
test('repeated cause enqueues one existing handoff task across reset windows', t => {
  const home = temp(t); fs.mkdirSync(path.join(home, '.claude'));
  const state = {}, file = path.join(home, '.claude/next-session.md');
  const row = { provider: 'claude', failureKey: 'git-fetch-ETIMEDOUT', reason: 'timeout' };
  queueRepeatedFailure(home, state, row); assert.equal(fs.existsSync(file), false);
  queueRepeatedFailure(home, state, row);
  const text = fs.readFileSync(file, 'utf8'); assert.match(text, /handoff-audit:/);
  queueRepeatedFailure(home, state, { ...row, reason: 'different timestamp' });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  queueRepeatedFailure(home, state, { ...row, failureKey: null });
  assert.equal(state.failureStreaks.claude.count, 0);
});
test('persistent EPERM on opening pointer recovers through replacement', t => {
  const file = path.join(temp(t), '.git'); fs.writeFileSync(file, 'gitdir: /absolute\n');
  writeWorktreePointer(file, 'gitdir: ../relative\n', {
    writeFile: (target, ...args) => { if (target === file) throw Object.assign(new Error('locked open'), { code: 'EPERM' }); return fs.writeFileSync(target, ...args); }, chmod: () => {}
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'gitdir: ../relative\n');
});
test('relative pointer is not rewritten', t => {
  const home = temp(t), tree = path.join(home, '.claude/quota-sweep-repo'); fs.mkdirSync(tree, { recursive: true });
  prepareTree({ home, provider: 'claude', run: (_exe, args) => args[0] === 'status' ? '' : 'base', io: {
    readFile: () => 'gitdir: ../nightly-repo/.git/worktrees/sweep\n', writeFile: () => assert.fail('rewrote relative pointer')
  } });
});
