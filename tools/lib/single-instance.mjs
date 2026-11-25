import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const held = new Map();

function lockPath(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid lock name: ${name}`);
  return path.join(process.env.ORGIAST_LOCK_HOME || os.homedir(), '.claude', 'locks', `${name}.lock`);
}

function ownerIsCurrent(record, now = Date.now()) {
  const pid = Number(record?.pid);
  const started = Date.parse(record?.startedAt);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(started) || now - started > MAX_AGE_MS) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireLock(name) {
  const file = lockPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`); }
      finally { fs.closeSync(fd); }
      held.set(name, file);
      return { acquired: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let record = null;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (ownerIsCurrent(record)) return { acquired: false, ownerPid: Number(record.pid) };
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') continue; }
    }
  }
  return { acquired: false };
}

export function releaseLock(name) {
  const file = held.get(name) || lockPath(name);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(record?.pid) === process.pid) fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  } finally {
    held.delete(name);
  }
  return true;
}

function releaseAll() { for (const name of [...held.keys()]) releaseLock(name); }
process.once('exit', releaseAll);
process.once('uncaughtException', (error) => { releaseAll(); throw error; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { releaseAll(); process.exit(0); });

export const _singleInstance = { lockPath, ownerIsCurrent, MAX_AGE_MS };
