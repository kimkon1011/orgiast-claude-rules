// A Worker is an isolate inside the dispatcher OS process, not another node.exe.
// Legacy argv/stdin/stdout remain local to this isolate. CPU loops can be terminated
// without discarding the results of other hooks or using Windows taskkill /T.
import { workerData, parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runHook } from './gate-hook-runner.mjs';
const { hook, raw, deadline } = workerData;
// Count actual calls, including helpers spawned inside a hook (not just dispatch
// fallbacks). Named ESM imports receive these wrappers before the hook is loaded.
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[method];
  childProcess[method] = function (...args) {
    let deadlineLimited = false;
    // A Worker cannot interrupt an arbitrary native wait. Clamp synchronous
    // subprocess waits to the same deadline and use a non-catchable kill signal.
    if (method.endsWith('Sync')) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        parentPort.postMessage({ deadlineHit: true });
        throw new Error('hook deadline expired');
      }
      const index = method === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
      const options = args[index] || {};
      deadlineLimited = !Number(options.timeout) || Number(options.timeout) >= remaining;
      args[index] = { ...options, timeout: Math.max(1, Math.min(Number(options.timeout) || remaining, remaining)), killSignal: 'SIGKILL', windowsHide: true };
    }
    parentPort.postMessage({ childSpawn: { method, executable: String(args[0]) } });
    let child;
    try {
      child = original.apply(this, args);
    } catch (error) {
      if (deadlineLimited && error.code === 'ETIMEDOUT') parentPort.postMessage({ deadlineHit: true });
      throw error;
    }
    if (deadlineLimited && child?.error?.code === 'ETIMEDOUT') parentPort.postMessage({ deadlineHit: true });
    if (child?.pid && typeof child.on === 'function') {
      parentPort.postMessage({ childPid: child.pid });
      child.once('exit', () => parentPort.postMessage({ childClosed: child.pid }));
    }
    return child;
  };
}
syncBuiltinESMExports();
let stdout = '', stderr = '';
process.stdout.write = (chunk, encoding, callback) => {
  stdout = (stdout + String(chunk)).slice(-4 * 1024 * 1024); parentPort.postMessage({ stream: 'stdout', text: String(chunk) });
  (typeof encoding === 'function' ? encoding : callback)?.(); return true;
};
process.stderr.write = (chunk, encoding, callback) => {
  stderr = (stderr + String(chunk)).slice(-65536); parentPort.postMessage({ stream: 'stderr', text: String(chunk) });
  (typeof encoding === 'function' ? encoding : callback)?.(); return true;
};
// A few legacy hooks use fd 0/1 directly. Keep those descriptors isolated too;
// otherwise a worker could write an unmerged JSON object to the CLI's stdout.
const readFileSync = fs.readFileSync, writeSync = fs.writeSync;
fs.readFileSync = function (file, ...args) {
  if (file === 0) return args[0] ? raw : Buffer.from(raw);
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
// readStdinWithTimeout uses this only in the worker. Repeated policy evaluations
// see exactly the same input instead of an already-consumed stream.
globalThis[Symbol.for('orgiast.hook.raw')] = raw;
let iteration = 0;
const execute = async () => {
  stdout = ''; stderr = ''; process.exitCode = 0;
  Object.defineProperty(process, 'stdin', { value: Readable.from([raw]), configurable: true });
  const adapter = /export\s+async\s+function\s+hookMain\b/.test(fs.readFileSync(hook.script, 'utf8'));
  process.argv = [process.execPath, adapter ? '' : hook.script, ...hook.args];
  const module = await import(`${pathToFileURL(hook.script).href}?dispatch=${iteration++}`);
  if (adapter) await module.hookMain(raw);
  return { status: process.exitCode || 0, stdout, stderr };
};
try {
  const result = hook.policy ? await runHook(hook.script, raw, { executeImpl: execute }) : await execute();
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ result: { status: 1, stdout: '', stderr: String(error.message) } });
}
parentPort.close();
