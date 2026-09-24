#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadFablePolicy, fableAllowedForSupervisor } from './fable-policy.mjs';
import { resolveClaudeExecutableFromDisk } from './claude-exe.mjs';
import { autopilotPaths, runAutopilot, acquireLock } from './autopilot-tick.mjs';
import { isEntry } from './is-entry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildPrompt(repo = REPO) {
  const skill = fs.readFileSync(path.join(repo, 'skills', 'autopilot', 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return `${skill}\n\n<実行コンテキスト>\nrepo: ${repo}\n/autopilot tick を1周だけ実行する。ヘッドレスモード。ScheduleWakeup と /loop は使用しない。Codex はフォアグラウンドで完了まで待ち、post と必要な handoff を書いて終了する。次の起床はタスクスケジューラが担う。pre が error なら実装せず終了する。\n</実行コンテキスト>\n`;
}
export function invokeClaude({ executable, args, prompt, cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, launchError = null;
    const child = spawn(executable, args, { cwd, env: { ...env, CLAUDE_HEADLESS: '1', ORGIAST_HEADLESS_JOB: 'autopilot' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const killTree = () => {
      timedOut = true;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(killTree, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-16_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
    child.on('error', (error) => { launchError = error.code || error.message; });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, signal, stdout, stderr, timedOut, launchError }); });
    child.stdin.end(prompt);
  });
}
export async function runOnce(options = {}) {
  const paths = autopilotPaths(options);
  fs.mkdirSync(paths.dir, { recursive: true });
  const release = acquireLock(path.join(paths.dir, 'run.lock'));
  if (!release) return { skipped: 'already_running' };
  const record = (entry) => fs.appendFileSync(path.join(paths.dir, 'run.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  try {
    const pre = await runAutopilot('pre', {}, options);
    if (pre.verdict !== 'run' || pre.error) {
      if (pre.verdict && pre.reason !== 'not_started') await runAutopilot('handoff', {}, options);
      const result = { skipped: pre.reason || pre.error || pre.verdict };
      record(result); return result;
    }
    const before = await runAutopilot('status', {}, options);
    const policy = options.policy || loadFablePolicy();
    const model = fableAllowedForSupervisor(policy) ? 'claude-fable-5-1' : 'claude-opus-5';
    const repo = options.repo || REPO;
    const executable = options.executable || (await resolveClaudeExecutableFromDisk()).executable;
    const timeoutMs = options.timeoutMs ?? 25 * 60_000;
    const result = await (options.invokeImpl || invokeClaude)({ executable, args: ['-p', '--model', model, '--output-format', 'text'], prompt: buildPrompt(repo), cwd: repo, timeoutMs,
      env: { ...process.env, AUTOPILOT_HOME: paths.dir, ORGIAST_HOME: paths.home } });
    record({ model, ...result, stdout: String(result.stdout || '').slice(-4000) });
    const after = await runAutopilot('status', {}, options);
    // Failed/empty Claude turns still consume an iteration and trip the watchdog.
    if (after.state?.status === 'running' && after.state.totalIterations === before.state.totalIterations) {
      await runAutopilot('post', { summary: `ヘッドレス周回で post 未記録 (exit=${result.exitCode}${result.timedOut ? ', timeout' : ''})`, progress: pre.recentLog.at(-1)?.progress ?? 0, noop: true, 'next-delay': 1800 }, options);
    }
    const final = await runAutopilot('status', {}, options);
    if (final.state?.status !== 'running') await runAutopilot('handoff', {}, options);
    return { ...result, model, status: final.state?.status };
  } catch (error) {
    record({ error: error.code || error.message });
    await runAutopilot('pause', { reason: 'runner_error' }, options);
    await runAutopilot('handoff', {}, options);
    return { error: error.code || error.message };
  } finally { release(); }
}
if (isEntry(import.meta.url)) {
  const result = await runOnce();
  console.log(JSON.stringify(result));
  process.exitCode = result.error || result.exitCode ? 1 : 0;
}
