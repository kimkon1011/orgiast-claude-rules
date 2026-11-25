// Runs independently of the controller, with no model/network calls.
import { isEntry } from '../is-entry.mjs';
import { killTree } from './quota-sweep-process.mjs';
export function watch(pid, parentPid, deadline) {
  if (![pid, parentPid, deadline].every(Number.isFinite) || pid <= 0 || parentPid <= 0) throw new Error('Invalid watchdog arguments');
  const alive = id => { try { process.kill(id, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  const timer = setInterval(() => {
    if (!alive(pid)) { clearInterval(timer); return; }
    if (Date.now() >= deadline || !alive(parentPid)) {
      try { killTree(pid); clearInterval(timer); } catch { /* retry until the process is gone */ }
    }
  }, 100);
}
if (isEntry(import.meta.url)) watch(...process.argv.slice(2).map(Number));
