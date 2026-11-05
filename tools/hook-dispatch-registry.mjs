import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { readContract } from './gate-contracts.mjs';

export const EVENTS = ['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop', 'Notification', 'SessionEnd', 'PostToolUse'];
export const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isDispatcher = hook => /(?:^|[\\/])hook-dispatch\.mjs["']?\s/.test(hook?.command || '');
export const runtimeManifestPath = home => path.join(home, '.claude', 'hook-dispatch-manifest.json');
export function tokens(command) {
  return [...String(command).matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}
export function describeHook(hook, matcher = '*', repo = defaultRepo) {
  const words = tokens(hook.command);
  const wrapped = /(?:^|[\\/])gate-hook-runner\.mjs$/.test(words[1] || '');
  const script = words[wrapped ? 2 : 1];
  const node = /(?:^|[\\/])node(?:\.exe)?$/.test(words[0] || '') && /\.mjs$/.test(script || '')
    && !/[;&|<>`\r\n]/.test(String(hook.command));
  let contract = null, source = '';
  if (node) { try { source = fs.readFileSync(script, 'utf8'); contract = readContract(script); } catch {} }
  const name = node ? path.basename(script.replace(/\\/g, '/')) : String(hook.command);
  // Unknown custom commands are conservative: never shed a potential deny gate.
  const critical = !!contract || /permissionDecision\s*:\s*['"]deny|decision\s*:\s*['"]block|exitCode\s*=\s*2\b/.test(source) || ['api-billing-guard.mjs', 'exec-tree-edit-guard.mjs', 'stop-gate-runner.mjs'].includes(name)
    || !node || !path.resolve(script).startsWith(path.resolve(repo) + path.sep);
  return { ...hook, matcher, name, node, script: node ? script : undefined,
    args: node ? words.slice(wrapped ? 3 : 2) : [], policy: wrapped, critical,
    timeout: hook.timeout };
}
export function repositoryHooks(repo = defaultRepo, home) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'tools/hook-dispatch-manifest.json'), 'utf8'));
  const hooks = {};
  for (const event of EVENTS) {
    hooks[event] = (manifest.events[event] || []).filter(h => h.scope !== 'kim-only' || resolveFleetLabel(home) === 'kim-PC').map(({ matcher, scope, ...h }) => ({
      ...(matcher === '*' ? {} : { matcher }), hooks: [{ ...h, command: h.command.replace(/\$\{repo\}\/([^"]+)/g, (_match, file) => path.join(repo, ...file.split('/'))) }],
    }));
  }
  return hooks;
}
export function collapseHooks(hooks, repo = defaultRepo) {
  const settingsHooks = {}, events = {};
  for (const event of EVENTS) {
    const asyncGroups = [];
    events[event] = [];
    for (const group of hooks[event] || []) {
      const asynchronous = [];
      for (const hook of group.hooks || []) {
        if (isDispatcher(hook)) continue;
        if (hook.async === true) asynchronous.push(hook);
        else {
          if (hook.type && hook.type !== 'command') throw new Error(`Cannot dispatch synchronous ${hook.type} hook in ${event}; existing settings must be preserved`);
          events[event].push(describeHook(hook, group.matcher || '*', repo));
        }
      }
      if (asynchronous.length) asyncGroups.push({ ...group, hooks: asynchronous });
    }
    // All hook deadlines start at dispatch admission, including queue time. The
    // OS never needs to kill the entire dispatcher just to stop one slow hook.
    const timeout = Math.max(1, ...events[event].map(h => Number(h.timeout) || 10)) + 10;
    settingsHooks[event] = [{ matcher: '*', hooks: [{ type: 'command', command: `node "${path.join(repo, 'tools/hook-dispatch.mjs')}" ${event}`, timeout }] }, ...asyncGroups];
  }
  for (const [event, groups] of Object.entries(hooks)) if (!EVENTS.includes(event)) settingsHooks[event] = groups;
  return { hooks: settingsHooks, manifest: { version: 1, repo, events } };
}
function sameRepo(a, b) {
  try {
    const normalize = file => process.platform === 'win32' ? fs.realpathSync(file).toLowerCase() : fs.realpathSync(file);
    return normalize(a) === normalize(b);
  } catch { return a === b; }
}
export function readDispatchManifest(home, repo = defaultRepo) {
  try {
    const saved = JSON.parse(fs.readFileSync(runtimeManifestPath(home), 'utf8'));
    if (saved.version === 1 && sameRepo(saved.repo, repo) && saved.events) return saved;
  } catch {}
  return collapseHooks(repositoryHooks(repo, home), repo).manifest;
}
export function effectiveHooks(settings, manifest) {
  const result = structuredClone(settings.hooks || {});
  for (const event of EVENTS) {
    let expanded = false;
    result[event] = (result[event] || []).flatMap(group => {
      if (!group.hooks?.some(isDispatcher)) return [group];
      const restored = expanded ? [] : (manifest?.events?.[event] || []).map(h => ({ matcher: h.matcher, hooks: [h] }));
      expanded = true;
      // A client may append a hook to the dispatcher group, or duplicate that
      // group. Preserve the appended hook without duplicating the manifest.
      const hooks = group.hooks.filter(h => !isDispatcher(h));
      return [...restored, ...(hooks.length ? [{ ...group, hooks }] : [])];
    });
  }
  return result;
}
export function dispatcherProblems(settings, repo = defaultRepo) {
  return EVENTS.filter(event => {
    const groups = settings?.hooks?.[event] || [];
    const sync = groups.flatMap(g => (g.hooks || []).filter(h => h.async !== true).map(h => ({ g, h })));
    return sync.length !== 1 || sync[0].g.matcher !== '*' || sync[0].h.command !== `node "${path.join(repo, 'tools/hook-dispatch.mjs')}" ${event}`;
  });
}
