import fs from 'node:fs';
import path from 'node:path';

export function acquireSetupConvergeLock({ home, pid = process.pid, now = Date.now, isPidAlive } = {}) {
  const stateDir = path.join(home, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, 'setup-converge.lock');

  const defaultIsAlive = p => {
    try {
      process.kill(p, 0);
      return true;
    } catch (e) {
      return e.code !== 'ESRCH';
    }
  };
  const aliveCheck = isPidAlive || defaultIsAlive;

  const tryCreateLock = () => {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') return null;
      throw e;
    }
    const data = JSON.stringify({ pid, startedAt: now() });
    fs.writeSync(fd, data);
    fs.closeSync(fd);
    return true;
  };

  if (tryCreateLock()) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const raw = fs.readFileSync(lockFile, 'utf8');
        const data = JSON.parse(raw);
        if (data.pid === pid) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    };
    return { acquired: true, lockFile, release };
  }

  let existingData = null;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    existingData = JSON.parse(raw);
  } catch {}

  const existingPid = existingData?.pid;
  const startedAt = typeof existingData?.startedAt === 'number'
    ? existingData.startedAt
    : Date.parse(existingData?.startedAt);

  const currentTime = now();
  const alive = existingPid ? aliveCheck(existingPid) : false;
  const within15Min = Number.isFinite(startedAt) && (currentTime - startedAt < 15 * 60 * 1000) && (currentTime >= startedAt);

  if (alive && within15Min) {
    return {
      acquired: false,
      existingPid,
      lockFile,
      reason: `setup --converge は別プロセス(pid=${existingPid})で実行中のためスキップ`,
    };
  }

  try {
    fs.unlinkSync(lockFile);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (tryCreateLock()) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const raw = fs.readFileSync(lockFile, 'utf8');
        const data = JSON.parse(raw);
        if (data.pid === pid) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    };
    return { acquired: true, lockFile, release };
  }

  return {
    acquired: false,
    existingPid,
    lockFile,
    reason: `setup --converge は別プロセス(pid=${existingPid})で実行中のためスキップ`,
  };
}