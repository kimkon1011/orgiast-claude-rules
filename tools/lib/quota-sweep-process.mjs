import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function killTree(pid, { platform = process.platform, spawnImpl = spawnSync, killImpl = process.kill } = {}) {
  if (!pid) return;
  if (platform === 'win32') {
    const r = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`taskkill failed: ${r.status}`);
  } else {
    try { killImpl(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}

export function runBounded(command, args, { cwd, input = '', env = process.env, deadline, timeoutMs = 45 * 60_000,
  spawnImpl = spawn, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  kill = killTree, platform = process.platform, watchdog = true, monitor, monitorMs = 30_000 } = {}) {
  const stopAt = Math.min(deadline, now() + timeoutMs);
  if (!Number.isFinite(stopAt) || stopAt <= now()) return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: true });
  return new Promise((resolve) => {
    let child, guard, timer, poll, done = false, timedOut = false, stopReason, stdout = '', stderr = '';
    const stop = (reason) => {
      stopReason = reason;
      timedOut = reason === 'deadline';
      try { kill(child.pid); } catch (error) { stderr += `\nkill: ${error.message}`; }
    };
    const finish = (code) => {
      if (done) return;
      done = true;
      if (!stopReason && now() >= stopAt) { timedOut = true; stopReason = 'deadline'; }
      clearTimer(timer); clearTimer(poll);
      // Kill any descendants which retained the process group after the leader exited.
      if (platform !== 'win32') { try { kill(child?.pid); } catch {} }
      guard?.kill();
      resolve({ code, stdout, stderr, timedOut, stopReason });
    };
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32' });
      timer = setTimer(() => stop('deadline'), Math.max(0, stopAt - now()));
      // Independent watchdog survives a parent crash. WSL also has its own SIGKILL timeout.
      // Windows では detached にしない（新しいコンソールが可視化される。no-visible-console-window.test が禁止）。
      // Windows は親が死んでも子は生き残るので、attached のままでも watchdog は親クラッシュ後に動く。
      if (watchdog) {
        guard = spawnImpl(process.execPath, [fileURLToPath(new URL('./quota-sweep-watchdog.mjs', import.meta.url)), String(child.pid), String(process.pid), String(stopAt)], { stdio: 'ignore', windowsHide: true, detached: platform !== 'win32' });
        guard.on('error', error => { stderr += `watchdog: ${error.message}`; stop('failed'); });
        guard.unref();
      }
      child.stdout?.setEncoding('utf8').on('data', data => { stdout = (stdout + data).slice(-4_000_000); });
      child.stderr?.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-1_000_000); });
      child.once('error', error => { stderr += error.message; finish(null); });
      child.once('close', finish);
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
      const check = async () => {
        if (done) return;
        try { const reason = await monitor?.(); if (reason && !done) { stop(reason); return; } }
        catch { if (!done) { stop('failed'); return; } }
        if (!done) poll = setTimer(check, monitorMs);
      };
      if (monitor) poll = setTimer(check, monitorMs);
    } catch (error) { stderr += error.message; if (child) { try { kill(child.pid); } catch {} } finish(null); }
  });
}
