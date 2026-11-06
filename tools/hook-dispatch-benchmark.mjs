#!/usr/bin/env node
// Isolated, reproducible OS process count. Each node main process appends one
// receipt via --import, including grandchildren of the legacy gate wrapper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { defaultRepo, repositoryHooks, tokens } from './hook-dispatch-registry.mjs';
import { matches } from './hook-dispatch.mjs';

export function benchmark(repo = defaultRepo) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-fanout-benchmark-'));
  try {
    const receipt = path.join(home, 'processes.jsonl'), preload = path.join(home, 'record-process.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs'; import {isMainThread} from 'node:worker_threads'; if(isMainThread) fs.appendFileSync(process.env.HOOK_BENCH_RECEIPT, JSON.stringify({pid:process.pid,ppid:process.ppid})+'\\n');\n`);
    const env = { ...process.env, ORGIAST_HOME: home, HOME: home, USERPROFILE: home, HOOK_BENCH_RECEIPT: receipt,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, CLAUDE_HEADLESS: '' };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo dispatcher-probe' }, session_id: 'benchmark' });
    const old = repositoryHooks(repo, home).PreToolUse.filter(g => matches(g.matcher, 'PreToolUse', { tool_name: 'Bash' })).flatMap(g => g.hooks).filter(h => !h.async);
    let started = Date.now();
    for (const hook of old) {
      const [, ...args] = tokens(hook.command);
      const result = spawnSync(process.execPath, args, { input, env, encoding: 'utf8', timeout: hook.timeout * 1000, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Legacy ${args.at(-1)}: ${result.error?.message || result.stderr}`);
    }
    const before = { nodeProcesses: fs.readFileSync(receipt, 'utf8').trim().split('\n').length, hooks: old.length, serialMeasurementMs: Date.now() - started };
    fs.writeFileSync(receipt, '');
    started = Date.now();
    const result = spawnSync(process.execPath, [path.join(repo, 'tools/hook-dispatch.mjs'), 'PreToolUse'], { input, env, encoding: 'utf8', timeout: 45000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    const day = new Date().toISOString().slice(0, 10);
    const metrics = JSON.parse(fs.readFileSync(path.join(home, '.claude/hook-metrics', `${day}.jsonl`), 'utf8').trim().split('\n').at(-1));
    const after = { nodeProcesses: fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).length, hooks: metrics.hooks.length,
      childProcesses: metrics.childProcesses, timedOut: metrics.timedOut, skipped: metrics.skipped, durationMs: Date.now() - started };
    if (after.timedOut || after.skipped || metrics.hooks.some(h => h.status !== 0) || before.hooks !== after.hooks) throw new Error(`Incomplete dispatch: ${JSON.stringify(after)}`);
    return { event: 'PreToolUse', tool: 'Bash', before, after };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(benchmark(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
