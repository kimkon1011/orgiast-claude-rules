#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { listScheduledTaskDetails, startScheduledTask, enableScheduledTask, taskResultIsNonFailure } from './lib/scheduled-task.mjs';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600000, DAY = 24 * HOUR;
const homeDefault = () => process.env.ORGIAST_HOME || os.homedir();
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const key = name => String(name).replace(/^\\/, '').toLowerCase();
const nonFailure = task => taskResultIsNonFailure(task.lastTaskResult, task) || Number(task.lastTaskResult) === 267014;
export const stamp = value => {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(text);
  if (dotNet) return Number(dotNet[1]);
  const local = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);
  if (local) return new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +local[6], +(local[7] || 0)).getTime();
  return Date.parse(text);
};

const isoPeriodHours = value => {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  return m ? (+m[1] || 0) * 24 + (+m[2] || 0) + (+m[3] || 0) / 60 + (+m[4] || 0) / 3600 : null;
};

export function expectedPeriodHours(triggers = []) {
  const periods = [].concat(triggers || []).filter(t => t.enabled !== false && t.Enabled !== false).map(t => {
    const interval = t.repetition?.interval ?? t.Repetition?.Interval;
    const intervalHours = isoPeriodHours(interval);
    const type = t.type ?? t.Type ?? t.CimClass?.CimClassName;
    const basePeriod = type === 'MSFT_TaskDailyTrigger' ? 24 * (t.daysInterval ?? t.DaysInterval ?? 1)
      : type === 'MSFT_TaskWeeklyTrigger' ? 168 * (t.weeksInterval ?? t.WeeksInterval ?? 1) : null;
    if (intervalHours !== null) {
      const duration = t.repetition?.duration ?? t.Repetition?.Duration;
      const durationHours = isoPeriodHours(duration);
      if (basePeriod && durationHours !== null && durationHours < basePeriod) return basePeriod - Math.floor(durationHours / intervalHours) * intervalHours;
      return intervalHours;
    }
    if (basePeriod) return basePeriod;
    return 0;
  }).filter(n => Number.isFinite(n) && n > 0);
  return periods.length ? Math.min(...periods) : null;
}

// Filesystem evidence and the applicable manifest are supplied by the caller: no IO here.
export function auditTasks(tasks, overrides = {}, now = Date.now(), { required = [], artifactMtimes = {}, expectDisabled = [] } = {}) {
  const findings = [], present = new Set(tasks.map(t => key(t.taskName)));
  const requiredNames = new Set(required.map(key));
  const expectDisabledNames = new Set(expectDisabled.map(key));
  const options = new Map(Object.entries(overrides).map(([name, value]) => [key(name), value]));
  for (const task of tasks) {
    const name = task.taskName, override = options.get(key(name)) || {};
    if (override.ignore) continue;
    // 登録必須だが意図的に無効（後継へ移行済み）。存在確認だけし、有効化・起動しない。
    if (expectDisabledNames.has(key(name))) continue;
    const add = (kind, extra = {}) => findings.push({ name, kind, lastRunTime: task.lastRunTime, ...extra });
    if (task.state === 'Disabled') { if (requiredNames.has(key(name))) add('disabled_required'); continue; }
    const period = expectedPeriodHours(task.triggers);
    const maxAgeHours = override.maxAgeHours ?? (period === null ? null : Math.max(2, period * 1.5 + 1));
    if (!(maxAgeHours > 0)) continue;
    const last = stamp(task.lastRunTime);
    if (['Ready', 'Running'].includes(task.state) && (!Number.isFinite(last) || new Date(last).getUTCFullYear() <= 1999 || +now - last > maxAgeHours * HOUR)) add('missed');
    if (task.lastTaskResult != null && !nonFailure(task)) add('failed');
    for (const artifact of override.artifacts || []) {
      const mtime = artifactMtimes[artifact];
      if (!Number.isFinite(mtime) || +now - mtime > maxAgeHours * HOUR) add('artifact_stale', { artifact });
    }
  }
  for (const name of required) if (!present.has(key(name)) && !options.get(key(name))?.ignore) findings.push({ name, kind: 'missing_required' });
  return findings;
}

export function auditChangeGateImports(tasks, { toolsDir = dir, readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const files = new Set();
  for (const task of tasks) {
    const text = JSON.stringify(task);
    for (const match of text.matchAll(/(?:^|[\\/])([A-Za-z0-9._-]+\.mjs)\b/g)) files.add(match[1]);
  }
  const llm = /(?:llm-ask|codex-do|claude-ai-run|chat\/completions)/;
  return [...files].flatMap((name) => {
    try {
      const source = readFile(path.join(toolsDir, name));
      return llm.test(source) && !/lib[\\/]change-gate\.mjs/.test(source) ? [{ name, kind: 'missing_change_gate', severity: 'warn' }] : [];
    } catch { return []; }
  });
}

export function unresolvedTasks(tasks, findings, state, now = Date.now(), { required = [], expectDisabled = [] } = {}) {
  const requiredSet = new Set(required.map(key));
  const expectDisabledSet = new Set(expectDisabled.map(key));
  return Object.entries(state.heals || {}).flatMap(([name, heal]) => {
    if (heal.resolved || +now <= stamp(heal.at)) return [];
    const task = tasks.find(t => key(t.taskName) === key(name));
    // Disabled non-required tasks are intentionally retired → treat as resolved.
    // Required+expectDisabled も登録後無効が設計どおりなので resolved。
    if (task && task.state === 'Disabled' && (!requiredSet.has(key(name)) || expectDisabledSet.has(key(name)))) return [];
    if (task && expectDisabledSet.has(key(name))) return [];
    const stillBad = findings.some(f => key(f.name) === key(name));
    const ranAfterHeal = task && stamp(task.lastRunTime) > stamp(heal.at);
    const healthyNow = task && task.state !== 'Disabled' && !stillBad && nonFailure(task);
    return !task || stillBad || !(ranAfterHeal || healthyNow)
      ? [{ name, kind: 'unresolved', reason: heal.kind, at: heal.at }] : [];
  });
}

export async function healTasks(findings, { startScheduledTask: start, enableScheduledTask: enable, runConverge, state, now = Date.now(), save = () => {} }) {
  state.heals ??= {};
  const results = [], seen = new Set();
  let converged = false;
  for (const finding of findings) {
    const { name, kind } = finding;
    if (seen.has(key(name))) continue;
    seen.add(key(name));
    const previous = Object.entries(state.heals).find(([n]) => key(n) === key(name));
    if (previous && +now - stamp(previous[1].at) < DAY) continue;
    if (previous) delete state.heals[previous[0]];
    state.heals[name] = { at: new Date(now).toISOString(), kind };
    save(state); // Persist before side effects, including failed attempts.
    try {
      if (kind === 'missing_required') { if (!converged) { converged = true; await runConverge(); } }
      else { if (kind === 'disabled_required') await enable(name); await start(name); }
      results.push({ name, kind, attempted: true });
    } catch { results.push({ name, kind, attempted: true, error: '修復の起動に失敗' }); }
  }
  return results;
}

function background(args, { home, spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, { ...backgroundSpawnOptions(platform), stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home } });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function notifyUnresolved(body, { home, notify = notifyKim, spawnImpl = spawn } = {}) {
  try {
    const result = await notify(body, { home, plainJa: false, webhookFallback: false, signal: AbortSignal.timeout(5000) });
    if (result?.delivered && result.delivered !== 'none') return;
  } catch { /* A failed DM also uses the fleet route. */ }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-audit-')), 'body.txt');
  fs.writeFileSync(file, body, { mode: 0o600 });
  await background([path.join(dir, 'fleet-mail.mjs'), '--send', '--to', 'kim-PC', '--kind', 'note', '--body-file', file, '--why', '無人ジョブ未修復'], { home, spawnImpl });
}

export async function runAudit({ home = homeDefault(), platform = process.platform, now = Date.now(), dryRun = false,
  listTasks = listScheduledTaskDetails, overrides, required, expectDisabled, notify = notifyUnresolved,
  start = startScheduledTask, enable = enableScheduledTask, spawnImpl = spawn,
  recheckDelayMs = 90000, recheckAttempts = 2, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (platform !== 'win32') return { skip: 'unsupported platform', findings: [], unresolved: [], lines: ['skip: unsupported platform'] };
  const root = path.join(home, '.claude'), stateFile = path.join(root, 'unattended-job-audit-state.json');
  let locked = false;
  const lock = path.join(root, '.unattended-audit-lock');
  try {
    if (!dryRun) {
      fs.mkdirSync(root, { recursive: true });
      try { if (Date.now() - fs.statSync(lock).mtimeMs > HOUR) fs.unlinkSync(lock); } catch {}
      try { fs.closeSync(fs.openSync(lock, 'wx')); locked = true; } catch (e) { if (e.code === 'EEXIST') return { findings: [], unresolved: [], lines: [], skip: 'audit running' }; throw e; }
    }
    const tasks = await listTasks();
    overrides ??= read(path.join(dir, 'unattended-jobs.json'), {});
    const requiredItems = read(path.join(dir, 'setup-manifest.json'), { items: [] }).items.filter(i => i.type === 'scheduled-task' && i.severity === 'required'
      && (i.scope !== 'kim-only' || resolveFleetLabel(home) === 'kim-PC')
      && (!i.spec.ifPresent || fs.existsSync(path.join(home, i.spec.ifPresent)))
      && (!i.spec.migrationMarker || fs.existsSync(path.join(home, i.spec.migrationMarker))));
    required ??= requiredItems.map(i => i.spec.name);
    expectDisabled ??= requiredItems.filter(i => i.spec.expectDisabled).map(i => i.spec.name)
      .filter(name => required.some(r => key(r) === key(name)));
    const artifactMtimes = {};
    for (const o of Object.values(overrides)) for (const artifact of o.artifacts || []) {
      try { artifactMtimes[artifact] = fs.statSync(artifact.replace(/^~(?=[/\\])/, home)).mtimeMs; } catch { artifactMtimes[artifact] = null; }
    }
    const state = read(stateFile, { heals: {}, notified: {} });
    state.notified ??= {};
    const save = () => { fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2)); fs.renameSync(`${stateFile}.tmp`, stateFile); };
    const findings = auditTasks(tasks, overrides, now, { required, artifactMtimes, expectDisabled });
    const warnings = auditChangeGateImports(tasks);
    const unresolved = unresolvedTasks(tasks, findings, state, now, { required, expectDisabled });
    for (const name of Object.keys(state.heals || {})) if (!unresolved.some(f => f.name === name) && +now > stamp(state.heals[name].at)) { state.heals[name].resolved = true; delete state.notified[name]; }
    const heals = dryRun ? [] : await healTasks(findings, { startScheduledTask: start, enableScheduledTask: enable, runConverge: () => background([path.join(dir, 'setup.mjs'), '--converge'], { home, spawnImpl, platform }), state, now, save });
    const recheckable = heals.filter(heal => !heal.error && !['missing_required', 'disabled_required'].includes(heal.kind));
    for (let attempt = 0; recheckable.some(heal => !heal.recovered) && attempt < recheckAttempts; attempt++) {
      await sleep(recheckDelayMs);
      let current;
      try { current = await listTasks(); } catch { break; }
      for (const heal of recheckable) {
        const currentTask = current.find(candidate => key(candidate.taskName) === key(heal.name));
        const healedAt = state.heals[heal.name]?.at;
        if (currentTask && stamp(currentTask.lastRunTime) > stamp(healedAt)
          && nonFailure(currentTask) && currentTask.state !== 'Disabled') {
          heal.recovered = true;
          state.heals[heal.name].resolved = true;
          delete state.notified[heal.name];
          save();
        }
      }
    }
    const lines = unresolved.map(f => `🚨 未修復: ${f.name}（${f.reason}）`);
    if (!dryRun) {
      for (const finding of unresolved) {
        if (state.notified[finding.name] && +now - stamp(state.notified[finding.name]) < DAY) continue;
        try { await notify(`[${os.hostname()} / ${resolveFleetLabel(home)}] 🚨 未修復: ${finding.name}（${finding.reason}、修復試行 ${finding.at}）`, { home }); state.notified[finding.name] = new Date(now).toISOString(); }
        catch { lines.push(`🚨 通知失敗: ${finding.name}（次回再試行）`); }
      }
      save();
    }
    lines.push(...heals.map(f => f.recovered ? `✅ 回復: ${f.name}（${f.kind} → 再実行で成功）` : `🔧 再実行: ${f.name}（${f.kind}${f.error ? ` / ${f.error}` : ''}）`));
    for (const f of findings) if (!heals.some(h => h.name === f.name) && !unresolved.some(u => u.name === f.name)) lines.push(`⚠️ 異常: ${f.name}（${f.kind}）`);
    for (const warning of warnings) lines.push(`⚠️ 警告: ${warning.name}（${warning.kind}）`);
    if (!lines.length) lines.push(`✅ 監査 ${tasks.length}件: 異常なし`);
    const hasActiveFinding = findings.some(finding => !heals.some(heal => key(heal.name) === key(finding.name) && heal.recovered));
    if (!dryRun) fs.writeFileSync(path.join(root, 'unattended-job-audit-last.txt'), hasActiveFinding || unresolved.length ? lines.join('\n') : '');
    return { count: tasks.length, findings, warnings, unresolved, heals, lines };
  } catch {
    const result = { error: '計測不能', findings: [], unresolved: [], lines: ['無人ジョブ監査: 計測不能'] };
    if (!dryRun) try { fs.writeFileSync(path.join(root, 'unattended-job-audit-last.txt'), result.lines[0]); } catch {}
    return result;
  } finally { if (locked) try { fs.unlinkSync(lock); } catch {} }
}

export function auditContext(home, { now = Date.now(), staleHours = 6 } = {}) {
  try {
    const file = path.join(home, '.claude/unattended-job-audit-last.txt');
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(0, 3);
    if (!lines.length) return '';
    const ageHours = (+now - fs.statSync(file).mtimeMs) / HOUR;
    const age = ageHours > staleHours ? `（${ageHours.toFixed(1)}時間前の判定）` : '';
    return `[無人ジョブ監査]${age} ${lines.join(' / ')}`;
  } catch { return ''; }
}
export function launchAudit({ home = homeDefault(), now = Date.now(), intervalHours = 6, platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'win32') return false;
  const guard = path.join(home, '.claude/.unattended-audit-guard');
  let claimed = false;
  try {
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    try { if (+now - Number(fs.readFileSync(guard, 'utf8')) < intervalHours * HOUR) return false; fs.unlinkSync(guard); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.writeFileSync(guard, String(+now), { flag: 'wx' });
    claimed = true;
    const child = spawnImpl(process.execPath, [path.join(dir, 'unattended-job-audit.mjs'), '--quiet'], { ...backgroundSpawnOptions(platform), stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home } });
    child.on('error', () => { try { fs.unlinkSync(guard); } catch {} });
    child.unref();
    return true;
  } catch { if (claimed) try { fs.unlinkSync(guard); } catch {} return false; }
}
export async function main(argv = process.argv.slice(2), options = {}) {
  const result = await runAudit({ ...options, dryRun: argv.includes('--dry-run') });
  if (argv.includes('--json')) console.log(JSON.stringify(result));
  else if (!argv.includes('--quiet') || result.skip || result.error
    || result.findings.some(finding => !result.heals?.some(heal => key(heal.name) === key(finding.name) && heal.recovered))
    || result.unresolved.length) console.log(result.lines.join('\n'));
  return result;
}
if (isEntry(import.meta.url)) await main();
