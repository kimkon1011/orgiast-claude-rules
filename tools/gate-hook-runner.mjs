#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { readContract, toolsDir } from './gate-contracts.mjs';
import { rolloutMode, applyGatePolicy } from './gate-runtime.mjs';

export async function runHook(script, raw, { args = [], timeout = 30000, env = process.env, policyOptions = {} } = {}) {
  const file = path.resolve(script);
  const execute = () => spawnSync(process.execPath, [file, ...args], { input: raw, encoding: 'utf8', env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  let child = execute();
  const parse = output => {
    for (const line of String(output).trim().split(/\r?\n/).reverse()) { try { return JSON.parse(line); } catch {} }
    return null;
  };
  const normalize = value => value?.hookSpecificOutput?.permissionDecision === 'deny'
    ? { decision: 'block', reason: value.hookSpecificOutput.permissionDecisionReason }
    : ['block', 'warn'].includes(value?.decision) ? value
      : value?.hookSpecificOutput?.additionalContext || value?.systemMessage ? { decision: 'warn', reason: value.hookSpecificOutput?.additionalContext || value.systemMessage } : { decision: 'pass' };
  let payload = parse(child.stdout);
  let result = child.status === 2 ? { decision: 'block', reason: child.stderr } : normalize(payload);
  if (!['block', 'warn'].includes(result.decision)) return child;
  let contract; try { contract = readContract(file); } catch {}
  // Informational hooks with no deny capability retain their own output.
  if (!contract && result.decision === 'warn') return child;
  const transformed = await applyGatePolicy(contract, result, {
    ...policyOptions, name: path.basename(file, '.mjs'),
    retry: () => { child = execute(); payload = parse(child.stdout); return child.status === 2 ? { decision: 'block', reason: child.stderr } : normalize(payload); },
  });
  if (!['block', 'warn'].includes(transformed?.decision)) return child;
  let input = {}; try { input = JSON.parse(raw); } catch {}
  const pre = input.hook_event_name === 'PreToolUse' || payload?.hookSpecificOutput?.hookEventName === 'PreToolUse' || Boolean(input.tool_name);
  if (transformed.decision === 'block') {
    payload = pre ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: transformed.reason } } : { decision: 'block', reason: transformed.reason };
  } else {
    const reason = `[gate warn: ${contract?.name || path.basename(file)}] ${transformed.reason}`;
    // Stop does not accept additionalContext: systemMessage is user-visible and non-blocking.
    payload = pre ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason } } : { systemMessage: reason };
  }
  return { ...child, status: 0, stdout: JSON.stringify(payload) + '\n' };
}
export function wrapRegisteredGates(settings, repo) {
  let changed = 0;
  if (!fs.existsSync(path.join(repo, 'tools/gate-hook-runner.mjs'))) return 0;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'tools/gate-rollout-manifest.json'), 'utf8'));
    for (const name of Object.keys(manifest.gates)) rolloutMode(name, { manifest });
  } catch { /* 同期途中は実行時にwarnへ倒す */ }
  for (const event of ['PreToolUse', 'Stop']) for (const group of settings.hooks?.[event] || []) for (const hook of group.hooks || []) {
    if (hook.type !== 'command' || hook.async || /gate-hook-runner\.mjs/.test(hook.command || '')) continue;
    const match = String(hook.command || '').match(/^node\s+"([^"]+\.mjs)"(.*)$/);
    if (!match) continue;
    const script = path.basename(match[1].replace(/\\/g, '/'));
    if (script === 'stop-gate-runner.mjs' || !fs.existsSync(path.join(repo, 'tools', script))) continue;
    // Migrate stale paths as well as new installations. Leave unrelated hooks alone.
    if (path.resolve(match[1]) !== path.resolve(repo, 'tools', script) && !readContract(path.join(repo, 'tools', script))) continue;
    hook.command = `node "${path.join(repo, 'tools', 'gate-hook-runner.mjs')}" "${path.join(repo, 'tools', script)}"${match[2]}`;
    hook.timeout = Math.max(Number(hook.timeout) || 10, 10) + 5;
    changed++;
  }
  return changed;
}
if (isEntry(import.meta.url)) {
  const script = process.argv[2];
  if (script && path.resolve(script) !== path.join(toolsDir, 'gate-hook-runner.mjs')) {
    const result = await runHook(script, await readStdinWithTimeout(), { args: process.argv.slice(3) });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status === 2 ? 2 : 0;
  }
}
