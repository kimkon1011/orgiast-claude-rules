// Reusable isolates stay inside the single dispatcher OS process. Each isolate
// runs one hook at a time; a stuck isolate is retired, never replaced in this call.
import { workerData, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import timers from 'node:timers';
import { runHook } from './gate-hook-runner.mjs';

const tasks = new AsyncLocalStorage();
let activeTask;
// Native lifecycle events (notably beforeExit) have no AsyncLocalStorage store.
// A late callback with an old store still uses that closed task, never this one.
const context = () => tasks.getStore() || activeTask;
const baseEnv = { ...process.env };
const send = message => {
  const task = context();
  if (task && !task.closed) parentPort.postMessage({ id: task.id, ...message });
};
// Track native timer resources too: timers/promises bypasses global setTimeout.
// Cancel unref timers at completion just as standalone process exit would, so
// an old callback cannot change the next hook's exitCode or environment.
const timerOwners = new Map();
createHook({
  init(id, type, _trigger, resource) {
    if (type !== 'Timeout' && type !== 'Immediate') return;
    const task = context();
    if (!task || task.closed) return;
    task.timers.set(resource, type === 'Immediate' ? timers.clearImmediate : timers.clearTimeout);
    timerOwners.set(id, { task, resource });
  },
  destroy(id) {
    const owner = timerOwners.get(id);
    if (owner) { owner.task.timers.delete(owner.resource); timerOwners.delete(id); }
  },
}).enable();
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[method];
  childProcess[method] = function (...args) {
    const task = context();
    if (!task || task.closed) throw new Error('hook is no longer active');
    let deadlineLimited = false;
    if (method.endsWith('Sync')) {
      const remaining = task.deadline - Date.now();
      if (remaining <= 0) {
        send({ deadlineHit: true, stdout: task.stdout || '' });
        throw new Error('hook deadline expired');
      }
      const index = method === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
      const options = args[index] || {};
      deadlineLimited = !Number(options.timeout) || Number(options.timeout) >= remaining;
      args[index] = { ...options, timeout: Math.max(1, Math.min(Number(options.timeout) || remaining, remaining)), killSignal: 'SIGKILL', windowsHide: true };
    }
    send({ childSpawn: { method, executable: String(args[0]) } });
    let child;
    try { child = original.apply(this, args); }
    catch (error) {
      if (deadlineLimited && error.code === 'ETIMEDOUT') send({ deadlineHit: true, stdout: task.stdout || '' });
      throw error;
    }
    if (deadlineLimited && child?.error?.code === 'ETIMEDOUT') send({ deadlineHit: true, stdout: task.stdout || '' });
    if (child?.pid && typeof child.on === 'function') {
      send({ childPid: child.pid });
      child.once('exit', () => send({ childClosed: child.pid }));
    }
    return child;
  };
}
process.stdout.write = (chunk, encoding, callback) => {
  const task = context();
  if (task && !task.closed) {
    task.stdout = (task.stdout + String(chunk)).slice(-4 * 1024 * 1024);
    // Mirror the active task's output to the dispatcher so a stall (CPU loop /
    // native wait) can still be judged: a completed kim-inbox context survives
    // an otherwise-lossy timeout instead of being discarded with the isolate.
    send({ stream: 'stdout', text: String(chunk) });
  }
  (typeof encoding === 'function' ? encoding : callback)?.(); return true;
};
process.stderr.write = (chunk, encoding, callback) => {
  const task = context();
  if (task && !task.closed) task.stderr = (task.stderr + String(chunk)).slice(-65536);
  (typeof encoding === 'function' ? encoding : callback)?.(); return true;
};
const readFileSync = fs.readFileSync, writeSync = fs.writeSync;
fs.readFileSync = function (file, ...args) {
  if (file === 0) {
    const raw = context()?.raw || '';
    return args[0] ? raw : Buffer.from(raw);
  }
  return readFileSync.call(this, file, ...args);
};
fs.writeSync = function (fd, data, ...args) {
  if (fd === 1 || fd === 2) {
    const chunk = Buffer.isBuffer(data) ? data.subarray(typeof args[0] === 'number' ? args[0] : 0, typeof args[1] === 'number' ? (args[0] || 0) + args[1] : undefined) : String(data);
    (fd === 1 ? process.stdout : process.stderr).write(chunk);
    return Buffer.byteLength(chunk);
  }
  return writeSync.call(this, fd, data, ...args);
};
syncBuiltinESMExports();
// Legacy entrypoints may launch async work without awaiting it. Let their
// referenced handles drain just as with a standalone process before reusing the
// isolate. Unref timers do not postpone completion, also as in a standalone hook.
const idle = () => new Promise(resolve => {
  process.once('beforeExit', () => { parentPort.ref(); resolve(); });
  parentPort.unref();
});
let iteration = 0;
async function run(task) {
  task.timers = new Map();
  activeTask = task;
  await tasks.run(task, async () => {
    for (const key of Object.keys(process.env)) if (!(key in baseEnv)) delete process.env[key];
    Object.assign(process.env, baseEnv);
    const listeners = new Map(process.eventNames().map(name => [name, process.rawListeners(name)]));
    const { hook, raw } = task;
    globalThis[Symbol.for('orgiast.hook.raw')] = raw;
    const execute = async () => {
      task.stdout = ''; task.stderr = ''; process.exitCode = 0;
      Object.defineProperty(process, 'stdin', { value: Readable.from([raw]), configurable: true });
      const adapter = /export\s+async\s+function\s+hookMain\b/.test(fs.readFileSync(hook.script, 'utf8'));
      process.argv = [process.execPath, adapter ? '' : hook.script, ...(hook.args || [])];
      const module = await import(`${pathToFileURL(hook.script).href}?dispatch=${iteration++}`);
      if (adapter) await module.hookMain(raw);
      await idle();
      return { status: process.exitCode || 0, stdout: task.stdout, stderr: task.stderr };
    };
    try {
      const result = hook.policy ? await runHook(hook.script, raw, { executeImpl: execute }) : await execute();
      send({ result });
    } catch (error) {
      // Drain pending work even on an exception before accepting another task.
      await idle();
      send({ result: { status: 1, stdout: '', stderr: String(error.message) } });
    } finally {
      task.closed = true;
      activeTask = null;
      for (const [handle, cancel] of task.timers) cancel(handle);
      task.timers.clear();
      for (const name of process.eventNames()) for (const listener of process.rawListeners(name)) {
        if (!listeners.get(name)?.includes(listener)) process.removeListener(name, listener);
      }
    }
  });
}
if (workerData?.pool) {
  parentPort.on('message', task => { void run(task); });
} else {
  // One-shot protocol retained for native-wait regression probes.
  await run(workerData);
  parentPort.close();
}
