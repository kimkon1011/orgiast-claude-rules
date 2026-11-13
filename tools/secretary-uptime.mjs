#!/usr/bin/env node
// One bounded repair pass. No LLM, Discord or network-dependent bootstrap.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';

const exec = promisify(execFile);
const DAY = 86400000;
const URL_PUBLIC = 'https://claude-pc.tailc5d751.ts.net/secretary';
export const targets = {
  gateway: 'http://127.0.0.1:3939/', secretary: 'http://127.0.0.1:3940/secretary', external: URL_PUBLIC,
};
export async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual', cache: 'no-store' });
    await response.arrayBuffer();
    return { ok: response.status === 200 || response.status === 401, status: response.status };
  } catch (error) { return { ok: false, error: error.name === 'TimeoutError' ? 'HTTP timeout' : error.cause?.code || error.name }; }
}

export async function repairPass(io, previous = {}, now = Date.now()) {
  const repairs = [], errors = [];
  const inspect = async () => Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([name, url]) => [name, await io.probe(url)])));
  const before = await inspect();
  let backend;
  try { backend = await io.backend(); } catch (error) { errors.push(`tailscale status: ${error.message}`); }
  const causes = Object.keys(before).filter(key => !before[key].ok);
  if (backend !== 'Running') causes.push('tailscale');
  const attempt = async (name, fn) => { try { await fn(); repairs.push(name); } catch (error) { errors.push(`${name}: ${error.message}`); } };
  if (backend !== 'Running') await attempt('tailscale-up', io.up);
  if (backend !== 'Running' || !before.external.ok) await attempt('funnel', io.funnel);
  for (const name of ['secretary', 'gateway']) if (!before[name].ok) await attempt(`restart-${name}`, () => io.restart(name));
  let after = before;
  // Allow Next to become ready without an unbounded process or task wait.
  for (let i = 0; i < 3 && causes.length; i++) {
    await io.wait(2000);
    after = await inspect();
    if (Object.values(after).every(result => result.ok)) break;
  }
  const events = (previous.events || []).filter(event => event.at > now - DAY);
  // A persistent outage counts once; a recovery followed by another failure is a new incident.
  const ongoing = previous.activeCauses || [];
  for (const cause of causes) if (!ongoing.includes(cause)) events.push({ at: now, cause });
  const recurring = [...new Set(events.map(event => event.cause))].filter(cause => events.filter(event => event.cause === cause).length >= 3);
  const failed = Object.keys(after).filter(key => !after[key].ok);
  if (errors.length && causes.includes('tailscale')) failed.push('tailscale');
  const signature = JSON.stringify({ failed: [...new Set(failed)].sort(), recurring: recurring.sort() });
  const alert = failed.length > 0 || recurring.length > 0;
  let notified = previous.notified || null;
  const shouldNotify = alert && (!notified || notified.signature !== signature || now - notified.at >= 6 * 3600000);
  if (shouldNotify) {
    try {
      await io.notify(`秘書アプリの監視: 未復旧=${failed.join(',') || 'なし'}、24時間に3回以上=${recurring.join(',') || 'なし'}。原因=${causes.join(',')}。修復=${repairs.join(',') || 'なし'}。エラー=${errors.join('; ') || 'なし'}。外部HTTP=${after.external.status || after.external.error}。`);
      notified = { signature, at: now };
    } catch (error) { errors.push(`kim-inbox: ${error.message}`); }
  }
  const activeCauses = [...new Set(failed)];
  const state = { events, activeCauses, notified, checkedAt: new Date(now).toISOString(), before, after, repairs, errors };
  return { state, ok: failed.length === 0 && errors.length === 0 };
}

export async function main() {
  if (process.platform !== 'win32') throw new Error('This watchdog must run on Windows kim-PC');
  const home = process.env.ORGIAST_HOME || os.homedir();
  const dir = path.join(home, '.claude', 'secretary-uptime');
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'run.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let info = {};
    try { info = JSON.parse(await fs.readFile(lock, 'utf8')); } catch { /* A crash can leave an empty lock. */ }
    if (Date.now() - (await fs.stat(lock)).mtimeMs < 240000) return;
    if (Number.isInteger(info.pid) && info.pid > 0) {
      try { process.kill(info.pid, 0); throw new Error('watchdog lock owner is still alive'); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
    }
    await fs.rename(lock, `${lock}.stale-${Date.now()}`);
    handle = await fs.open(lock, 'wx');
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  const run = async (exe, args, timeout = 20000) => (await exec(exe, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 })).stdout;
  const ts = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const tools = path.dirname(fileURLToPath(import.meta.url));
  const stateFile = path.join(dir, 'state.json');
  try {
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { state, ok } = await repairPass({
      probe,
      backend: async () => JSON.parse(await run(ts, ['status', '--json'])).BackendState,
      up: async () => {
        // `up` with preference flags requires re-specifying all non-default settings.
        // `set` preserves the existing hostname/routes; the command timeout bounds login waits.
        await run(ts, ['set', '--unattended=true']);
        await run(ts, ['up'], 25000);
      },
      funnel: () => run(ts, ['funnel', '--bg', '--https=443', '--set-path=/', 'http://127.0.0.1:3939']),
      restart: name => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'secretary-restart.ps1'), '-Service', name], 30000),
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      notify: async body => {
        const bodyFile = path.join(dir, 'notification.txt');
        await fs.writeFile(bodyFile, body, 'utf8');
        await run(process.execPath, [path.join(tools, 'kim-inbox.mjs'), '--add', '--kind', 'ask', '--source', 'secretary-uptime', '--body-file', bodyFile], 30000);
      },
    }, previous);
    const temp = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2));
    await fs.rename(temp, stateFile);
    await fs.appendFile(path.join(dir, 'history.jsonl'), `${JSON.stringify(state)}\n`);
    console.log(JSON.stringify({ checkedAt: state.checkedAt, external: state.after.external, repairs: state.repairs, errors: state.errors }));
    process.exitCode = ok ? 0 : 1;
  } finally { await handle.close(); await fs.unlink(lock); }
}
if (isEntry(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
