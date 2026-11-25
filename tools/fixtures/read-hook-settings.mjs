// Tests that inspect individual hook semantics must read the dispatch manifest;
// hook-dispatch.test.mjs separately asserts the physical settings fanout invariant.
import fs from 'node:fs';
import path from 'node:path';
import { effectiveHooks } from '../hook-dispatch-registry.mjs';
export function readHookSettings(file) {
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'hook-dispatch-manifest.json'), 'utf8')); } catch {}
  settings.hooks = effectiveHooks(settings, manifest);
  for (const groups of Object.values(settings.hooks)) for (const group of groups) {
    if (group.matcher === '*') delete group.matcher;
    group.hooks = group.hooks.map(({ matcher, name, node, script, args, policy, critical, ...hook }) => hook);
  }
  return settings;
}
export function copyDispatchRegistration(repo) {
  for (const name of ['hook-dispatch-registry.mjs', 'hook-dispatch-manifest.json', 'gate-contracts.mjs', 'env-kv.mjs', 'hook-dispatch.mjs', 'hook-dispatch-worker.mjs', 'is-entry.mjs', 'lib/hook-stdin.mjs', 'lib/fleet-label.mjs']) {
    const target = path.join(repo, 'tools', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve('tools', name), target);
  }
}
