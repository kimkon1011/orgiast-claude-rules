import fs from 'node:fs/promises';
import path from 'node:path';
import { auditError } from './common.mjs';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
export async function acquireLock(stateDir, { now = Date.now(), alive = pidAlive } = {}) {
  const file = path.join(stateDir, 'run.lock');
  let recovered = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      const identity = await handle.stat();
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }));
      return { recovered, async release() {
        await handle.close();
        try {
          const current = await fs.stat(file);
          if (current.ino === identity.ino && current.dev === identity.dev) await fs.unlink(file);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw auditError('state-dir にロックを書き込めません');
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw auditError('run.lock symlink は使用できません');
        let data = {};
        try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* Old empty locks use mtime. */ }
        if (now - stat.mtimeMs <= 3 * 3600000 && alive(data.pid)) throw auditError('監査は実行中、または新しいロックの所有者を確認できません');
        const current = await fs.lstat(file);
        if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) continue;
        await fs.unlink(file);
        recovered = true;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  throw auditError('監査ロックの競合');
}
