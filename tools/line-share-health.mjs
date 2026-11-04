#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { sendDiscordDm } from './line-export-reminder.mjs';
import { readJsonLines, desktopProblems, desktopStartupProblems, desktopDailyReport, localDate } from './line-desktop-health.mjs';
const SIX_HOURS = 6 * 3600_000;
export async function probe({ base, token, fetchImpl = fetch, onCheck = () => {} }) {
  const problems = [];
  const checks = [
    ['manifest', '/manifest.json', {}, async r => r.status === 200 && Boolean((await r.json()).share_target)],
    ['unauthenticated', '/share', { method: 'POST', body: new URLSearchParams({ text: 'line-share-health-v1' }) }, async r => r.status === 303 && new URL(r.headers.get('location'), base).searchParams.get('share_error') === 'auth'],
    ['authenticated', '/share?healthcheck=1', { method: 'POST', headers: { Cookie: `cm_token=${token}` }, body: (() => { const f = new FormData(); f.set('probe', 'line-share-health-v1'); return f; })() }, async r => { const j = r.status === 200 ? await r.json() : {}; return j.ok === true && j.probe === 'line-share-health-v1'; }],
  ];
  for (const [name, route, options, validate] of checks) {
    onCheck({ check: name, phase: 'start' });
    try {
      if (name === 'authenticated' && !token) throw new Error('ACCESS_TOKEN missing');
      const response = await fetchImpl(new URL(route, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(25_000) });
      if (!await validate(response)) problems.push({ key: name, detail: `HTTP ${response.status}` });
      await response.body?.cancel().catch(() => {});
      onCheck({ check: name, status: response.status });
    } catch (e) { problems.push({ key: name, detail: e.message }); onCheck({ check: name, error: e.message }); }
  }
  return problems;
}
export function latestExportAge(debug, now) {
  let latest = null;
  for (const line of debug.split(/\r?\n/)) {
    try { const j = JSON.parse(line); const ts = Number(j.ts); if (j.kind === 'export-stored' && Number.isFinite(ts) && ts <= now) latest = Math.max(latest ?? 0, ts); } catch {}
  }
  return latest === null ? null : (now - latest) / 86_400_000;
}
export async function runHealth(options) {
  const { stateFile, debugFile, now = Date.now(), sendDm = sendDiscordDm, restart, dryRun = false } = options;
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  let problems = await probe(options);
  let recovery = 'not-needed';
  // Stale exports cannot be repaired by restarting the web server.
  if (problems.length && !dryRun && restart && (!state.restartAt || now - state.restartAt >= SIX_HOURS)) {
    state.restartAt = now;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    try { await restart(); recovery = 'attempted'; problems = await probe(options); }
    catch (e) { recovery = 'failed'; problems.push({ key: 'restart', detail: e.message }); }
  }
  let debug = ''; try { debug = fs.readFileSync(debugFile, 'utf8'); } catch {}
  const ageDays = latestExportAge(debug, now);
  if (ageDays === null || ageDays >= 7) problems.push({ key: 'stale-export', detail: ageDays === null ? '補助監視（7日）: export-stored記録なし' : `補助監視（7日）: 最終export-storedから${Math.floor(ageDays)}日` });
  let desktopRecovery = 'not-needed';
  const runs = readJsonLines(options.desktopRunsFile), events = readJsonLines(debugFile);
  if (options.desktopRunsFile) {
    let task = {};
    if (options.getDesktopTask) {
      try { task = await options.getDesktopTask(); }
      catch (e) { problems.push({ key: 'desktop-task-query', detail: e.message }); }
    }
    const desktop = desktopProblems({ runs, attempts: readJsonLines(options.desktopAttemptsFile), events, now });
    desktop.push(...desktopStartupProblems({ runs, task, now }));
    problems.push(...desktop);
    if (desktop.some(p => ['desktop-stale', 'desktop-not-starting'].includes(p.key)) && !dryRun && options.kickDesktop && (!state.desktopKickAt || now - state.desktopKickAt >= SIX_HOURS)) {
      state.desktopKickAt = now;
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
      try { await options.kickDesktop(); desktopRecovery = 'attempted'; }
      catch (e) { desktopRecovery = 'failed'; problems.push({ key: 'desktop-kick', detail: e.message }); }
    }
  }
  const dailyReport = options.desktopRunsFile ? desktopDailyReport({ runs, events, now, problems }) : null;
  if (dryRun && dailyReport) (options.output || console.log)(dailyReport);
  state.sent ??= {};
  const due = problems.filter(p => !state.sent[p.key] || now - state.sent[p.key] >= SIX_HOURS);
  // Persist the diagnosis even if Discord is unavailable. Unsent alerts remain due.
  if (!dryRun) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, checkedAt: now, problems, ageDays, recovery, desktopRecovery }));
  }
  if (due.length && !dryRun) {
    await sendDm({ home: options.home, message: `⚠️ LINE取り込みの監視（未起動3時間・PC経路36時間・補助7日）で異常を検出しました。\n${due.map(p => `${p.key}: ${p.detail}`).join('\n')}\n自動復旧: ${recovery} / PCタスク: ${desktopRecovery}\n${options.base}` });
    for (const p of due) state.sent[p.key] = now;
  }
  if (!dryRun) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ ...state, checkedAt: now, problems, ageDays, recovery, desktopRecovery })); }
  if (!dryRun && dailyReport && new Date(now).getHours() >= 21 && state.dailyReportDate !== localDate(now)) {
    await sendDm({ home: options.home, message: dailyReport });
    state.dailyReportDate = localDate(now);
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, checkedAt: now, problems, ageDays, recovery, desktopRecovery }));
  }
  return { dailyReport, problems, ageDays, recovery, desktopRecovery, notified: !dryRun && due.length > 0 };
}
export function desktopPowerShell(command, spawn = spawnSync) {
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; " + command], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (p.error || p.status !== 0) throw new Error(`ClaudeMobile-LineDesktopExport: ${p.error?.message || p.stderr || 'PowerShell failed'}`);
  return p.stdout.trim();
}
export function getDesktopTask(spawn = spawnSync) {
  return JSON.parse(desktopPowerShell("$t=Get-ScheduledTask -TaskName 'ClaudeMobile-LineDesktopExport'; $i=$t | Get-ScheduledTaskInfo; @{lastRunTime=$i.LastRunTime.ToString('o');runOnlyIfIdle=$t.Settings.RunOnlyIfIdle;enabled=$t.Settings.Enabled;state=$t.State.ToString()} | ConvertTo-Json -Compress", spawn));
}
export function recoverDesktopTask(spawn = spawnSync) {
  desktopPowerShell("$t=Get-ScheduledTask -TaskName 'ClaudeMobile-LineDesktopExport'; if($t.Settings.RunOnlyIfIdle){$t.Settings.RunOnlyIfIdle=$false; Set-ScheduledTask -TaskName $t.TaskName -Settings $t.Settings | Out-Null}; if((Get-ScheduledTask -TaskName $t.TaskName).Settings.RunOnlyIfIdle){throw 'RunOnlyIfIdle remains true'}; Start-ScheduledTask -TaskName $t.TaskName", spawn);
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.some(a => a !== '--dry-run')) throw new Error('Only --dry-run is supported');
  const home = os.homedir();
  const app = process.env.CLAUDE_MOBILE_DIR || path.join(home, 'Downloads', 'claude-mobile');
  createRequire(path.join(app, 'package.json'))('@next/env').loadEnvConfig(app);
  const store = process.env.LINE_STORE_DIR || path.join(home, '.claude', 'line-openchat');
  const onCheck = record => console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));
  onCheck({ phase: 'started', node: process.version });
  const result = await runHealth({ home, onCheck, base: process.env.LINE_SHARE_BASE_URL || 'https://claude-pc.tailc5d751.ts.net', token: process.env.ACCESS_TOKEN,
    stateFile: path.join(store, 'share-health-state.json'), debugFile: path.join(store, 'debug.jsonl'), dryRun: argv.includes('--dry-run'),
    desktopRunsFile: path.join(store, 'desktop-runs.jsonl'), desktopAttemptsFile: path.join(store, 'desktop-attempts.jsonl'),
    getDesktopTask: () => getDesktopTask(),
    kickDesktop: () => recoverDesktopTask(),
    restart: async () => {
      if (process.platform !== 'win32') throw new Error('Windows recovery required');
      const p = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts', 'restart-webserver.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
      if (p.error || p.status !== 0) throw new Error('ClaudeMobile-WebServer restart failed');
    },
  });
  console.log(JSON.stringify(result));
  return result.problems.length ? 1 : 0;
}
if (isEntry(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 1; });
