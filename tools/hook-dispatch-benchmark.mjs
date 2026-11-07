#!/usr/bin/env node
// Each sample starts a fresh dispatcher. Preload receipts count real Node main
// processes and Worker constructions, including helpers inside hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { defaultRepo, repositoryHooks, collapseHooks, runtimeManifestPath } from './hook-dispatch-registry.mjs';

export function benchmark(repo = defaultRepo, { samples = 20 } = {}) {
  if (!Number.isInteger(samples) || samples < 1) throw new Error('samples must be a positive integer');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-fanout-benchmark-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
    const registration = collapseHooks(repositoryHooks(repo, home), repo);
    // kim-PC has 21 repository Bash hooks plus a retained PowerShell copy of
    // pipe-stage-permissions. Exercise 22 real hooks portably using its existing
    // Node equivalent; native PowerShell startup is outside this measurement.
    const pipe = registration.manifest.events.PreToolUse.find(h => h.name === 'pipe-stage-permissions.mjs');
    registration.manifest.events.PreToolUse.unshift({ ...pipe, critical: true });
    fs.writeFileSync(runtimeManifestPath(home), JSON.stringify(registration.manifest));
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: registration.hooks }));
    const receipt = path.join(home, 'processes.jsonl'), preload = path.join(home, 'record-process.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';
import threads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
const record = type => fs.appendFileSync(process.env.HOOK_BENCH_RECEIPT, JSON.stringify({type,pid:process.pid,ppid:process.ppid})+'\\n');
if(threads.isMainThread) {
  record('node');
  threads.Worker = class extends threads.Worker { constructor(...args) { super(...args); record('worker'); } };
  syncBuiltinESMExports();
}
`);
    const env = { ...process.env, ORGIAST_HOME: home, HOME: home, USERPROFILE: home, HOOK_BENCH_RECEIPT: receipt,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, CLAUDE_HEADLESS: '' };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo dispatcher-probe' }, session_id: 'benchmark' });
    const measurements = [];
    for (let i = 0; i < samples; i++) {
      fs.writeFileSync(receipt, '');
      const started = performance.now();
      const result = spawnSync(process.execPath, [path.join(repo, 'tools/hook-dispatch.mjs'), 'PreToolUse'], { input, env, encoding: 'utf8', timeout: 45000, windowsHide: true });
      const wallMs = Math.round(performance.now() - started);
      if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
      const records = fs.readdirSync(path.join(home, '.claude/hook-metrics')).filter(n => n.endsWith('.jsonl')).sort();
      const metrics = JSON.parse(fs.readFileSync(path.join(home, '.claude/hook-metrics', records.at(-1)), 'utf8').trim().split('\n').at(-1));
      const receipts = fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      measurements.push({ wallMs, dispatchMs: metrics.durationMs, hooks: metrics.hooks.length,
        workersCreated: receipts.filter(r => r.type === 'worker').length,
        nodeProcesses: receipts.filter(r => r.type === 'node').length, childProcesses: metrics.childProcesses,
        timedOut: metrics.timedOut, skipped: metrics.skipped, errors: metrics.hooks.filter(h => h.status !== 0 || h.criticalUnfinished).length });
    }
    const sorted = measurements.map(m => m.wallMs).sort((a, b) => a - b);
    const p50Ms = sorted[Math.ceil(samples * 0.5) - 1], p95Ms = sorted[Math.ceil(samples * 0.95) - 1];
    return { event: 'PreToolUse', tool: 'Bash', fleet: 'kim-PC', platform: `${process.platform}/${process.arch}`, node: process.version,
      workload: '21 repository Bash hooks + Node equivalent of kim-PC retained pipe-stage-permissions PowerShell hook; pre-registered manifest',
      samples, percentileMethod: 'nearest-rank; fresh dispatcher per sample; includes CLI startup and teardown', p50Ms, p95Ms,
      meetsLatencyBudget: p50Ms <= 1500 && p95Ms <= 4000,
      complete: measurements.every(m => m.hooks === 22 && !m.timedOut && !m.skipped && !m.errors), measurements };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
if (isEntry(import.meta.url)) {
  try {
    const result = benchmark(defaultRepo, { samples: Number(process.argv.find(a => a.startsWith('--samples='))?.split('=')[1] || 20) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete || (process.argv.includes('--check') && !result.meetsLatencyBudget)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
