#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const __hookGuard = setTimeout(() => process.exit(0), 4000); __hookGuard.unref();

const SENSITIVE_VAR_PREFIXES = [
  'PATH=', 'LD_', 'DYLD_', 'PYTHONPATH=', 'PYTHONHOME=',
  'NODE_PATH=', 'GEM_PATH=', 'GEM_HOME=', 'RUBYLIB=',
  'PERL5LIB=', 'CLASSPATH=', 'GOPATH=',
];

export function splitStages(command) {
  const stages = [];
  let current = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  const value = String(command || '');
  for (let index = 0; index < value.length;) {
    const char = value[index];
    const next = value[index + 1];
    if (char === '\\' && !singleQuoted) {
      current += char;
      if (next !== undefined) { current += next; index += 2; } else index++;
      continue;
    }
    if (char === "'" && !doubleQuoted) { singleQuoted = !singleQuoted; current += char; index++; continue; }
    if (char === '"' && !singleQuoted) { doubleQuoted = !doubleQuoted; current += char; index++; continue; }
    if (!singleQuoted && !doubleQuoted && (char === '|' || char === ';' || (char === '&' && next === '&'))) {
      stages.push(current); current = ''; index += char === '&' ? 2 : 1; continue;
    }
    current += char;
    index++;
  }
  if (current) stages.push(current);
  return stages;
}

export function matchesAllowed(command, allowedPrefixes) {
  let value = String(command || '').trimStart();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    const assignmentPrefix = value.match(/^([A-Za-z_][A-Za-z0-9_]*=)/)?.[1] || '';
    if (SENSITIVE_VAR_PREFIXES.some(prefix => assignmentPrefix.startsWith(prefix))) return false;
    const assignment = value.match(/^[A-Za-z_][A-Za-z0-9_]*="[^"]*"\s+(.*)$/s)
      || value.match(/^[A-Za-z_][A-Za-z0-9_]*='[^']*'\s+(.*)$/s)
      || value.match(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+(.*)$/s);
    if (!assignment) break;
    value = assignment[1];
  }
  for (const prefix of allowedPrefixes || []) {
    if (value === prefix || value.startsWith(`${prefix} `)) return true;
  }
  return false;
}

async function main() {
  try {
    let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (!input?.tool_input?.command) return;
    const command = String(input.tool_input.command).split(/\r?\n/).filter(line => !/^\s*(?:#|$)/.test(line)).join('\n').trim();
    if (!command) return;
    const home = process.env.ORGIAST_HOME || os.homedir();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    const allowedPrefixes = new Set((settings?.permissions?.allow || []).flatMap(entry => {
      const match = typeof entry === 'string' ? entry.match(/^Bash\((.*)\)$/) : null;
      return match ? [match[1].replace(/:\*$/, '').replace(/\s\*$/, '')] : [];
    }));
    if (!allowedPrefixes.size) return;
    for (const stage of splitStages(command)) {
      const clean = stage.trim().replace(/\d*>&\d*/g, '').trim();
      if (!clean || /^\s*#/.test(clean)) continue;
      if (!matchesAllowed(clean, allowedPrefixes)) return;
    }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'All pipeline stages match allowed Bash prefixes' } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
