import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { dispatch, matches, mergeResults, acquireLoadLease } from './hook-dispatch.mjs';
import { collapseHooks, repositoryHooks, describeHook, EVENTS, dispatcherProblems, runtimeManifestPath, effectiveHooks } from './hook-dispatch-registry.mjs';
import { summarizeDispatchMetrics, checkDispatchBudget, readDispatchMetrics } from './hook-budget-check.mjs';
import { discoverGates } from './gate-contracts.mjs';

const repo = path.resolve('.');
// Loaded Windows hosts can spend several seconds starting workers/scheduling
// timers. Keep wall-clock bounds coarse; timeout counts and reasons below
// verify deadline behavior independently of that overhead.
const timingSlackMs = 8000;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-dispatch-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function script(home, name, body, extra = {}) {
  const file = path.join(home, `${name}.mjs`);
  fs.writeFileSync(file, body);
  return { ...describeHook({ type: 'command', command: `node "${file}"`, timeout: 5 }), critical: false, ...extra };
}
const output = specific => ({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...specific } }) });

test('manifest-based registration retains exit-code and helper-based gates in the contract inventory', () => {
  const gates = discoverGates();
  for (const name of ['askuser-selfcheck-gate', 'verify-before-done-detector']) assert.ok(gates.includes(name), name);
});

test('matchers are anchored and select the event-specific input', () => {
  assert.equal(matches('*', 'PreToolUse', {}), true);
  assert.equal(matches('Bash|PowerShell', 'PreToolUse', { tool_name: 'Bash' }), true);
  assert.equal(matches('Bash', 'PreToolUse', { tool_name: 'MyBash' }), false);
  assert.equal(matches('mcp__Gmail(?:_\\d+)?__send', 'PreToolUse', { tool_name: 'mcp__Gmail_2__send' }), true);
  assert.equal(matches('startup|resume', 'SessionStart', { source: 'resume' }), true);
  assert.equal(matches('permission_prompt', 'Notification', { notification_type: 'permission_prompt' }), true);
  assert.equal(matches('[', 'PreToolUse', { tool_name: 'Bash' }), false);
});
test('deny beats allow/ask, combines reasons and contexts; Stop combines block/systemMessage', () => {
  const merged = mergeResults('PreToolUse', [output({ permissionDecision: 'allow' }), output({ permissionDecision: 'deny', permissionDecisionReason: 'first', additionalContext: 'a' }), output({ permissionDecision: 'deny', permissionDecisionReason: 'second', additionalContext: 'b' })]);
  assert.deepEqual(merged.payload.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'first\nsecond', additionalContext: 'a\nb' });
  const stop = mergeResults('Stop', [{ status: 0, stdout: JSON.stringify({ decision: 'block', reason: 'one', systemMessage: 'hello' }) }, { status: 2, stderr: 'two' }, { status: 0, stdout: JSON.stringify({ systemMessage: 'world' }) }]);
  assert.deepEqual(stop.payload, { decision: 'block', reason: 'one\ntwo', systemMessage: 'hello\nworld' });
  assert.equal(mergeResults('PreToolUse', [{ status: 2, stderr: 'legacy' }]).payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(mergeResults('SessionEnd', [{ status: 2, stderr: 'legacy' }]).status, 2);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    assert.equal(mergeResults(event, [output({ additionalContext: 'a' }), output({ additionalContext: 'b' })]).payload.hookSpecificOutput.additionalContext, 'a\nb');
  }
});
test('SessionStart emits sessionTitle without additionalContext', () => {
  const merged = mergeResults('SessionStart', [output({ sessionTitle: '999｜待機中' })]);
  assert.deepEqual(JSON.parse(merged.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: '999｜待機中' } });
});
test('UserPromptSubmit combines additionalContext and the last valid successful sessionTitle', () => {
  const merged = mergeResults('UserPromptSubmit', [output({ additionalContext: 'context' }), output({ sessionTitle: 'first' }), output({ sessionTitle: '999｜待機中' }),
    ...['', '   ', null, 123].map(sessionTitle => output({ sessionTitle })),
    { ...output({ sessionTitle: 'failed' }), status: 1 }, { ...output({ sessionTitle: 'blocked' }), status: 2, stderr: 'blocked' }]);
  assert.deepEqual(JSON.parse(merged.stdout), { decision: 'block', reason: 'blocked', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'context', sessionTitle: '999｜待機中' } });
});
test('Stop and PreToolUse do not emit sessionTitle', () => {
  for (const event of ['Stop', 'PreToolUse']) {
    assert.equal(mergeResults(event, [output({ sessionTitle: '999｜待機中' })]).stdout, '');
  }
});
test('a synchronous infinite loop is terminated without losing another hook result; same OS pid', async t => {
  const home = fixture(t);
  const slow = script(home, 'slow', 'export async function hookMain() { while (true) {} }', { timeout: 3 });
  const fast = script(home, 'fast', `export async function hookMain(raw) { console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:String(process.pid)}})); }`);
  const result = await dispatch('PreToolUse', '{}', { home, overloaded: false, manifest: { events: { PreToolUse: [slow, fast] } } });
  assert.equal(result.metrics.timedOut, 1);
  assert.equal(result.payload.hookSpecificOutput.additionalContext, String(process.pid));
  assert.ok(result.metrics.durationMs < slow.timeout * 1000 + timingSlackMs);
  assert.equal(result.results[0].stdout, '');
  assert.equal((await readDispatchMetrics(home)).length, 1);
});
test('load shedding skips informational hooks, keeps billing/contract gates and logs skipped hooks', async t => {
  const home = fixture(t);
  const info = script(home, 'info', `export async function hookMain() { throw new Error('must not run'); }`);
  const gate = script(home, 'gate', `export async function hookMain() { console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'protected'}})); }`, { critical: true });
  const result = await dispatch('PreToolUse', '{}', { home, overloaded: true, manifest: { events: { PreToolUse: [info, gate] } } });
  assert.equal(result.metrics.skipped, 1);
  assert.equal(result.metrics.hooks[0].skipped, 'load-shed');
  assert.equal(result.payload.hookSpecificOutput.permissionDecision, 'deny');
  const manifest = collapseHooks(repositoryHooks(repo, home), repo).manifest;
  for (const name of ['api-billing-guard.mjs', 'exec-tree-edit-guard.mjs', 'app-llm-cost-gate.mjs']) assert.equal(manifest.events.PreToolUse.find(h => h.name === name).critical, true);
});
test('cheap load detection counts leases, expires stale leases and handles low memory', t => {
  const home = fixture(t), leases = [];
  t.after(() => leases.forEach(l => l.release()));
  for (let i = 0; i < 5; i++) leases.push(acquireLoadLease(home, { free: 8e9, total: 16e9 }));
  assert.equal(leases[3].overloaded, false);
  assert.equal(leases[4].overloaded, true);
  leases.forEach(l => l.release());
  const low = acquireLoadLease(home, { free: 1e8, total: 16e9 });
  assert.equal(low.overloaded, true); low.release();
  const dir = path.join(home, '.claude/hook-metrics/active'), file = path.join(dir, 'stale.lock');
  fs.writeFileSync(file, '0'); fs.utimesSync(file, new Date(0), new Date(0));
  const fresh = acquireLoadLease(home, { free: 8e9, total: 16e9 });
  assert.equal(fresh.active, 1); assert.equal(fs.existsSync(file), false); fresh.release();
});
test('registration converges twice byte-identically, preserves custom/async hooks, detects fanout regression', t => {
  const home = fixture(t), dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ language: 'japanese', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'pwsh -NoProfile -File "C:\\custom.ps1"', timeout: 2 }] }], Stop: [{ hooks: [{ type: 'command', command: 'custom-async', async: true }] }] } }));
  const run = () => execFileSync(process.execPath, ['tools/register-hooks.mjs', '--hooks-only'], { env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo }, encoding: 'utf8' });
  run(); const first = fs.readFileSync(file, 'utf8'), manifest = fs.readFileSync(runtimeManifestPath(home), 'utf8');
  run(); assert.equal(fs.readFileSync(file, 'utf8'), first); assert.equal(fs.readFileSync(runtimeManifestPath(home), 'utf8'), manifest);
  const settings = JSON.parse(first);
  assert.deepEqual(dispatcherProblems(settings, repo), []);
  for (const event of EVENTS) assert.equal(settings.hooks[event].flatMap(g => g.hooks).filter(h => h.async !== true).length, 1);
  assert.equal(settings.hooks.Stop.flatMap(g => g.hooks).filter(h => h.command === 'custom-async').length, 1);
  assert.ok(JSON.parse(manifest).events.PreToolUse.some(h => h.command.includes('custom.ps1') && h.matcher === 'Bash'));
  settings.hooks.PreToolUse.push({ hooks: [{ command: 'node old-hook.mjs' }] });
  assert.deepEqual(dispatcherProblems(settings, repo), ['PreToolUse']);
  delete settings.hooks.Stop;
  assert.deepEqual(dispatcherProblems(settings, repo), ['PreToolUse', 'Stop']);
});
test('Bash PreToolUse executes real repository hooks with zero node child processes', async t => {
  const home = fixture(t), env = { ...process.env, ORGIAST_HOME: home, HOME: home, USERPROFILE: home, CLAUDE_HEADLESS: '' };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const old = repositoryHooks(repo, home);
  const matching = old.PreToolUse.filter(g => matches(g.matcher, 'PreToolUse', { tool_name: 'Bash' })).flatMap(g => g.hooks);
  const before = matching.length + matching.filter(h => h.command.includes('gate-hook-runner.mjs')).length;
  const result = await dispatch('PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo dispatcher-probe' }, session_id: 'process-probe' }), { home, env, overloaded: false, manifest: collapseHooks(old, repo).manifest });
  assert.equal(result.metrics.childProcesses, 0);
  assert.equal(result.metrics.timedOut, 0, JSON.stringify(result.metrics));
  assert.ok(result.results.every(r => r.status === 0), JSON.stringify(result.results));
  assert.equal(result.metrics.hooks.length, matching.length);
  assert.ok(before > 30);
  t.diagnostic(`Bash PreToolUse: legacy node launches=${before}, dispatcher node launches=1, child processes=${result.metrics.childProcesses}, hooks=${matching.length}, durationMs=${result.metrics.durationMs}`);
});
test('all event rolling-hour budgets and midnight rotation; alert once per day even concurrently', async t => {
  const home = fixture(t), now = Date.parse('2026-11-04T00:10:00Z');
  const records = EVENTS.map(event => ({ at: new Date(now - 20 * 60000).toISOString(), event, durationMs: 3500, timedOut: 51, hooks: [{ durationMs: 3500 }] }));
  const summary = summarizeDispatchMetrics(records, { now });
  for (const event of EVENTS) { assert.equal(summary.events[event].truncationsPerHour, 51); assert.equal(summary.events[event].averageHookMsPerCall, 3500); }
  assert.equal(summarizeDispatchMetrics(records, { now: now + 3600000 }).over, false);
  const dir = path.join(home, '.claude/hook-metrics'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-11-03.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n{partial');
  assert.equal((await readDispatchMetrics(home, now)).length, EVENTS.length);
  let count = 0;
  const notify = async (_home, options) => { count++; assert.match(options.text, /PreToolUse/); return { id: 'test-alert' }; };
  await Promise.all([checkDispatchBudget(home, { now, notify }), checkDispatchBudget(home, { now, notify })]);
  assert.equal(count, 1);
});

test('external PowerShell commands are capped at four children; direct fd output stays inside the merge', async t => {
  const home = fixture(t);
  // Use a local executable named pwsh to test scheduling without a Windows host.
  // Its stdin/output protocol is the same as a PowerShell command hook.
  const executable = path.join(home, 'pwsh');
  if (process.platform === 'win32') { t.skip('POSIX executable fixture; Windows runner covered by platform tests'); return; }
  fs.writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'external'}})), 100);\n`, { mode: 0o755 });
  const external = Array.from({ length: 9 }, (_, i) => ({ name: `pwsh-${i}`, command: `"${executable}"`, matcher: '*', timeout: 8, critical: true, node: false }));
  let active = 0, peak = 0, count = 0;
  const out = await dispatch('PreToolUse', '{}', { home, overloaded: false, concurrency: 100, manifest: { events: { PreToolUse: external } }, onSpawn(child) { active++; count++; peak = Math.max(peak, active); child.once('close', () => active--); } });
  assert.equal(count, 9); assert.equal(out.metrics.childProcesses, 9); assert.ok(peak <= 4); assert.equal(out.metrics.timedOut, 0);
  assert.equal(out.payload.hookSpecificOutput.additionalContext.split('\n').length, 9);
  const direct = script(home, 'direct-fd', `import fs from 'node:fs'; export async function hookMain() { fs.writeSync(1, JSON.stringify({systemMessage:'fd captured'})); }`);
  const captured = await dispatch('Stop', '{}', { home, overloaded: false, manifest: { events: { Stop: [direct] } } });
  assert.equal(captured.payload.systemMessage, 'fd captured');
});

test('dispatcher applies gate rollout in-process and the registrar never wraps the dispatcher', async t => {
  const home = fixture(t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const { wrapRegisteredGates } = await import('./gate-hook-runner.mjs');
  const settings = { hooks: collapseHooks(repositoryHooks(repo, home), repo).hooks };
  const before = JSON.stringify(settings);
  assert.equal(wrapRegisteredGates(settings, repo), 0);
  assert.equal(JSON.stringify(settings), before);
  const gate = script(home, 'unreleased', `export const GATE_CONTRACT = {"name":"unreleased-dispatch-test","remedies":[{"kind":"command","ref":"node --version"}]};\nexport async function hookMain() { console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'observe me',additionalContext:'original'}})); }`, { policy: true, critical: true, timeout: 5 });
  const out = await dispatch('PreToolUse', '{}', { home, env: { ...process.env, ORGIAST_HOME: home, HOME: home, USERPROFILE: home }, overloaded: false, manifest: { events: { PreToolUse: [gate] } } });
  assert.equal(out.payload.hookSpecificOutput.permissionDecision, undefined);
  assert.match(out.payload.hookSpecificOutput.additionalContext, /original\n.*gate warn.*observe me/);
  assert.equal(out.metrics.childProcesses, 0);
});

test('native synchronous child waits obey the hook deadline too', async t => {
  const home = fixture(t);
  const slow = script(home, 'native-wait', `import {spawnSync} from 'node:child_process'; export async function hookMain() { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60000)']); }`, { timeout: 3 });
  const out = await dispatch('PreToolUse', '{}', { home, overloaded: false, manifest: { events: { PreToolUse: [slow] } } });
  assert.equal(out.metrics.timedOut, 1);
  assert.equal(out.metrics.childProcesses, 1);
  assert.ok(out.metrics.durationMs < slow.timeout * 1000 + timingSlackMs);
});

test('invalid stdin is silent and never executes a hook', async t => {
  const home = fixture(t);
  for (const raw of ['', '{bad', 'null', '[]']) {
    const out = await dispatch('PreToolUse', raw, { home, execute() { assert.fail('invalid input must not execute'); } });
    assert.equal(out.status, 0); assert.equal(out.stdout, ''); assert.equal(out.metrics.inputError, 'invalid-json');
  }
});

test('re-expansion preserves mixed-group custom hooks and expands duplicate dispatchers only once', () => {
  const custom = { type: 'command', command: 'custom-command' };
  const asynchronous = { type: 'command', command: 'async-command', async: true };
  const collapsed = collapseHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [custom] }] }, repo);
  const group = collapsed.hooks.PreToolUse[0];
  const expanded = effectiveHooks({ hooks: { PreToolUse: [group, { ...group, hooks: [...group.hooks, asynchronous] }] } }, collapsed.manifest);
  const hooks = expanded.PreToolUse.flatMap(g => g.hooks);
  assert.equal(hooks.filter(h => h.command === 'custom-command').length, 1);
  assert.equal(hooks.filter(h => h.command === 'async-command').length, 1);
  assert.deepEqual(dispatcherProblems({ hooks: collapseHooks(expanded, repo).hooks }, repo), []);
});

test('selfcheck actually repairs a missing dispatcher and resurrected individual hooks', t => {
  const home = fixture(t), env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  const file = path.join(home, '.claude/settings.json');
  execFileSync(process.execPath, ['tools/register-hooks.mjs', '--hooks-only'], { env, stdio: 'pipe' });
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete settings.hooks.Stop;
  settings.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'custom-sync', timeout: 3 });
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${path.join(repo, 'tools/api-billing-guard.mjs')}"` }] });
  fs.writeFileSync(file, JSON.stringify(settings));
  execFileSync(process.execPath, ['tools/hook-selfcheck.mjs'], { env, stdio: 'pipe', timeout: 30000 });
  assert.deepEqual(dispatcherProblems(JSON.parse(fs.readFileSync(file, 'utf8')), repo), []);
  const manifest = JSON.parse(fs.readFileSync(runtimeManifestPath(home), 'utf8'));
  assert.equal(manifest.events.PreToolUse.filter(h => h.name === 'api-billing-guard.mjs').length, 1);
  assert.equal(manifest.events.PreToolUse.filter(h => h.command === 'custom-sync').length, 1);
});

test('gate policy retries in-process with a fresh stdin stream and retains the successful result', async t => {
  const { createServer } = await import('node:http');
  const home = fixture(t);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/example.env'), 'LOCAL_ONLY=keep\n');
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ files: { 'example.env': 'KEY=mock-value\n' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const contract = { name: 'dispatch-retry-test', remedies: [{ kind: 'keyserve-key', ref: 'example.env#KEY' }] };
  const gate = script(home, 'retry-stream', `export const GATE_CONTRACT = ${JSON.stringify(contract)};
import fs from 'node:fs';
export async function hookMain() {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  fs.appendFileSync(process.env.ORGIAST_HOME + '/inputs.jsonl', raw + '\\n');
  const ready = fs.readFileSync(process.env.ORGIAST_HOME + '/.claude/example.env', 'utf8').includes('KEY=');
  console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse', ...(ready
    ? {additionalContext:input.session_id} : {permissionDecision:'deny',permissionDecisionReason:'key missing'})}}));
}`, { policy: true, critical: true, timeout: 15 });
  const env = { ...process.env, ORGIAST_HOME: home, HOME: home, USERPROFILE: home,
    ORGIAST_KEYSERVE_URL: `http://127.0.0.1:${server.address().port}`, ORGIAST_KEYSERVE_SECRET: 'test-secret' };
  const spawns = [];
  const result = await dispatch('PreToolUse', JSON.stringify({ session_id: 'same-input', tool_name: 'Bash' }), {
    home, env, overloaded: false, manifest: { events: { PreToolUse: [gate] } }, onWorkerSpawn(child) { spawns.push(child); },
  });
  assert.equal(requests, 1);
  assert.equal(result.metrics.timedOut, 0);
  // The existing key provisioner may inspect git; neither gate evaluation starts
  // another Node process. The metrics must still count the provisioner's helper.
  assert.equal(result.metrics.childProcesses, spawns.length);
  assert.ok(spawns.every(child => child.executable === 'git'), JSON.stringify(spawns));
  assert.equal(result.payload.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(result.payload.hookSpecificOutput.additionalContext, 'same-input\n[gate warn: dispatch-retry-test] same-input');
  const inputs = fs.readFileSync(path.join(home, 'inputs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(inputs.length, 2); assert.equal(inputs[0], inputs[1]);
});


for (const method of ['spawnSync', 'execSync', 'execFileSync']) {
  test(`${method} reports deadline expiry before completion, but preserves a shorter local timeout`, async t => {
    const home = fixture(t);
    for (const localTimeout of [false, true]) {
      const args = method === 'execSync'
        ? '`"${process.execPath}" -e "setTimeout(()=>{},60000)"`'
        : "process.execPath, ['-e', 'setTimeout(()=>{},60000)']";
      const hook = script(home, `deadline-${method}-${localTimeout}`, `
import { ${method} } from 'node:child_process';
export async function hookMain() {
  try { ${method}(${args}, ${localTimeout ? '{ timeout: 30 }' : '{}'}); } catch {}
  console.log(JSON.stringify({ decision: 'block', reason: 'discard on deadline' }));
}`);
      const messages = [];
      // No parent timer: verify the native wait itself reports the deadline on
      // every platform, even when the hook catches an execSync exception.
      const deadlineMs = localTimeout ? 15000 : 2000;
      const started = Date.now();
      const worker = new Worker(new URL('./hook-dispatch-worker.mjs', import.meta.url), {
        workerData: { hook, raw: '{}', deadline: started + deadlineMs },
        stdout: true, stderr: true, execArgv: [],
      });
      t.after(() => worker.terminate());
      worker.on('message', message => messages.push(message));
      await new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
      const elapsedMs = Date.now() - started;
      assert.equal(messages.some(message => message.deadlineHit), !localTimeout);
      if (localTimeout) {
        // Startup is included, but the 30 ms local timeout must finish well
        // before the worker deadline, even on a heavily loaded Windows host.
        assert.ok(elapsedMs < deadlineMs - timingSlackMs, `local timeout took ${elapsedMs} ms`);
      } else {
        assert.ok(elapsedMs < deadlineMs + timingSlackMs, `deadline took ${elapsedMs} ms`);
      }
      assert.ok(messages.some(message => message.result));
      if (!localTimeout) assert.ok(messages.findIndex(message => message.deadlineHit) < messages.findIndex(message => message.result));
    }
  });
}

test('22 hooks reuse a bounded pool; critical gates retain a full budget after queueing', async t => {
  const home = fixture(t);
  const hooks = Array.from({ length: 22 }, (_, i) => script(home, `pooled-${i}`, `
import {threadId} from 'node:worker_threads';
export async function hookMain() {
  await new Promise(resolve => setTimeout(resolve, 600));
  console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',
    permissionDecision:'deny',permissionDecisionReason:'gate-${i}',additionalContext:String(threadId)}}));
}`, { critical: i >= 2, timeout: 3 }));
  let created = 0;
  const out = await dispatch('PreToolUse', '{}', { home, concurrency: 2, overloaded: false,
    manifest: { events: { PreToolUse: hooks } }, onWorkerCreated() { created++; } });
  assert.equal(out.metrics.timedOut, 0, JSON.stringify(out.metrics));
  assert.equal(out.metrics.skipped, 0);
  assert.equal(created, 2); assert.equal(out.metrics.workersCreated, 2);
  assert.equal(out.results.length, 22);
  assert.ok(out.results.every(r => r.status === 0));
  assert.ok(out.results[21].queueMs >= hooks[21].timeout * 1000 + 2000, 'last critical gate waited at least two seconds beyond its own timeout');
  assert.ok(out.results[0].queueMs >= out.results[21].queueMs, 'informational work waits behind critical gates');
  assert.equal(out.payload.hookSpecificOutput.permissionDecisionReason.split('\n').length, 22);
  assert.equal(new Set(out.payload.hookSpecificOutput.additionalContext.split('\n')).size, 2);
  assert.equal(out.metrics.childProcesses, 0);
});

test('reused worker isolates argv, stdin, output, exitCode and env; drains legacy async work', async t => {
  const home = fixture(t);
  const first = script(home, 'dirty-worker', `
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
process.env.POOL_LEAK = 'bad';
void delay(150, null, { ref: false }).then(() => { process.exitCode = 2; process.env.POOL_LEAK = 'late'; });
process.once('beforeExit', () => console.log(JSON.stringify({decision:'block',reason:'before-exit denial'})));
setTimeout(() => { fs.writeSync(2, 'first-denial'); process.exitCode = 2; }, 50);
setTimeout(() => { console.log('late-output'); process.exitCode = 2; }, 150).unref();
`);
  const second = script(home, 'clean-worker', `
import fs from 'node:fs';
export async function hookMain() {
  await new Promise(resolve => setTimeout(resolve, 200));
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify({systemMessage:JSON.stringify({arg:process.argv[2],env:process.env.POOL_LEAK ?? null,status:process.exitCode,session:input.session_id})}));
}`, { args: ['second'] });
  const out = await dispatch('Stop', JSON.stringify({ session_id: 'fresh-input' }), { home, concurrency: 1, overloaded: false,
    env: { ...process.env, POOL_LEAK: '' }, manifest: { events: { Stop: [first, second] } } });
  assert.equal(out.metrics.workersCreated, 1);
  assert.equal(out.results[0].status, 2); assert.equal(out.results[0].stderr, 'first-denial');
  assert.deepEqual(JSON.parse(out.results[0].stdout), { decision: 'block', reason: 'before-exit denial' });
  assert.equal(out.results[1].status, 0);
  assert.deepEqual(JSON.parse(out.payload.systemMessage), { arg: 'second', env: '', status: 0, session: 'fresh-input' });
  assert.doesNotMatch(out.results[1].stdout, /late-output/);
});

test('a timed-out kim-inbox gate with a completed context still reaches mergeResults', async t => {
  const home = fixture(t);
  const inbox = script(home, 'kim-inbox-probe', `
import { spawnSync } from 'node:child_process';
export async function hookMain() {
  console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'KIM-READY'}}));
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { windowsHide: true });
}`, { name: 'kim-inbox.mjs', critical: true, timeout: 1 });
  const out = await dispatch('PreToolUse', '{}', { home, concurrency: 1, overloaded: false, manifest: { events: { PreToolUse: [inbox] } } });
  // The context is delivered despite the stall; only the unfinished reason is recorded.
  assert.equal(out.metrics.timedOut, 1);
  assert.equal(out.metrics.skipped, 0);
  assert.equal(out.metrics.workersCreated, 1);
  assert.deepEqual(out.metrics.hooks.map(h => h.criticalUnfinished), ['hook-timeout']);
  assert.match(out.results[0].stdout, /KIM-READY/);
  assert.equal(out.payload.hookSpecificOutput.additionalContext, 'KIM-READY');
});

test('global budget and exhausted workers pass critical gates and record unfinished reasons', async t => {
  const home = fixture(t);
  const slow = script(home, 'pool-hang', 'export async function hookMain() { while (true) {} }', { critical: true, timeout: 5 });
  const gate = script(home, 'queued-deny', `export async function hookMain() { console.log(JSON.stringify({decision:'block',reason:'deny'})); }`, { critical: true });
  for (const budgetMs of [3000, 15000]) {
    const out = await dispatch('PreToolUse', '{}', { home, concurrency: 1, budgetMs, overloaded: false,
      manifest: { events: { PreToolUse: [slow, gate] } } });
    assert.equal(out.metrics.workersCreated, 1);
    assert.equal(out.status, 0); assert.equal(out.stdout, '');
    assert.deepEqual(out.metrics.hooks.map(h => h.criticalUnfinished),
      ['hook-timeout', budgetMs === 3000 ? 'dispatch-budget' : 'hook-error']);
    assert.equal(out.metrics.timedOut, 1);
    assert.ok(out.results.every(r => r.status === 0));
    assert.ok(out.metrics.durationMs < Math.min(budgetMs, slow.timeout * 1000) + timingSlackMs);
  }
});

test('an event-limited timeout exhausts the budget even before the wall-clock deadline', async t => {
  const home = fixture(t);
  const hook = script(home, 'early-budget-timeout', 'export async function hookMain() {}', { critical: true, timeout: 60 });
  let calls = 0;
  const out = await dispatch('PreToolUse', '{}', { home, budgetMs: 30000, overloaded: false, concurrency: 1,
    manifest: { events: { PreToolUse: [hook, hook] } },
    async execute(_hook, _raw, timeout) {
      calls++;
      assert.ok(timeout > 0 && timeout <= 30000);
      return { status: 0, timedOut: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(out.stdout, '');
  assert.equal(out.metrics.timedOut, 1);
  assert.deepEqual(out.metrics.hooks.map(h => h.criticalUnfinished), ['hook-timeout', 'dispatch-budget']);
});

test('settings dispatcher timeout bounds the whole event and reports unstarted critical gates', async t => {
  const home = fixture(t);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ command: `node "${path.join(repo, 'tools/hook-dispatch.mjs')}" PreToolUse`, timeout: 3 }] }],
  } }));
  const hook = script(home, 'budget-probe', 'export async function hookMain() {}', { critical: true, timeout: 10 });
  const budgets = [];
  const out = await dispatch('PreToolUse', '{}', { home, concurrency: 1, overloaded: false,
    manifest: { events: { PreToolUse: [hook, hook, hook] } },
    async execute(_hook, _raw, timeout) { budgets.push(timeout); await new Promise(r => setTimeout(r, timeout + 100)); return { status: 0 }; },
  });
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] > 0 && budgets[0] <= 3000);
  assert.ok(budgets[0] < hook.timeout * 1000, 'settings budget caps the hook timeout');
  assert.equal(out.status, 0); assert.equal(out.stdout, '');
  assert.deepEqual(out.metrics.hooks.map(h => h.criticalUnfinished), [undefined, 'dispatch-budget', 'dispatch-budget']);
  assert.equal(out.metrics.timedOut, 0);
  assert.ok(out.metrics.durationMs < budgets[0] + timingSlackMs);
});


test('critical errors and exceptions pass, persist metrics, and preserve explicit denials', async t => {
  const home = fixture(t);
  const hooks = [
    script(home, 'bad-exit', `export async function hookMain() { console.log(JSON.stringify({decision:'block',reason:'partial output'})); process.exitCode = 1; }`, { critical: true }),
    script(home, 'throws', `export async function hookMain() { throw new Error('missing dependency'); }`, { critical: true }),
    script(home, 'missing-import', `import './absent-module.mjs';`, { critical: true }),
  ];
  const options = { home, concurrency: 1, overloaded: false, manifest: { events: { PreToolUse: hooks } } };
  const out = await dispatch('PreToolUse', '{}', options);
  assert.equal(out.status, 0); assert.equal(out.stdout, '');
  assert.deepEqual(out.metrics.hooks.map(h => h.criticalUnfinished), hooks.map(() => 'hook-error'));
  const records = await readDispatchMetrics(home);
  assert.deepEqual(records.at(-1).hooks, JSON.parse(JSON.stringify(out.metrics.hooks)));
  const thrown = await dispatch('PreToolUse', '{}', { ...options, execute() { throw new Error('executor error'); } });
  assert.equal(thrown.stdout, '');
  assert.ok(thrown.metrics.hooks.every(h => h.criticalUnfinished === 'hook-error'));
  for (const body of [
    `export async function hookMain() { console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'explicit denial'}})); }`,
    `export async function hookMain() { process.stderr.write('explicit denial'); process.exitCode = 2; }`,
  ]) {
    const deny = script(home, 'explicit-' + body.length, body, { critical: true });
    const result = await dispatch('PreToolUse', '{}', { ...options, manifest: { events: { PreToolUse: [...hooks, deny] } } });
    assert.equal(result.payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(result.payload.hookSpecificOutput.permissionDecisionReason, 'explicit denial');
    assert.equal(result.metrics.hooks.at(-1).criticalUnfinished, undefined);
  }
});

test('critical unfinished threshold is five per rolling hour across events; daily alert deduplicates', async t => {
  const home = fixture(t), now = Date.parse('2026-11-05T00:10:00Z');
  const record = (event, reasons, at = now - 1200000) => ({ at: new Date(at).toISOString(), event,
    hooks: reasons.map(criticalUnfinished => ({ critical: true, criticalUnfinished })) });
  const four = [record('PreToolUse', ['hook-timeout', 'hook-error']), record('Stop', ['dispatch-budget', 'hook-error']),
    record('PreToolUse', ['hook-error'], now - 3600000), record('Stop', ['hook-error'], now + 1),
    record('Stop', [undefined, 'unknown'])];
  let count = 0;
  const notify = async (_home, options) => { count++; assert.match(options.text, /critical 未完了 合計 5件/); return { id: 'test-critical-alert' }; };
  assert.equal((await checkDispatchBudget(home, { now, records: four, notify })).over, false);
  assert.equal(count, 0);
  const five = [...four, record('PostToolUse', ['dispatch-budget'])];
  const summary = summarizeDispatchMetrics(five, { now });
  assert.equal(summary.criticalUnfinishedPerHour, 5); assert.equal(summary.over, true);
  assert.equal(summary.events.PreToolUse.criticalUnfinishedPerHour, 2);
  await Promise.all([checkDispatchBudget(home, { now, records: five, notify }), checkDispatchBudget(home, { now, records: five, notify })]);
  assert.equal(count, 1);
  assert.equal(summarizeDispatchMetrics([...five, record('Stop', ['hook-error'])], { now }).criticalUnfinishedPerHour, 6);
  const tomorrow = now + 86400000;
  await checkDispatchBudget(home, { now: tomorrow, records: [record('Stop', Array(5).fill('hook-error'), tomorrow - 1)], notify });
  assert.equal(count, 2);
});

test('intra-turn-progress-reminder fires through the dispatcher and its REMINDER reaches additionalContext on the 3rd PostToolUse', async t => {
  const home = fixture(t);
  const repo = path.resolve('.');
  const script = path.join(repo, 'tools/intra-turn-progress-reminder.mjs');
  const hook = {
    name: 'intra-turn-progress-reminder.mjs', matcher: '*', type: 'command',
    command: `node "${script}"`, timeout: 5,
  };
  const sessionId = 'test-dispatcher-progress';
  const counterDir = path.join(home, '.claude', '.intra-turn-progress-counter');
  const env = { ...process.env, HOME: home, USERPROFILE: home, INTRA_TURN_PROGRESS_THRESHOLD: '3', CLAUDE_HEADLESS: '', ORGIAST_HEADLESS_JOB: '' };
  const options = { home, env, overloaded: false, manifest: { events: { PostToolUse: [hook] } } };
  // 1回目: count 1, no reminder
  const first = await dispatch('PostToolUse', JSON.stringify({ session_id: sessionId, tool_name: 'Read' }), options);
  assert.equal(first.payload.hookSpecificOutput, undefined, '1回目は reminder なし');
  // 2回目: count 2, no reminder
  const second = await dispatch('PostToolUse', JSON.stringify({ session_id: sessionId, tool_name: 'Edit' }), options);
  assert.equal(second.payload.hookSpecificOutput, undefined, '2回目も reminder なし');
  // 3回目: count 3 → fire → additionalContext に REMINDER
  const third = await dispatch('PostToolUse', JSON.stringify({ session_id: sessionId, tool_name: 'Write' }), options);
  assert.ok(third.payload.hookSpecificOutput?.additionalContext, '3回目は additionalContext が必要');
  assert.match(third.payload.hookSpecificOutput.additionalContext, /【進捗報告リマインダー】/, 'REMINDER が additionalContext に含まれる');
  assert.equal(third.metrics.timedOut, 0, 'timeout なし');
  // カウンタがリセットされたことを確認
  const counter = JSON.parse(fs.readFileSync(path.join(counterDir, `${encodeURIComponent(sessionId)}.json`), 'utf8'));
  assert.equal(counter.count, 0, 'カウンタは fire 後に 0 にリセット');
  // 4回目: count 1, no reminder (リセット後)
  const fourth = await dispatch('PostToolUse', JSON.stringify({ session_id: sessionId, tool_name: 'Read' }), options);
  assert.equal(fourth.payload.hookSpecificOutput, undefined, '4回目（リセット後1回目）は reminder なし');
  t.diagnostic(`dispatcher progress reminder: 3rd call delivered additionalContext (${third.payload.hookSpecificOutput?.additionalContext?.length ?? 0} chars)`);
});
