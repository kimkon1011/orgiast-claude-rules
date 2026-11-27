#!/usr/bin/env node
/**
 * 毎時ペースチェック: Claude Code プラン上限（アカウント単位・7日枠）を 90% 着地で使う。
 * 100% 超えは禁止。97% でハードストップ。対話セッションは殺さない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { fetchClaudePlanUsage } from './claude-plan-usage.mjs';
import { readCodexWindows } from './lib/quota-windows.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { downloadFileContent, findByTitle, findOrCreateFolder, uploadFileContent } from './lib/drive-files.mjs';
import { FOLDERS } from './hub-push.mjs';
import { buildClaudeHeadlessArgs } from './auto-session-executor.mjs';
import { resolveClaudeExecutableFromDisk, sanitizeClaudeSupervisorEnv } from './claude-exe.mjs';
import { runBounded } from './lib/quota-sweep-process.mjs';

export const PACE_VERSION = 1;
export const WINDOW_MS = 7 * 24 * 3600 * 1000;
export const HOLD_DEFAULT_MS = 90 * 60_000;
export const DEFAULT_TARGET_LANDING = 90;
export const DEFAULT_HARD_STOP = 97;
export const DEFAULT_FIVE_HOUR_SAFETY = 85;
export const DEFAULT_TOLERANCE_PT = 5;
export const DEFAULT_EARLY_WINDOW_TOLERANCE_BOOST = true;
export const DEFAULT_FINAL_PUSH_HOURS = 6;
export const DEFAULT_SWEEP_LEAD_MINUTES = 90;
export const DEFAULT_ACCOUNT_CONCURRENCY = 2;
export const DEFAULT_SESSION_LAUNCH_CAP = 27;
export const DEFAULT_STALE_MS = 3 * 3600_000;
export const LEDGER_KEEP_LINES = 400;

const WEIGHT_TIMEOUT_SEC = { small: 1800, medium: 3600, large: 5400 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function paceHoldPath(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'claude-pace-hold.json');
}

export function paceLedgerPath(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'claude-pace-ledger.jsonl');
}

export function defaultConfigPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'claude-pace.json');
}

export function loadPaceConfig(configPath = defaultConfigPath()) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/** @param {string[]} pcs @param {number} nowMs */
export function pickLeader(pcs, nowMs) {
  const list = Array.isArray(pcs) ? pcs.filter(Boolean) : [];
  if (!list.length) return null;
  const leaderIndex = Math.floor(Number(nowMs) / 3_600_000) % list.length;
  return list[leaderIndex];
}

/**
 * Drive 上の最新 ts が staleMs より古い PC をローテーションから外す。
 * @param {string[]} pcs
 * @param {Record<string, number|string|null|undefined>} lastSeenMap
 * @param {number} nowMs
 * @param {number} [staleMs]
 */
export function activePcs(pcs, lastSeenMap, nowMs, staleMs = DEFAULT_STALE_MS) {
  return (Array.isArray(pcs) ? pcs : []).filter((pc) => {
    const raw = lastSeenMap?.[pc];
    if (raw == null || raw === '') return false;
    const seen = typeof raw === 'number' ? raw : Date.parse(String(raw));
    return Number.isFinite(seen) && nowMs - seen <= staleMs;
  });
}

/**
 * @param {{
 *   nowMs: number,
 *   account: string,
 *   host: string,
 *   usage: {available:false, reason:string} | {available:true, fiveHour:{utilization:number,resetsAt:string|null}, sevenDay:{utilization:number,resetsAt:string|null}},
 *   sessionCount: number,
 *   runningPaceJobs: number,
 *   accountConcurrency?: number,
 *   sessionLaunchCap?: number,
 *   sweepActive?: boolean,
 *   isLeader?: boolean,
 *   forceBehind?: boolean,
 *   targetLanding?: number,
 *   hardStop?: number,
 *   fiveHourSafety?: number,
 *   tolerancePt?: number,
 *   earlyWindowToleranceBoost?: boolean,
 *   finalPushHours?: number,
 *   sweepLeadMinutes?: number,
 * }} input
 */
export function decidePace(input) {
  const {
    nowMs,
    usage,
    sessionCount = 0,
    runningPaceJobs = 0,
    accountConcurrency = DEFAULT_ACCOUNT_CONCURRENCY,
    sessionLaunchCap = DEFAULT_SESSION_LAUNCH_CAP,
    sweepActive = false,
    isLeader = false,
    forceBehind = false,
    targetLanding = DEFAULT_TARGET_LANDING,
    hardStop = DEFAULT_HARD_STOP,
    fiveHourSafety = DEFAULT_FIVE_HOUR_SAFETY,
    tolerancePt = DEFAULT_TOLERANCE_PT,
    earlyWindowToleranceBoost = DEFAULT_EARLY_WINDOW_TOLERANCE_BOOST,
    finalPushHours = DEFAULT_FINAL_PUSH_HOURS,
    sweepLeadMinutes = DEFAULT_SWEEP_LEAD_MINUTES,
  } = input || {};

  const base = {
    status: 'unmeasurable',
    target: null,
    actual: null,
    deltaPt: null,
    elapsedRatio: null,
    effectiveTolerance: null,
    projectedLanding: null,
    needsThrottle: false,
    launch: false,
    launchSlots: Math.max(0, accountConcurrency - runningPaceJobs),
    hold: false,
    reasons: [],
  };

  if (!usage || usage.available === false) {
    return { ...base, launch: false, hold: false, reasons: [`measure-failed:${usage?.reason || 'unknown'}`] };
  }

  const seven = usage.sevenDay || {};
  const five = usage.fiveHour || {};
  const resetsAtRaw = seven.resetsAt;
  if (resetsAtRaw == null || resetsAtRaw === '') {
    return { ...base, reasons: ['measure-failed:no-reset-at'] };
  }
  const resetsAtMs = Date.parse(resetsAtRaw);
  if (!Number.isFinite(resetsAtMs)) {
    return { ...base, reasons: ['measure-failed:no-reset-at'] };
  }

  const windowStart = resetsAtMs - WINDOW_MS;
  const elapsedRatio = clamp((nowMs - windowStart) / WINDOW_MS, 0, 1);
  const actual = Number(seven.utilization);
  const fiveUtil = Number(five.utilization);
  const target = targetLanding * elapsedRatio;
  const deltaPt = actual - target;
  const effectiveTolerance = earlyWindowToleranceBoost
    ? Math.max(tolerancePt, tolerancePt * 2 * (1 - elapsedRatio))
    : tolerancePt;
  const projectedLanding = elapsedRatio > 0.01 ? actual / elapsedRatio : null;
  const needsThrottle = projectedLanding != null && projectedLanding > 100;
  const launchSlots = Math.max(0, accountConcurrency - runningPaceJobs);
  const msToReset = resetsAtMs - nowMs;

  const result = {
    ...base,
    target,
    actual,
    deltaPt,
    elapsedRatio,
    effectiveTolerance,
    projectedLanding,
    needsThrottle,
    launchSlots,
  };

  // 4. ハードストップ
  if (actual >= hardStop || (Number.isFinite(fiveUtil) && fiveUtil >= hardStop)) {
    return { ...result, status: 'stopped', launch: false, hold: true, reasons: ['hard-stop-97'] };
  }

  let status;
  let wantLaunch = false;
  const reasons = [];

  if (forceBehind) {
    status = 'behind';
    wantLaunch = true;
  } else if (msToReset <= finalPushHours * 3600_000) {
    // 最終時間帯（97 未満なら final-push。90% 未満の押し込みが主目的だが 96% も最終帯として扱う）
    status = 'final-push';
    wantLaunch = true;
    if (sweepActive && msToReset <= sweepLeadMinutes * 60_000) {
      wantLaunch = false;
      reasons.push('defer-to-quota-sweep');
    }
  } else if (deltaPt < -effectiveTolerance) {
    status = 'behind';
    wantLaunch = true;
  } else if (Math.abs(deltaPt) <= effectiveTolerance) {
    status = 'onpace';
    wantLaunch = false;
  } else {
    status = 'ahead';
    wantLaunch = false;
  }

  let launch = wantLaunch;
  if (wantLaunch) {
    if (Number.isFinite(fiveUtil) && fiveUtil >= fiveHourSafety) {
      launch = false;
      reasons.push('5h-safety');
    }
    if (sessionCount >= sessionLaunchCap) {
      launch = false;
      reasons.push('session-cap');
    }
    if (isLeader !== true) {
      launch = false;
      reasons.push('not-leader');
    }
    if (launchSlots <= 0) {
      launch = false;
      reasons.push('concurrency');
    }
  }

  const hold = status === 'ahead' || status === 'stopped';
  return { ...result, status, launch, hold, reasons };
}

/**
 * 無人ランチャー（auto-session / quota-sweep）が追加起動を止めるための読み取り。
 * 対話セッションは対象外（kill しない）。
 * @param {string} home
 * @param {number} [now]
 * @returns {{hold:boolean, reason:string}}
 */
export function readPaceHold(home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now()) {
  try {
    const raw = JSON.parse(fs.readFileSync(paceHoldPath(home), 'utf8'));
    const until = Date.parse(raw?.until);
    const active = Boolean(raw?.hold) && Number.isFinite(until) && until > now;
    return { hold: active, reason: active ? String(raw?.reason || raw?.status || 'pace-hold') : '' };
  } catch {
    return { hold: false, reason: '' };
  }
}

export function writePaceHold(home, { account, host, hold, until, status, reason, writtenAt }) {
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    account: account || '',
    host: host || '',
    hold: Boolean(hold),
    until: until || new Date(Date.now() + HOLD_DEFAULT_MS).toISOString(),
    status: status || '',
    reason: reason || '',
    writtenAt: writtenAt || new Date().toISOString(),
  };
  fs.writeFileSync(paceHoldPath(home), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

export function resolveAccountForHost(config, host) {
  const accounts = config?.accounts || {};
  for (const [account, meta] of Object.entries(accounts)) {
    const pcs = Array.isArray(meta?.pcs) ? meta.pcs.map(String) : [];
    if (pcs.includes(String(host))) return { account, pcs };
  }
  return { account: 'unknown', pcs: [] };
}

export function countClaudeSessions({ home = process.env.ORGIAST_HOME || os.homedir(), spawnImpl = spawnSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    try {
      const script = "@(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }).Count";
      const r = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      if (r.status === 0) {
        const n = Number(String(r.stdout || '').trim());
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch { /* fall through */ }
  }
  // フォールバック: 直近のプロジェクト jsonl 件数（entrypoint は見ない簡易値）
  try {
    const root = path.join(home, '.claude', 'projects');
    let count = 0;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && e.name.endsWith('.jsonl')) count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export function countRunningPaceJobs({ home = process.env.ORGIAST_HOME || os.homedir(), spawnImpl = spawnSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    try {
      const script = "@(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -match 'headless:claude-pace' }).Count";
      const r = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      if (r.status === 0) {
        const n = Number(String(r.stdout || '').trim());
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch { /* fall through */ }
  }
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pace-jobs.json'), 'utf8'));
    return Array.isArray(state?.running) ? state.running.length : 0;
  } catch {
    return 0;
  }
}

export function detectSweepActive({ home, sevenDayResetsAt, nowMs = Date.now() } = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'quota-sweep-state.json'), 'utf8'));
    const resetsMs = sevenDayResetsAt ? Date.parse(sevenDayResetsAt) : NaN;
    const last = state?.lastRun?.claude || {};
    for (const [key, row] of Object.entries(last)) {
      if (row?.outcome !== 'running') continue;
      const keyMs = Number(key) || Date.parse(key);
      if (Number.isFinite(resetsMs) && Number.isFinite(keyMs) && Math.abs(keyMs - resetsMs) <= 5 * 60_000) return true;
      if (!Number.isFinite(resetsMs) && row?.outcome === 'running') return true;
    }
  } catch { /* ignore */ }
  try {
    const lock = path.join(home, '.claude', 'quota-sweep.lock');
    if (fs.existsSync(lock) && nowMs - fs.statSync(lock).mtimeMs < 60 * 60_000) return true;
  } catch { /* ignore */ }
  return false;
}

function appendLocalLedger(home, row) {
  const file = paceLedgerPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function trimJsonlLines(text, keep = LEDGER_KEEP_LINES) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  return `${lines.slice(-keep).join('\n')}${lines.length ? '\n' : ''}`;
}

/**
 * Drive 共有ハブ配下 claude-pace/pace-<host>.jsonl を read-modify-write（直近400行）。
 * 失敗しても throw せず driveError を返す。
 */
export async function appendDriveLedger({
  host,
  row,
  hubFolderId = FOLDERS.hub,
  getToken = getDriveToken,
  driveFiles = { findOrCreateFolder, findByTitle, downloadFileContent, uploadFileContent },
} = {}) {
  try {
    const token = await getToken();
    const folder = await driveFiles.findOrCreateFolder(token, 'claude-pace', hubFolderId);
    const folderId = folder?.id;
    if (!folderId) throw new Error('claude-pace folder missing');
    const name = `pace-${host}.jsonl`;
    const existing = await driveFiles.findByTitle(token, name, folderId);
    const fileId = existing?.[0]?.id;
    let previous = '';
    if (fileId) {
      const buf = await driveFiles.downloadFileContent(token, fileId);
      previous = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    }
    const next = trimJsonlLines(`${previous}${JSON.stringify(row)}\n`, LEDGER_KEEP_LINES);
    await driveFiles.uploadFileContent(token, {
      fileId: fileId || undefined,
      name,
      parentId: folderId,
      content: next,
      mimeType: 'text/plain',
      contentType: 'text/plain; charset=utf-8',
    });
    return { ok: true, folderId, fileId: fileId || null };
  } catch (error) {
    return { ok: false, driveError: error?.message || String(error) };
  }
}

/** 他ホストの最新 ts を Drive から集める（失敗時は空）。 */
export async function loadLastSeenMap({
  pcs,
  hubFolderId = FOLDERS.hub,
  getToken = getDriveToken,
  driveFiles = { findOrCreateFolder, findByTitle, downloadFileContent },
} = {}) {
  const map = {};
  try {
    const token = await getToken();
    const folder = await driveFiles.findOrCreateFolder(token, 'claude-pace', hubFolderId);
    const folderId = folder?.id;
    if (!folderId) return map;
    for (const pc of pcs || []) {
      try {
        const files = await driveFiles.findByTitle(token, `pace-${pc}.jsonl`, folderId);
        const fileId = files?.[0]?.id;
        if (!fileId) continue;
        const buf = await driveFiles.downloadFileContent(token, fileId);
        const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const row = JSON.parse(lines[i]);
            const ts = Date.parse(row?.ts);
            if (Number.isFinite(ts)) { map[pc] = ts; break; }
          } catch { /* skip */ }
        }
      } catch { /* skip host */ }
    }
  } catch { /* ignore */ }
  return map;
}

async function loadPickTasks() {
  try {
    const mod = await import('./claude-pace-queue.mjs');
    if (typeof mod.pickTasks === 'function') return mod.pickTasks;
  } catch { /* 実装B未着地でも単体テスト・計測は続行 */ }
  return null;
}

function weightTimeoutMs(weight) {
  const key = String(weight || 'medium').toLowerCase();
  return (WEIGHT_TIMEOUT_SEC[key] || WEIGHT_TIMEOUT_SEC.medium) * 1000;
}

function queuePath(home) {
  return path.join(home, '.claude', 'claude-pace-queue.json');
}

function readQueue(home) {
  try { return JSON.parse(fs.readFileSync(queuePath(home), 'utf8')); }
  catch { return { tasks: [] }; }
}

function writeQueue(home, queue) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(queuePath(home), `${JSON.stringify(queue, null, 2)}\n`);
}

async function launchPaceTasks({
  home,
  host,
  account,
  count,
  nowMs,
  dryRun,
  runChild = runBounded,
  resolveExe = resolveClaudeExecutableFromDisk,
}) {
  const pickTasks = await loadPickTasks();
  if (!pickTasks || count <= 0) return { launched: [], queue: readQueue(home), skipped: pickTasks ? 'count-0' : 'queue-module-missing' };
  const queue = readQueue(home);
  const picked = pickTasks({ queue, host, account, count, now: nowMs });
  const nextQueue = picked?.queue || queue;
  const tasks = Array.isArray(picked?.tasks) ? picked.tasks : [];
  const launched = [];
  if (dryRun) {
    writeQueue(home, nextQueue);
    return { launched: tasks.map((t) => ({ id: t.id, dryRun: true, promptPreview: String(t.prompt || '').slice(0, 120) })), queue: nextQueue };
  }
  let executable;
  try {
    executable = (await resolveExe({ ...process, env: { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_HOME: home } })).executable;
  } catch (error) {
    return { launched: [], queue: nextQueue, error: error.message };
  }
  if (!executable) return { launched: [], queue: nextQueue, error: 'Claude executable unavailable' };

  for (const task of tasks) {
    const repoCwd = task.repoCwd || task.cwd || path.join(home, '.claude', 'nightly-repo');
    const historyCwd = task.historyCwd || repoCwd;
    const args = buildClaudeHeadlessArgs({ repoCwd, historyCwd, model: 'opus' });
    const prompt = `[headless:claude-pace]\n${task.prompt || ''}`.trim();
    const timeoutMs = weightTimeoutMs(task.weight);
    const idx = (nextQueue.tasks || []).findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      nextQueue.tasks[idx] = { ...nextQueue.tasks[idx], state: '実行中', lastRunAt: new Date(nowMs).toISOString() };
      writeQueue(home, nextQueue);
    }
    const childEnv = {
      ...sanitizeClaudeSupervisorEnv(process.env),
      ORGIAST_HOME: home,
      CLAUDE_HEADLESS: '1',
      ORGIAST_HEADLESS_JOB: 'claude-pace',
    };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete childEnv[k];
    const result = await runChild(executable, args, {
      cwd: repoCwd,
      input: prompt,
      env: childEnv,
      deadline: nowMs + timeoutMs,
      timeoutMs,
    });
    const ok = result.code === 0 && !result.timedOut;
    if (idx >= 0) {
      nextQueue.tasks[idx] = {
        ...nextQueue.tasks[idx],
        state: ok ? '完了' : '失敗',
        lastExitCode: result.code,
        lastFinishedAt: new Date().toISOString(),
      };
      writeQueue(home, nextQueue);
    }
    launched.push({ id: task.id, code: result.code, timedOut: result.timedOut, ok });
  }
  return { launched, queue: nextQueue };
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    json: false,
    forceBehind: false,
    once: true,
    home: process.env.ORGIAST_HOME || os.homedir(),
    host: process.env.ORGIAST_HOSTNAME || os.hostname(),
    configPath: defaultConfigPath(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--force-behind') opts.forceBehind = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--home') opts.home = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--config') opts.configPath = argv[++i];
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const opts = parseArgs(argv);
  const home = io.home ?? opts.home;
  const host = String(io.host ?? opts.host);
  const nowMs = io.nowMs ?? Date.now();
  const config = io.config ?? loadPaceConfig(opts.configPath);
  const { account, pcs } = resolveAccountForHost(config, host);

  const usage = io.usage ?? await fetchClaudePlanUsage({ home, fetchImpl: io.fetchImpl });
  const sessionCount = io.sessionCount ?? countClaudeSessions({ home, spawnImpl: io.spawnImpl });
  const runningPaceJobs = io.runningPaceJobs ?? countRunningPaceJobs({ home, spawnImpl: io.spawnImpl });
  const sevenResetsAt = usage?.available ? usage.sevenDay?.resetsAt : null;
  const sweepActive = io.sweepActive ?? detectSweepActive({ home, sevenDayResetsAt: sevenResetsAt, nowMs });

  let lastSeenMap = io.lastSeenMap;
  if (!lastSeenMap) {
    lastSeenMap = account === 'unknown' ? {} : await loadLastSeenMap({
      pcs,
      getToken: io.getDriveToken,
      driveFiles: io.driveFiles,
    });
  }
  lastSeenMap = { ...lastSeenMap, [host]: nowMs };
  const live = activePcs(pcs, lastSeenMap, nowMs, (config.staleHours ?? 3) * 3600_000);
  const leader = pickLeader(live.length ? live : pcs, nowMs);
  const isLeader = io.isLeader ?? (account !== 'unknown' && leader === host);

  const decision = decidePace({
    nowMs,
    account,
    host,
    usage,
    sessionCount,
    runningPaceJobs,
    accountConcurrency: config.accountConcurrency ?? DEFAULT_ACCOUNT_CONCURRENCY,
    sessionLaunchCap: config.sessionLaunchCap ?? DEFAULT_SESSION_LAUNCH_CAP,
    sweepActive,
    isLeader,
    forceBehind: opts.forceBehind,
    targetLanding: config.targetLanding,
    hardStop: config.hardStop,
    fiveHourSafety: config.fiveHourSafety,
    tolerancePt: config.tolerancePt,
    earlyWindowToleranceBoost: config.earlyWindowToleranceBoost,
    finalPushHours: config.finalPushHours,
    sweepLeadMinutes: config.sweepLeadMinutes,
  });

  const holdUntil = new Date(nowMs + HOLD_DEFAULT_MS).toISOString();
  const holdReason = decision.reasons[0] || decision.status;
  if (!opts.dryRun || io.writeHoldOnDryRun) {
    writePaceHold(home, {
      account,
      host,
      hold: decision.hold,
      until: holdUntil,
      status: decision.status,
      reason: holdReason,
      writtenAt: new Date(nowMs).toISOString(),
    });
  }

  const codex = (() => {
    try {
      const windows = readCodexWindows({ home, now: nowMs });
      return (Array.isArray(windows) ? windows : []).map((w) => ({
        window: w.window,
        usedPercent: w.usedPercent,
      }));
    } catch {
      return [];
    }
  })();

  const row = {
    ts: new Date(nowMs).toISOString(),
    host,
    account,
    fiveHourPct: usage?.available ? usage.fiveHour.utilization : null,
    fiveHourResetsAt: usage?.available ? usage.fiveHour.resetsAt : null,
    sevenDayPct: usage?.available ? usage.sevenDay.utilization : null,
    sevenDayResetsAt: usage?.available ? usage.sevenDay.resetsAt : null,
    target: decision.target,
    deltaPt: decision.deltaPt,
    effectiveTolerance: decision.effectiveTolerance,
    projectedLanding: decision.projectedLanding,
    status: decision.status,
    launch: decision.launch,
    hold: decision.hold,
    reasons: decision.reasons,
    sessionCount,
    runningPaceJobs,
    codex,
    paceVersion: PACE_VERSION,
  };

  if (!opts.dryRun || io.writeLedgerOnDryRun) {
    try { appendLocalLedger(home, row); } catch (error) { row.localLedgerError = error.message; }
  }

  let drive = { ok: true };
  if (!opts.dryRun || io.writeDriveOnDryRun) {
    drive = await appendDriveLedger({
      host,
      row,
      getToken: io.getDriveToken,
      driveFiles: io.driveFiles,
    });
  }

  let launchResult = { launched: [] };
  if (decision.launch) {
    launchResult = await launchPaceTasks({
      home,
      host,
      account,
      count: decision.launchSlots,
      nowMs,
      dryRun: opts.dryRun,
      runChild: io.runChild,
      resolveExe: io.resolveExe,
    });
  }

  const report = {
    ...decision,
    account,
    host,
    leader,
    isLeader,
    sweepActive,
    row,
    driveError: drive.ok ? null : drive.driveError || null,
    launchResult: opts.dryRun || decision.launch ? launchResult : undefined,
  };

  const print = io.print ?? console.log;
  if (opts.json) print(JSON.stringify(report, null, 2));
  else {
    print(`claude-pace ${host} ${account} status=${decision.status} actual=${decision.actual ?? '?'} target=${decision.target == null ? '?' : decision.target.toFixed?.(1) ?? decision.target} launch=${decision.launch} hold=${decision.hold} reasons=${decision.reasons.join(',') || '-'}`);
  }
  return report;
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
