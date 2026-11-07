#!/usr/bin/env node
// Remote Control session metadata only; no LLM/search requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostExitArchive } from './lib/host-exit-archive.mjs';
import { isEntry } from './is-entry.mjs';
const BASE = 'https://api.anthropic.com/v1/code/sessions';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function hasConversation(rows, bytes = 0) {
  return bytes > 200 * 1024 || rows.some(row => {
    if (!['user', 'assistant'].includes(row.type)) return false;
    let c = row.message?.content;
    if (Array.isArray(c)) c = c.map(x => x?.text ?? '').join(' ');
    return typeof c === 'string' && !!c.trim() && (row.type === 'assistant' || !/<local-command-caveat>|<command-name>|<command-message>/.test(c));
  });
}
export function hasHostExit(events, since, until) {
  return events.some(e => e.event_type === 'system' && e.payload?.reason === 'host_exit'
    && Date.parse(e.created_at) >= Date.parse(since) && Date.parse(e.created_at) <= Date.parse(until));
}
export function exclusion(local, closed, alive) {
  if (!local || !local.cwd) return 'noLocal';
  if (closed.has(local.id)) return 'closed';
  if (!local.hasConversation) return 'empty';
  if (alive.has(local.id)) return 'alive';
  return null;
}
export function parseAgents(output) {
  const agents = JSON.parse(output);
  if (!Array.isArray(agents) || agents.some(a => !a?.kind || (a.kind === 'interactive' && !a.sessionId))) throw Error('Invalid agents inventory');
  return new Set(agents.filter(a => a.kind === 'interactive').map(a => a.sessionId));
}
function run(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8', windowsHide: true, timeout: 65000 });
  if (result.error || result.status !== 0) throw Error(`${path.basename(command)} failed: ${result.error?.message ?? result.status}`);
  return result.stdout.trim();
}
function ps(script, spawn) { return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], spawn); }
const quotePS = s => "'" + s.replaceAll("'", "''") + "'";
export function resolveCodeCli(env = process.env, exists = fs.existsSync) {
  const candidates = [env.VSCODE_CLI_PATH, path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', 'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd'];
  const cli = candidates.find(x => x && exists(x));
  if (!cli) throw Error('code.cmd not found');
  return cli;
}
export function localIndex(base, onlyId) {
  const index = new Map();
  const projects = path.join(base, 'projects');
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === '_deleted-backup') continue;
    for (const file of fs.readdirSync(path.join(projects, dir.name))) {
      if (!file.endsWith('.jsonl') || (onlyId && file !== `${onlyId}.jsonl`)) continue;
      const raw = fs.readFileSync(path.join(projects, dir.name, file), 'utf8');
      // Most archived transcripts have no bridge. Avoid parsing gigabytes of tool output.
      if (!raw.includes('"bridge-session"')) continue;
      const lines = raw.split('\n');
      const parse = line => { try { return JSON.parse(line); } catch { return {}; } };
      const bridges = lines.filter(line => /"type"\s*:\s*"bridge-session"/.test(line)).map(parse)
        .filter(row => row.type === 'bridge-session' && row.bridgeSessionId);
      if (!bridges.length) continue;
      let cwd;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('"cwd"')) continue;
        const row = parse(lines[i]);
        if (typeof row.cwd === 'string' && row.cwd) { cwd = row.cwd; break; }
      }
      const bytes = Buffer.byteLength(raw);
      const conversation = bytes > 200 * 1024 || hasConversation(lines.map(parse), bytes);
      for (const bridge of bridges) {
        index.set(bridge.bridgeSessionId, { id: file.slice(0, -6), cwd, hasConversation: conversation });
      }
    }
  }
  return index;
}
function closedIds(base) {
  const ledger = readJson(path.join(base, 'closed-sessions.json'), { ids: [] });
  if (!Array.isArray(ledger.ids)) throw Error('Invalid closed ledger');
  return new Set(ledger.ids);
}
function reopenLoopCounts(base, nowFn = Date.now) {
  const logFile = path.join(base, 'reopen-lost-sessions.log');
  const counts = {};
  try {
    const raw = fs.readFileSync(logFile, 'utf8');
    const nowTime = typeof nowFn === 'function' ? nowFn() : nowFn;
    const cutoff = nowTime - 24 * 3600 * 1000;
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (!entry.at || !Array.isArray(entry.reopened)) continue;
        if (Date.parse(entry.at) < cutoff) continue;
        for (const r of entry.reopened) {
          const id = r?.id || r;
          if (id) counts[id] = (counts[id] || 0) + 1;
        }
      } catch {}
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return counts;
}
export function parseOptions(args, spawn = spawnSync) {
  const options = { dryRun: false, max: 30, gapSec: 10, watch: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--watch') { options.watch = true; continue; }
    const key = { '--since': 'since', '--until': 'until', '--max': 'max', '--gap-sec': 'gapSec' }[arg];
    if (!key || !args[i + 1]) throw Error(`Invalid option: ${arg}`);
    if (key === 'max') options.maxSet = true;
    options[key] = ['max', 'gapSec'].includes(key) ? Number(args[++i]) : args[++i];
  }
  if (options.watch && (options.since || options.until)) throw Error('--watch and --since/--until are mutually exclusive');
  if (!Number.isInteger(options.max) || options.max < 1 || !Number.isFinite(options.gapSec) || options.gapSec < 0) throw Error('Invalid max/gap');
  if (!options.watch) {
    if (!options.since || !options.until) {
      const boot = Date.parse(ps('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")', spawn));
      options.since ??= new Date(boot - 15 * 60000).toISOString();
      options.until ??= new Date(boot + 15 * 60000).toISOString();
    }
    if (!Number.isFinite(Date.parse(options.since)) || !Number.isFinite(Date.parse(options.until)) || Date.parse(options.since) > Date.parse(options.until)) throw Error('Invalid time range');
  }
  return options;
}
export function acquireLock(file, now = Date.now()) {
  try { if (now - fs.statSync(file).mtimeMs > 600000) fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  fs.writeSync(fd, String(process.pid));
  const timer = setInterval(() => { const date = new Date(); fs.futimesSync(fd, date, date); }, 30000);
  timer.unref();
  return () => { clearInterval(timer); fs.closeSync(fd); fs.unlinkSync(file); };
}
export async function reopenLost({ since, until, dryRun = false, max = 30, gapSec = 10,
  base = path.join(os.homedir(), '.claude'), fetchImpl = fetch, spawn = spawnSync, wait = sleep,
  now = Date.now, windowReady, codeCli } = {}) {
  const result = { at: new Date(now()).toISOString(), since, until, candidates: [], reopened: [], skipped: { closed: 0, empty: 0, alive: 0, noLocal: 0, archivedByUser: 0, reopenLoop: 0 } };
  // Dry run is strictly read-only: no lock or log mutation on the user's PC.
  const release = dryRun ? () => {} : acquireLock(path.join(base, 'reopen-lost-sessions.lock'));
  if (!release) return { ...result, error: 'locked' };
  try {
    const token = readJson(path.join(base, '.credentials.json')).claudeAiOauth?.accessToken;
    const org = readJson(path.join(base, '..', '.claude.json')).oauthAccount?.organizationUuid;
    if (!token || !org) throw Error('Missing RC credentials');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org };
    const cli = path.join(base, '..', '.local', 'bin', 'claude.exe');
    const alive = () => parseAgents(run(cli, ['agents', '--json'], spawn));
    const living = alive();
    const locals = localIndex(base), closed = closedIds(base);
    const reopenCounts = reopenLoopCounts(base, now);
    const deadline = now() + 60000;
    const get = async url => {
      if (now() >= deadline) throw Error('API time limit');
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.max(1, deadline - now())) });
      if (!response.ok) throw Error(`RC API HTTP ${response.status}`);
      return response.json();
    };
    let cursor = '';
    const seen = new Set(), seenIds = new Set();
    try {
      do {
        const body = await get(`${BASE}?${new URLSearchParams({ limit: '100', ...(cursor && { cursor }) })}`);
        if (!Array.isArray(body.data)) throw Error('Invalid sessions response');
        const sessions = body.data.filter(session => !Number.isFinite(Date.parse(session.updated_at)) || Date.parse(session.updated_at) >= Date.parse(since));
        for (let offset = 0; offset < sessions.length; offset += 6) {
          const batch = await Promise.allSettled(sessions.slice(offset, offset + 6).map(async session => {
            const events = await get(`${BASE}/${encodeURIComponent(session.id)}/events?limit=20`);
            if (!Array.isArray(events.data)) throw Error('Invalid events response');
            return { session, events: events.data };
          }));
          for (const item of batch) {
            if (item.status !== 'fulfilled') continue;
            const { session, events } = item.value;
            if (!hasHostExit(events, since, until)) continue;
            const local = locals.get(session.id);
            const reason = exclusion(local, closed, living);
            if (reason) { result.skipped[reason]++; continue; }
            // Skip user-archived sessions (closed via mobile etc.)
            if (session.status === 'archived' && !hostExitArchive(events)) { result.skipped.archivedByUser++; continue; }
            // Skip sessions reopened 3+ times in the last 24h (infinite reopen guard)
            if (reopenCounts[local?.id] >= 3) { result.skipped.reopenLoop++; continue; }
            if (!local || seenIds.has(local.id)) continue;
            seenIds.add(local.id);
            result.candidates.push({ id: local.id, cwd: local.cwd, title: session.title ?? '' });
          }
          const failed = batch.find(item => item.status === 'rejected');
          if (failed) throw failed.reason;
        }
        cursor = body.next_cursor || '';
        if (cursor && seen.has(cursor)) throw Error('Repeated API cursor');
        seen.add(cursor);
      } while (cursor);
    } catch (error) { result.apiError = error.message; }
    if (!dryRun && result.candidates.length) {
      const code = codeCli || resolveCodeCli();
      for (const candidate of result.candidates.slice(0, max)) {
        // Recheck after fetching and between opens: close/purge may have happened meanwhile.
        const refreshed = [...localIndex(base, candidate.id).values()].find(l => l.id === candidate.id);
        const reason = exclusion(refreshed, closedIds(base), alive());
        if (reason) { result.skipped[reason]++; continue; }
        try {
          ps(`& ${quotePS(code)} ${quotePS(candidate.cwd)}; exit $LASTEXITCODE`, spawn);
          const ready = windowReady || (() => ps(`$w = @(Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.Contains(${quotePS(path.win32.basename(candidate.cwd))}) }); if ($w.Count) { 'ready' }`, spawn) === 'ready');
          let found = false;
          for (let elapsed = 0; elapsed <= 60; elapsed++) {
            if (await ready(candidate.cwd)) { found = true; break; }
            if (elapsed < 60) await wait(1000);
          }
          if (!found) throw Error('VS Code window timeout');
          const current = [...localIndex(base, candidate.id).values()].find(l => l.id === candidate.id);
          const lateReason = exclusion(current, closedIds(base), alive());
          if (lateReason) { result.skipped[lateReason]++; continue; }
          // Focus again immediately before URI dispatch to reduce focus races.
          ps(`& ${quotePS(code)} ${quotePS(candidate.cwd)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ${quotePS(code)} --open-url ${quotePS('vscode://anthropic.claude-code/open?session=' + encodeURIComponent(candidate.id))}; exit $LASTEXITCODE`, spawn);
          result.reopened.push(candidate);
        } catch (error) { (result.failed ??= []).push({ ...candidate, error: error.message }); }
        await wait(gapSec * 1000);
      }
      // Post-reopen verification: wait 90s then check which sessions are actually connected
      if (result.reopened.length) {
        await wait(90000);
        try {
          const agents = alive();
          result.verified = [];
          result.unverified = [];
          for (const r of result.reopened) {
            if (agents.has(r.id)) result.verified.push(r.id);
            else result.unverified.push(r.id);
          }
        } catch (e) { result.verifyError = e.message; }
      }
    }
  } catch (error) { result.error = error.message; }
  finally {
    try { if (!dryRun) fs.appendFileSync(path.join(base, 'reopen-lost-sessions.log'), JSON.stringify(result) + '\n'); }
    finally { release(); }
  }
  return result;
}
export async function watchReopen(opts = {}, maxParam) {
  let base, max, dryRun, fetchImpl, spawn, wait, nowFn, codeCli;
  if (typeof opts === 'string' || opts === undefined) {
    base = opts ?? path.join(os.homedir(), '.claude');
    max = maxParam ?? 10;
    dryRun = false;
    nowFn = Date.now;
  } else {
    base = opts.base ?? path.join(os.homedir(), '.claude');
    max = opts.max ?? 10;
    dryRun = opts.dryRun ?? false;
    fetchImpl = opts.fetchImpl;
    spawn = opts.spawn;
    wait = opts.wait;
    nowFn = opts.now ?? Date.now;
    codeCli = opts.codeCli;
  }
  const stateFile = path.join(base, 'reopen-lost-sessions-state.json');
  const state = readJson(stateFile, {});
  const nowTime = nowFn();
  const minSince = new Date(nowTime - 24 * 3600 * 1000).toISOString();
  const defaultSince = new Date(nowTime - 30 * 60000).toISOString();
  let since;
  const wmTime = state.watermark ? Date.parse(state.watermark) : NaN;
  if (Number.isFinite(wmTime)) {
    since = wmTime < Date.parse(minSince) ? minSince : state.watermark;
  } else {
    since = defaultSince;
  }
  const until = new Date(nowTime - 60000).toISOString();
  const result = await reopenLost({
    since, until, max, dryRun, base, fetchImpl, spawn, wait, now: nowFn, codeCli
  });
  if (!result.error && !result.apiError && !dryRun) {
    fs.writeFileSync(stateFile, JSON.stringify({ watermark: until }) + '\n');
  }
  return result;
}
if (isEntry(import.meta.url)) {
  try {
    const opts = parseOptions(process.argv.slice(2));
    if (opts.watch) {
      const result = await watchReopen({
        base: opts.base,
        max: opts.maxSet ? opts.max : 10,
        dryRun: opts.dryRun,
      });
      console.log(JSON.stringify(result));
      if (result.error || result.apiError || result.failed?.length || result.unverified?.length) process.exitCode = 1;
    } else {
      const result = await reopenLost(opts);
      console.log(JSON.stringify(result));
      if (result.error || result.apiError || result.failed?.length || result.unverified?.length) process.exitCode = 1;
    }
  } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
