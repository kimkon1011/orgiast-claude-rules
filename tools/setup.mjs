#!/usr/bin/env node
import { distributePlaybooks } from './lib/playbook-distribution.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fleetHubNeedsConfiguration } from './register-fleet-mail.mjs';
import { convergeAllowRules } from './allow-rules.mjs';
import { convergeMobileStandby } from './mobile-standby.mjs';
export { classifyTaskActions } from './setup-task-hidden-actions.mjs';
import { inspectTaskHiddenActions } from './setup-task-hidden-actions.mjs';
import { convergeNodeRuntimeSecurity } from './setup-node-runtime-security.mjs';

const TYPES = new Set(['command', 'file-contains', 'file-nonempty', 'json-valid', 'scheduled-task']);
const SEVERITIES = new Set(['required', 'optional', 'manual']);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const valueAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const converge = argv.includes('--converge');
const strict = argv.includes('--strict');
const jsonOutput = argv.includes('--json');
const home = path.resolve(valueAfter('--home') || process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir());
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
  try {
    const stat = fs.statSync(target);
    return kind === 'directory' ? stat.isDirectory() : stat.isFile() && stat.size > 0;
  } catch (error) {
    // paths 配列の候補のうち存在しない側で throw すると候補全体が NG になるため、欠落は false で返す
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
function nested(value, dotted) { return dotted.split('.').reduce((v, key) => v?.[key], value); }
function checkTaskDetails(spec, info) {
  if (spec.requireActionTarget) {
    for (const action of info.actions || []) {
      // 引用された空白入りパスも拾い、exe や相対引数は検査対象にしない。
      const tokens = String(action).match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [];
      for (const token of tokens) {
        const target = token.replace(/^["']|["']$/g, '');
        if ((path.isAbsolute(target) || path.win32.isAbsolute(target))
          && /\.(mjs|js|ps1|vbs|cmd|bat)$/i.test(target) && !fs.existsSync(target)) return false;
      }
    }
  }
  if (typeof spec.maxRunAgeHours === 'number') {
    const lastRun = Date.parse(info.lastRunTime);
    // 初回実行前は登録直後にも起こるため、修復対象ではなく NOTICE にする。
    if (!Number.isFinite(lastRun) || lastRun < Date.UTC(2000, 0, 1)) return null;
    if (Date.now() - lastRun > spec.maxRunAgeHours * 3600000) return false;
  }
  return true;
}
function readTaskDetails(name) {
  const quotedName = "'" + name.replaceAll("'", "''") + "'";
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName ${quotedName}; $info=$task | Get-ScheduledTaskInfo; [pscustomobject]@{actions=@($task.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }); lastRunTime=$info.LastRunTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000,
    }).replace(/^\uFEFF/, ''));
  } catch {
    // 詳細取得だけの失敗で NG を増やさず、従来の登録有無の判定を残す。
    return null;
  }
}
function check(item) {
  try {
    if (item.scope === 'kim-only' && resolveFleetLabel(home) !== 'kim-PC') return null;
    const spec = item.spec;
    if (item.type === 'command') {
      // npm製CLIはWindowsでは .cmd シム(codex 等)で、execFileSync の直接指定では解決できない
      // (Node 18.20+ は shell 無しの .cmd/.bat 実行を拒否)。cmd.exe 経由で PATHEXT 解決させる。
      const raw = process.platform === 'win32'
        ? execFileSync('cmd.exe', ['/d', '/s', '/c', `${spec.command} --version`], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : execFileSync(spec.command, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const output = String(raw).trim();
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
      if (spec.hookEvent) {
        const hooks = parsed.hooks?.[spec.hookEvent]?.flatMap(group => group.hooks || []) || [];
        const knownToolsDirs = [
          path.join(home, 'orgiast-claude-rules', 'tools'),
          path.join(home, '.claude', 'nightly-repo', 'tools'),
          path.join(home, 'Downloads', 'orgiast-claude-rules', 'tools'),
          scriptDir,
        ];
        const expectedCommands = new Set(knownToolsDirs.map(toolsDir => spec.hookRunner
          ? `node "${path.join(toolsDir, spec.hookRunner)}" "${path.join(toolsDir, spec.hookScript)}"${spec.hookArgs ?? ''}`
          : `node "${path.join(toolsDir, spec.hookScript)}"${spec.hookArgs ?? ' --hook'}`));
        return hooks.some(hook => hook.type === 'command' && expectedCommands.has(hook.command)
          && (spec.async !== false ? hook.async === true : hook.async === undefined || hook.async === false)
          && hook.timeout === (spec.timeout ?? 5));
      }
      return spec.requiredPath ? Boolean(nested(parsed, spec.requiredPath)) : true;
    }
    if (item.type === 'scheduled-task') {
      if (typeof spec.ifPresent === 'string' && !fs.existsSync(resolveHome(spec.ifPresent))) return null;
      // 登録側(.ps1)が env のフラグでしか作らないタスクは、そのフラグが無い PC で永久に NG になる。
      // ifEnv を書いた項目はフラグ未設定を NOTICE として扱い、設定済みの PC だけで登録を検査する。
      if (spec.ifEnv) {
        let raw = '';
        try { raw = fs.readFileSync(resolveHome(spec.ifEnv.path), 'utf8'); } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
          throw error;
        }
        if (!new RegExp(spec.ifEnv.regex).test(raw)) return null;
      }
      if (spec.hubMode && fleetHubNeedsConfiguration({ home })) return false;
      if (spec.migrationMarker && !fs.existsSync(resolveHome(spec.migrationMarker))) return false;
      if (process.env.ORGIAST_SETUP_TASK_INFO_FIXTURE) {
        const fixture = JSON.parse(fs.readFileSync(process.env.ORGIAST_SETUP_TASK_INFO_FIXTURE, 'utf8'));
        const info = fixture[spec.name];
        return info?.registered === true ? checkTaskDetails(spec, info) : false;
      }
      if (process.platform !== 'win32') return false;
      execFileSync('schtasks.exe', ['/Query', '/TN', spec.name], { stdio: 'ignore', timeout: 10000, windowsHide: true });
      if (!spec.requireActionTarget && typeof spec.maxRunAgeHours !== 'number') return true;
      const info = readTaskDetails(spec.name);
      return info ? checkTaskDetails(spec, info) : true;
    }
  } catch { return false; }
  return false;
}
function repair(item) {
  if (!item.repair?.length) return false;
  try {
    const [script, ...args] = item.repair;
    const target = path.isAbsolute(script) ? script : path.join(scriptDir, script);
    execFileSync(process.execPath, [target, ...args], { timeout: 120000, stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true });
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
  let settingsMigration;
  if (converge) {
    const item = { id: 'classifier-settings', severity: 'required', description: 'hook登録・日次通知hook削除・allowルール同期' };
    try {
      // Let the registrar select the dedicated main anchor unless explicitly overridden.
      execFileSync(process.execPath, [path.join(scriptDir, 'register-hooks.mjs'), '--hooks-only'], {
        env: { ...process.env, ORGIAST_HOME: home },
        timeout: 30_000, stdio: 'pipe', windowsHide: true,
      });
      const repaired = convergeAllowRules(home);
      settingsMigration = { item, status: 'OK', checked: true, repaired };
    } catch (error) {
      settingsMigration = { item, status: 'NG', checked: true, repaired: false, reason: String(error?.message || error).split(/\r?\n/)[0] };
    }
  }
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
  if (converge) {
    const item = { id: 'playbooks', severity: 'optional', description: '成功した手作業手順の配布（既存の実測は保持）' };
    try { const copied = distributePlaybooks(path.dirname(scriptDir), home); results.push({ item, status: 'OK', checked: true, repaired: copied > 0 }); }
    catch { results.push({ item, status: 'NG', checked: true, repaired: false }); }
  }
  if (settingsMigration) results.push(settingsMigration);
  // スマホ用待機タブ: 拡張導入・count=3・mobileTabs=0 除去。--manifest 指定時(テスト/臨時検査)は実機を触らない。
  if (converge && !valueAfter('--manifest')) {
    const item = { id: 'mobile-standby', severity: 'optional', description: 'スマホ用 Claude Code 待機タブ3本（拡張導入・設定収束）' };
    try {
      const outcome = convergeMobileStandby({ home, repoRoot: path.dirname(scriptDir) });
      if (!jsonOutput) for (const line of outcome.lines) console.log(line);
      results.push({ item, status: outcome.ok ? 'OK' : 'NG', checked: true, repaired: Boolean(outcome.config?.changed || outcome.settings?.changed || outcome.extension?.status === 'installed' || outcome.rcPrefix?.changed),
        reason: outcome.ok ? '' : outcome.lines.filter((line) => /失敗|NG/.test(line)).join(' / ') });
    } catch { results.push({ item, status: 'NG', checked: true, repaired: false }); }
  }
  // 実機の更新は通常の converge のみ。verify / カスタム manifest は副作用なし。
  if (converge && !valueAfter('--manifest')) {
    const { description, ...outcome } = await convergeNodeRuntimeSecurity();
    results.push({ item: { id: 'node-runtime-security', severity: 'optional', description }, ...outcome });
  }
  if (converge && !valueAfter('--manifest')) {
    const { description, ...outcome } = inspectTaskHiddenActions({ converge });
    results.push({ item: { id: 'task-hidden-actions', severity: 'optional', description }, ...outcome });
  }
  emit(results);
  // fleet ビーコン: converge の結果を GAS へ送る。fail-open（exit code に一切影響させない）。
  // --manifest 指定時(テスト/臨時検査)は実機を触らない。FLEET_BEACON_ALLOW_MANIFEST=1 のときだけ許可。
  const beaconAllowed = converge && !argv.includes('--no-beacon') && process.env.FLEET_BEACON !== '0'
    && (!valueAfter('--manifest') || process.env.FLEET_BEACON_ALLOW_MANIFEST === '1');
  if (beaconAllowed) {
    try {
      const { buildBeacon, sendBeacon } = await import('./fleet-beacon.mjs');
      const beacon = buildBeacon({ home, results });
      const outcome = await sendBeacon(beacon, { home, timeoutMs: 15000 });
      if (!jsonOutput) console.log(`[beacon] ${outcome.ok ? 'sent' : outcome.skipped ? 'skip' : 'failed'}: ${outcome.reason || beacon.label}`);
    } catch (error) {
      if (!jsonOutput) console.log(`[beacon] failed: ${String(error?.message || error).split(/\r?\n/)[0]}`);
    }
  }
  const requiredNg = results.some((r) => r.item.severity === 'required' && r.status === 'NG');
  process.exitCode = settingsMigration?.status === 'NG' ? 1 : converge && !strict ? 0 : requiredNg ? 1 : 0;
}
