#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { EVENTS, defaultRepo, readDispatchManifest, tokens } from './hook-dispatch-registry.mjs';

export function matches(matcher, event, input) {
  if (!matcher || matcher === '*') return true;
  const value = ['PreToolUse', 'PostToolUse'].includes(event) ? input.tool_name
    : event === 'SessionStart' ? input.source : event === 'SessionEnd' ? input.reason
      : event === 'Notification' ? input.notification_type : '';
  try { return new RegExp(`^(?:${matcher})$`).test(String(value || '')); } catch { return false; }
}
export function parseOutput(stdout) {
  try { return JSON.parse(String(stdout).trim()); } catch {}
  for (const line of String(stdout).trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}
export function mergeResults(event, results) {
  const reasons = [], contexts = [], messages = [];
  let permission, updatedInput, continueValue, stopReason, legacyBlock = false;
  for (const result of results) {
    if (result.timedOut || result.skipped || ![0, 2].includes(result.status)) continue;
    const out = parseOutput(result.stdout), specific = out?.hookSpecificOutput;
    if (result.status === 2) {
      reasons.push(String(result.stderr || out?.reason || 'Hook blocked the operation').trim());
      legacyBlock = true;
    } else {
      if (specific?.permissionDecision === 'deny' || out?.decision === 'block') reasons.push(specific?.permissionDecisionReason || out.reason || 'Hook blocked the operation');
      if (specific?.additionalContext) contexts.push(specific.additionalContext);
      if (!out && result.stdout?.trim() && ['SessionStart', 'UserPromptSubmit'].includes(event)) contexts.push(result.stdout.trim());
      if (out?.systemMessage) messages.push(out.systemMessage);
      if (specific?.permissionDecision === 'ask') permission = 'ask';
      else if (specific?.permissionDecision === 'allow' && !permission) permission = 'allow';
      if (specific?.updatedInput) updatedInput = { ...updatedInput, ...specific.updatedInput };
      if (out?.continue === false) { continueValue = false; stopReason = out.stopReason; }
    }
  }
  const payload = {};
  if (event === 'PreToolUse') {
    const specific = { hookEventName: event };
    if (reasons.length) Object.assign(specific, { permissionDecision: 'deny', permissionDecisionReason: reasons.join('\n') });
    else if (permission) specific.permissionDecision = permission;
    if (contexts.length) specific.additionalContext = contexts.join('\n');
    if (updatedInput && !reasons.length) specific.updatedInput = updatedInput;
    if (Object.keys(specific).length > 1) payload.hookSpecificOutput = specific;
  } else {
    if (reasons.length && ['Stop', 'UserPromptSubmit', 'PostToolUse'].includes(event)) Object.assign(payload, { decision: 'block', reason: reasons.join('\n') });
    if (contexts.length && event !== 'Stop') payload.hookSpecificOutput = { hookEventName: event, additionalContext: contexts.join('\n') };
  }
  if (messages.length) payload.systemMessage = messages.join('\n');
  if (continueValue === false) Object.assign(payload, { continue: false, stopReason });
  // SessionStart/Notification/SessionEnd have no JSON blocking decision. Preserve
  // legacy code 2 there; tool/Stop blocking is represented by the merged JSON.
  const status = legacyBlock && !['PreToolUse', 'Stop', 'UserPromptSubmit', 'PostToolUse'].includes(event) ? 2 : 0;
  return { status, stdout: Object.keys(payload).length ? JSON.stringify(payload) + '\n' : '', stderr: status === 2 ? reasons.join('\n') : '', payload };
}

export function acquireLoadLease(home, { now = Date.now(), free = os.freemem(), total = os.totalmem(), maxActive = 4, ttlMs = 180000 } = {}) {
  const dir = path.join(home, '.claude', 'hook-metrics', 'active');
  let lease, active = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    lease = path.join(dir, `${process.pid}-${randomUUID()}.lock`);
    fs.writeFileSync(lease, String(now), { flag: 'wx' });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.lock')) continue;
      const file = path.join(dir, name);
      try {
        const age = now - fs.statSync(file).mtimeMs;
        if (age > ttlMs || age < -60000) fs.unlinkSync(file);
        else active++;
      } catch {}
    }
  } catch {}
  return { overloaded: active > maxActive || free < Math.max(512 * 1024 ** 2, total * 0.06), active,
    release() { if (lease) { try { fs.unlinkSync(lease); } catch {} } } };
}
export function appendMetrics(home, record) {
  try {
    const dir = path.join(home, '.claude', 'hook-metrics');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${record.at.slice(0, 10)}.jsonl`), JSON.stringify(record) + '\n');
  } catch { /* disk failure must not prevent gate execution */ }
}
function workerHook(hook, raw, timeoutMs, options) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', result, settled = false, timedOut = false;
    const children = new Set();
    const worker = new Worker(new URL('./hook-dispatch-worker.mjs', import.meta.url), {
      workerData: { hook, raw, deadline: Date.now() + timeoutMs }, stdout: true, stderr: true,
      env: options.env || process.env, execArgv: [],
    });
    const finish = value => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve(value);
    };
    // Bound output as well as time, preventing a broken hook from exhausting RAM.
    const collect = (stream, chunk) => {
      if (stream === 'stdout') stdout = (stdout + chunk).slice(-4 * 1024 * 1024);
      else stderr = (stderr + chunk).slice(-65536);
    };
    worker.stdout.on('data', chunk => collect('stdout', chunk));
    worker.stderr.on('data', chunk => collect('stderr', chunk));
    worker.on('message', message => {
      if (message.deadlineHit) expire();
      if (message.childSpawn) options.onWorkerSpawn?.(message.childSpawn, hook);
      if (message.childPid) children.add(message.childPid);
      if (message.childClosed) children.delete(message.childClosed);
      if (message.stream) collect(message.stream, message.text);
      if (message.result) result = message.result;
    });
    worker.once('error', error => { stderr += error.message; });
    worker.once('exit', status => finish(timedOut ? { status: 0, stdout: '', stderr: '', timedOut: true } : result || { status, stdout, stderr }));
    const expire = () => {
      // Ignore any partial deny/context on a timed-out hook, as the legacy runner did.
      timedOut = true;
      for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      worker.unref();
      void worker.terminate();
      finish({ status: 0, stdout: '', stderr: '', timedOut: true });
    };
    const timer = setTimeout(expire, timeoutMs);
  });
}
function externalHook(hook, raw, timeoutMs, options) {
  return new Promise(resolve => {
    const parts = tokens(hook.command);
    const powershell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(parts[0]);
    const child = powershell ? spawn(parts[0], parts.slice(1), { windowsHide: true, env: options.env, stdio: 'pipe' })
      : spawn(hook.command, { shell: true, windowsHide: true, env: options.env, stdio: 'pipe' });
    options.onSpawn?.(child, hook);
    let stdout = '', stderr = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    child.stdout.on('data', c => { stdout = (stdout + c).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-65536); });
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
    child.once('error', error => finish({ status: 1, stdout: '', stderr: error.message }));
    child.once('close', status => finish({ status, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // single PID; never taskkill /T
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      child.unref();
      finish({ status: 0, stdout: '', stderr: '', timedOut: true });
    }, timeoutMs);
  });
}
export async function dispatch(event, raw, options = {}) {
  if (!EVENTS.includes(event)) throw new Error(`Unsupported hook event: ${event}`);
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  let input;
  try {
    input = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('not an object');
  } catch {
    const metrics = { at: new Date().toISOString(), event, durationMs: 0, childProcesses: 0, timedOut: 0, skipped: 0, hooks: [], inputError: 'invalid-json' };
    appendMetrics(home, metrics);
    return { ...mergeResults(event, []), metrics, results: [] };
  }
  // The CLI event is authoritative, even if a client omitted hook_event_name.
  raw = JSON.stringify({ ...input, hook_event_name: event });
  const manifest = options.manifest || readDispatchManifest(home, options.repo || defaultRepo);
  const start = Date.now();
  const lease = acquireLoadLease(home, options.loadOptions);
  const overloaded = options.overloaded ?? lease.overloaded;
  const selected = (manifest.events[event] || []).filter(h => matches(h.matcher, event, input));
  const results = new Array(selected.length);
  const queue = selected.map((hook, i) => ({ hook, i })).sort((a, b) => Number(b.hook.critical) - Number(a.hook.critical));
  let childProcesses = 0;
  const execute = options.execute || ((hook, body, timeout) => hook.node ? workerHook(hook, body, timeout, { ...options, onWorkerSpawn: (...args) => { childProcesses++; options.onWorkerSpawn?.(...args); } })
    : externalHook(hook, body, timeout, { ...options, onSpawn: (...args) => { childProcesses++; options.onSpawn?.(...args); } }));
  const consume = async () => {
    while (queue.length) {
      const { hook, i } = queue.shift(), began = Date.now();
      let result;
      if (overloaded && !hook.critical) result = { status: 0, skipped: 'load-shed' };
      else {
        const remaining = (Number(hook.timeout) || 10) * 1000 - (began - start);
        if (remaining <= 0) result = { status: 0, timedOut: true, queued: true };
        else { try { result = await execute(hook, raw, remaining); } catch (e) { result = { status: 1, error: e.message }; } }
      }
      results[i] = { ...result, name: hook.name, durationMs: Date.now() - began, queueMs: began - start };
    }
  };
  try {
    const concurrency = Math.max(1, Math.min(4, Math.floor(Number(options.concurrency) || 4)));
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, consume));
    const record = { at: new Date(start).toISOString(), event, durationMs: Date.now() - start, overloaded, active: lease.active,
      childProcesses, timedOut: results.filter(r => r.timedOut).length, skipped: results.filter(r => r.skipped).length,
      hooks: results.map(({ name, durationMs, queueMs, timedOut, skipped, status, error }) => ({ name, durationMs, queueMs, timedOut: !!timedOut, skipped, status, error })) };
    appendMetrics(home, record);
    return { ...mergeResults(event, results), metrics: record, results };
  } finally { lease.release(); }
}
export async function hookMain(raw, event = process.argv[2]) {
  const result = await dispatch(event, raw);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
if (isEntry(import.meta.url)) {
  try { await hookMain(await readStdinWithTimeout()); } catch (error) { console.error(`[hook-dispatch] ${error.message}`); process.exitCode = 1; }
}
