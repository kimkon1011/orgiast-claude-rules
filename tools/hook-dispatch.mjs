#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { EVENTS, defaultRepo, readDispatchManifest, tokens, isDispatcher } from './hook-dispatch-registry.mjs';

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
  let permission, updatedInput, continueValue, stopReason, sessionTitle, legacyBlock = false;
  for (const result of results) {
    if ((result.timedOut && !(result.name === 'kim-inbox.mjs' && result.contextComplete)) || result.skipped || ![0, 2].includes(result.status)) continue;
    const out = parseOutput(result.stdout), specific = out?.hookSpecificOutput;
    if (result.status === 2) {
      reasons.push(String(result.stderr || out?.reason || 'Hook blocked the operation').trim());
      legacyBlock = true;
    } else {
      if (specific?.permissionDecision === 'deny' || out?.decision === 'block') reasons.push(specific?.permissionDecisionReason || out.reason || 'Hook blocked the operation');
      if (specific?.additionalContext) contexts.push(specific.additionalContext);
      if (typeof specific?.sessionTitle === 'string' && specific.sessionTitle.trim() && ['SessionStart', 'UserPromptSubmit'].includes(event)) sessionTitle = specific.sessionTitle;
      if (!out && result.stdout?.trim() && ['SessionStart', 'UserPromptSubmit', 'PostToolUse'].includes(event)) contexts.push(result.stdout.trim());
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
    if (sessionTitle) payload.hookSpecificOutput = { ...payload.hookSpecificOutput, hookEventName: event, sessionTitle };
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
// Leave time for metrics, output and isolate shutdown before the CLI timeout.
function dispatchBudgetMs(home, event, manifest) {
  let seconds = Math.max(1, ...(manifest.events[event] || []).map(h => Number(h.timeout) || 10)) + 10;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    for (const hook of (settings.hooks?.[event] || []).flatMap(g => g.hooks || [])) {
      if (isDispatcher(hook) && tokens(hook.command).at(-1) === event && Number(hook.timeout) > 0) {
        seconds = Math.min(seconds, Number(hook.timeout));
      }
    }
  } catch { /* isolated calls use the same default as collapseHooks */ }
  return seconds * 1000 - Math.min(1000, seconds * 100);
}
function workerSlot(options) {
  let worker, current, retired = false;
  const children = new Set();
  const retire = () => {
    retired = true;
    for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    children.clear();
    if (worker) { worker.unref(); void worker.terminate(); }
  };
  // kim-inbox pushes its context before persisting shown-state, so it can stall
  // after a complete delivery. A timed-out gate that already emitted an intact
  // context keeps it for mergeResults; partial output stays discarded (#1621).
  const timeoutResult = () => {
    const hook = current?.hook;
    const contextComplete = hook?.name === 'kim-inbox.mjs'
      && Boolean(hook?.node && parseOutput(current?.stdout || '')?.hookSpecificOutput?.additionalContext);
    return { status: 0, stdout: contextComplete ? current.stdout : '', stderr: '', timedOut: true, contextComplete };
  };
  return {
    get retired() { return retired; },
    close: retire,
    run(hook, raw, timeoutMs) {
      if (retired) throw new Error('worker retired');
      return new Promise(resolve => {
        const id = randomUUID();
        const finish = result => {
          if (current?.id !== id) return;
          clearTimeout(current.timer); current = null;
          resolve(result);
        };
        // Streamed task-local writes accumulate here so the timeout decision can
        // see a completed context even after the isolate is wedged.
        current = { id, hook, stdout: '', finish, timer: setTimeout(() => {
          const result = timeoutResult();
          retire();
          finish(result);
        }, timeoutMs) };
        if (!worker) {
          try {
            worker = new Worker(new URL('./hook-dispatch-worker.mjs', import.meta.url), {
              workerData: { pool: true }, stdout: true, stderr: true,
              env: options.env || process.env, execArgv: [],
            });
          } catch (error) {
            retire(); finish({ status: 1, stdout: '', stderr: error.message }); return;
          }
          options.onWorkerCreated?.();
          // Hooks use the bounded, task-local capture in the worker. Drain any
          // runtime diagnostics without mixing them with another hook's JSON.
          worker.stdout.resume(); worker.stderr.resume();
          worker.on('message', message => {
            if (message.id !== current?.id) return;
            if (message.stream) { current.stdout = (current.stdout + String(message.text)).slice(-4 * 1024 * 1024); return; }
            if (message.childSpawn) options.onWorkerSpawn?.(message.childSpawn, current.hook);
            if (message.childPid) children.add(message.childPid);
            if (message.childClosed) children.delete(message.childClosed);
            if (message.deadlineHit) {
              if (typeof message.stdout === 'string') current.stdout = message.stdout;
              const result = timeoutResult();
              retire();
              current.finish(result);
            } else if (message.result) {
              children.clear(); current.finish(message.result);
            }
          });
          worker.once('error', error => {
            retire(); current?.finish({ status: 1, stdout: '', stderr: error.message });
          });
          worker.once('exit', status => {
            retired = true;
            current?.finish({ status: status || 1, stdout: '', stderr: 'worker exited before completing hook' });
          });
        }
        worker.postMessage({ id, hook, raw, deadline: Date.now() + timeoutMs });
      });
    },
  };
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
    input = JSON.parse(String(raw).replace(/^﻿/, ''));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('not an object');
  } catch {
    const metrics = { at: new Date().toISOString(), event, durationMs: 0, childProcesses: 0, timedOut: 0, skipped: 0, hooks: [], inputError: 'invalid-json' };
    appendMetrics(home, metrics);
    return { ...mergeResults(event, []), metrics, results: [] };
  }
  // The CLI event is authoritative, even if a client omitted hook_event_name.
  raw = JSON.stringify({ ...input, hook_event_name: event });
  const start = Date.now();
  const manifest = options.manifest || readDispatchManifest(home, options.repo || defaultRepo);
  const lease = acquireLoadLease(home, options.loadOptions);
  const overloaded = options.overloaded ?? lease.overloaded;
  const selected = (manifest.events[event] || []).filter(h => matches(h.matcher, event, input));
  const results = new Array(selected.length);
  // Durable inbox delivery must not be shed or expire while waiting for other hooks.
  for (const hook of selected) if (hook.name === 'kim-inbox.mjs') hook.critical = true;
  const queue = selected.map((hook, i) => ({ hook, i })).sort((a, b) => Number(b.hook.name === 'kim-inbox.mjs') - Number(a.hook.name === 'kim-inbox.mjs') || Number(b.hook.critical) - Number(a.hook.critical));
  let childProcesses = 0, workersCreated = 0;
  // Most hooks are short. Reserve CPUs for the client and other sessions instead
  // of multiplying V8/module startup costs on every logical processor.
  const poolSize = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || Math.max(4, Math.ceil(os.availableParallelism() / 4)))));
  const slots = [];
  const deadline = start + (options.budgetMs ?? dispatchBudgetMs(home, event, manifest));
  const unavailable = (hook, why) => hook.critical
    ? { status: 0, stdout: '', stderr: '', criticalUnfinished: why }
    : { status: 0, skipped: why };
  const save = (item, result, began) => {
    results[item.i] = { ...result, name: item.hook.name, critical: !!item.hook.critical, durationMs: Date.now() - began, queueMs: began - start };
  };
  const consume = async (pending, slot, external = false) => {
    while (pending.length && !slot?.retired) {
      const item = pending.shift(), { hook } = item, began = Date.now();
      let result;
      if (overloaded && !hook.critical) result = { status: 0, skipped: 'load-shed' };
      else if (began >= deadline) result = unavailable(hook, 'dispatch-budget');
      else {
        // Queue time never consumes the hook's own budget. A separate event
        // deadline keeps us inside settings.json; unfinished gates pass with metrics.
        const timeout = Math.min((Number(hook.timeout) || 10) * 1000, deadline - began);
        try {
          result = options.execute ? await options.execute(hook, raw, timeout)
            : external ? await externalHook(hook, raw, timeout, { ...options, onSpawn: (...args) => { childProcesses++; options.onSpawn?.(...args); } })
              : await slot.run(hook, raw, timeout);
          if (hook.critical && (result.timedOut || ![0, 2].includes(result.status))) {
            // A timed-out kim-inbox gate that already completed its context keeps
            // the delivery; only the unfinished reason is recorded.
            result = result.contextComplete
              ? { ...result, criticalUnfinished: result.timedOut ? 'hook-timeout' : 'hook-error' }
              : { ...result, ...unavailable(hook, result.timedOut ? 'hook-timeout' : 'hook-error') };
          }
        } catch (e) { result = hook.critical ? { ...unavailable(hook, 'hook-error'), error: e.message } : { status: 1, error: e.message }; }
      }
      save(item, result, began);
    }
  };
  try {
    const nodeQueue = options.execute ? queue : queue.filter(item => item.hook.node);
    const externalQueue = options.execute ? [] : queue.filter(item => !item.hook.node);
    const consumers = Array.from({ length: Math.min(poolSize, nodeQueue.length) }, () => {
      const slot = options.execute ? null : workerSlot({ ...options,
        onWorkerCreated() { workersCreated++; options.onWorkerCreated?.(); },
        onWorkerSpawn(...args) { childProcesses++; options.onWorkerSpawn?.(...args); },
      });
      if (slot) slots.push(slot);
      return consume(nodeQueue, slot);
    });
    consumers.push(...Array.from({ length: Math.min(4, poolSize, externalQueue.length) }, () => consume(externalQueue, null, true)));
    await Promise.all(consumers);
    // Retired workers are never replaced: even a set of hanging hooks cannot
    // cause unbounded isolate creation. Healthy workers drain the remaining queue.
    for (const item of nodeQueue) save(item, unavailable(item.hook, Date.now() >= deadline ? 'dispatch-budget' : 'hook-error'), Date.now());
    const record = { at: new Date(start).toISOString(), event, durationMs: Date.now() - start, overloaded, active: lease.active,
      childProcesses, workersCreated, poolSize, budgetMs: deadline - start,
      timedOut: results.filter(r => r.timedOut).length, skipped: results.filter(r => r.skipped).length,
      hooks: results.map(({ name, critical, durationMs, queueMs, timedOut, skipped, status, error, criticalUnfinished }) => ({ name, critical, durationMs, queueMs, timedOut: !!timedOut, skipped, status, error, criticalUnfinished })) };
    appendMetrics(home, record);
    return { ...mergeResults(event, results), metrics: record, results };
  } finally { for (const slot of slots) slot.close(); lease.release(); }
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