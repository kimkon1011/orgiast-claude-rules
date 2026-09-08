#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TYPES = new Set(['command', 'file-contains', 'file-nonempty', 'json-valid', 'scheduled-task']);
const SEVERITIES = new Set(['required', 'optional', 'manual']);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const converge = argv.includes('--converge');
const strict = argv.includes('--strict');
const jsonOutput = argv.includes('--json');
const home = path.resolve(valueAfter('--home') || process.env.USERPROFILE || os.homedir());
const manifestPath = path.resolve(valueAfter('--manifest') || path.join(scriptDir, 'setup-manifest.json'));

function invalid(message) {
  const item = { id: 'manifest:invalid', severity: 'required', status: 'NG', checked: true, repaired: false };
  if (jsonOutput) console.log(JSON.stringify({ items: [item] }));
  else console.log(`[NG ] manifest:invalid - manifest invalid: ${message}`);
  process.exitCode = 1;
}
function loadManifest() {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  if (raw.startsWith('\uFEFF')) throw new Error('BOM is not allowed');
  const manifest = JSON.parse(raw);
  if (manifest?.version !== 1 || !Array.isArray(manifest.items)) throw new Error('version/items schema error');
  const ids = new Set();
  for (const item of manifest.items) {
    if (!item || typeof item.id !== 'string' || !/^[\x21-\x7e]+$/.test(item.id) || ids.has(item.id)) throw new Error('item id must be unique ASCII');
    if (!TYPES.has(item.type) || !SEVERITIES.has(item.severity) || !item.spec || typeof item.description !== 'string') throw new Error(`invalid item schema: ${item.id}`);
    if (item.repair && (!Array.isArray(item.repair) || !item.repair.every((x) => typeof x === 'string'))) throw new Error(`invalid repair: ${item.id}`);
    ids.add(item.id);
  }
  return manifest;
}
const resolveHome = (relative) => path.resolve(home, ...String(relative).replaceAll('\\', '/').split('/'));
function readNonempty(target, kind) {
  const stat = fs.statSync(target);
  return kind === 'directory' ? stat.isDirectory() : stat.isFile() && stat.size > 0;
}
function nested(value, dotted) { return dotted.split('.').reduce((v, key) => v?.[key], value); }
function check(item) {
  try {
    const spec = item.spec;
    if (item.type === 'command') {
      const output = execFileSync(spec.command, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      return output.length > 0 && new RegExp(spec.versionRegex || '.+').test(output);
    }
    if (item.type === 'file-nonempty') {
      const candidates = (spec.paths || [spec.path]).map(resolveHome);
      if (spec.ifPresent && !candidates.some(fs.existsSync)) return null;
      return candidates.some((target) => readNonempty(target, spec.kind));
    }
    if (item.type === 'file-contains') {
      const raw = fs.readFileSync(resolveHome(spec.path), 'utf8');
      return spec.regex ? new RegExp(spec.regex).test(raw) : raw.includes(spec.contains);
    }
    if (item.type === 'json-valid') {
      const raw = fs.readFileSync(resolveHome(spec.path), 'utf8');
      if (spec.bom === false && raw.startsWith('\uFEFF')) return false;
      const parsed = JSON.parse(raw);
      return spec.requiredPath ? Boolean(nested(parsed, spec.requiredPath)) : true;
    }
    if (item.type === 'scheduled-task') {
      if (process.platform !== 'win32') return false;
      execFileSync('schtasks.exe', ['/Query', '/TN', spec.name], { stdio: 'ignore', timeout: 10000 });
      return true;
    }
  } catch { return false; }
  return false;
}
function repair(item) {
  if (!item.repair?.length) return false;
  try {
    const [script, ...args] = item.repair;
    const target = path.isAbsolute(script) ? script : path.join(scriptDir, script);
    execFileSync(process.execPath, [target, ...args], { timeout: 120000, stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home } });
    return true;
  } catch { return true; }
}
function inspect(items) { return items.map((item) => { const outcome = check(item); return { item, status: outcome === true ? 'OK' : outcome === null ? 'NOTICE' : 'NG', checked: true, repaired: false }; }); }
function emit(results) {
  if (jsonOutput) {
    console.log(JSON.stringify({ items: results.map(({ item, status, checked, repaired }) => ({ id: item.id, severity: item.severity, status, checked, repaired })) }));
    return;
  }
  for (const result of results) {
    const marker = result.status === 'OK' ? '[OK ]' : result.status === 'NOTICE' ? '[注意]' : '[NG ]';
    const hint = result.status === 'NG' && result.item.repairHint ? ` (修復: ${result.item.repairHint})` : '';
    console.log(`${marker} ${result.item.id} - ${result.item.description}${hint}`);
  }
}

let manifest;
try { manifest = loadManifest(); } catch (error) { invalid(String(error?.message || error).split(/\r?\n/)[0]); }
if (manifest) {
  let results = inspect(manifest.items);
  if (converge) {
    const attemptedCommands = new Set();
    const attemptedItems = new Set();
    for (let pass = 0; pass < 2; pass++) {
      const failing = results.filter((r) => r.status === 'NG' && r.item.repair && !attemptedCommands.has(JSON.stringify(r.item.repair)));
      if (!failing.length) break;
      for (const result of failing) {
        const key = JSON.stringify(result.item.repair);
        attemptedItems.add(result.item.id);
        if (!attemptedCommands.has(key)) { attemptedCommands.add(key); repair(result.item); }
      }
      results = inspect(manifest.items);
      for (const result of results) result.repaired = attemptedItems.has(result.item.id);
    }
  }
  emit(results);
  const requiredNg = results.some((r) => r.item.severity === 'required' && r.status === 'NG');
  process.exitCode = converge && !strict ? 0 : requiredNg ? 1 : 0;
}
