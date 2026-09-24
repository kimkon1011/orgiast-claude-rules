#!/usr/bin/env node
// Deterministic state machine. No LLM calls; all network access is injectable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';

const API = 'https://discord.com/api/v10';
const DEFAULTS = { maxIterPerDay: 20, maxHoursPerDay: 6, maxNoop: 3, maxTotalIter: 200 };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
export function dateKey(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
}
export function autopilotPaths(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const dir = options.dir || process.env.AUTOPILOT_HOME || path.join(home, '.claude', 'autopilot');
  return { home, dir, state: path.join(dir, 'state.json'), objective: path.join(dir, 'objective.md'), log: path.join(dir, 'log.jsonl'), handoff: path.join(home, '.claude', 'next-session.md') };
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
function writeObjective(file, objective) {
  // One editable source of truth, including multiline text escaped as JSON.
  fs.writeFileSync(file, `# autopilot objective\n\n目的・完了条件・上限（編集時も JSON を維持する）\n\n\`\`\`json\n${JSON.stringify(objective, null, 2)}\n\`\`\`\n`, 'utf8');
}
function readObjective(file) {
  const match = readText(file).match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error('invalid_objective');
  const value = JSON.parse(match[1]);
  validateObjective(value);
  return value;
}
function validateObjective(value) {
  if (typeof value.objective !== 'string' || !value.objective.trim()) throw new Error('objective_required');
  for (const key of Object.keys(DEFAULTS)) {
    if (!Number.isFinite(value[key]) || value[key] <= 0 || (key !== 'maxHoursPerDay' && !Number.isInteger(value[key]))) throw new Error(`invalid_${key}`);
  }
}
function readLog(file) {
  return readText(file).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
export function summarize(log, day) {
  const rows = log.filter((row) => dateKey(row.ts) === day);
  const times = rows.map((row) => Date.parse(row.ts));
  return {
    iterations: rows.length, hours: times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0,
    progressFrom: rows[0]?.progress ?? 0, progressTo: rows.at(-1)?.progress ?? 0,
    noop: rows.filter((r) => r.noop).length, codex: rows.filter((r) => r.codexUsed).length,
    summaries: rows.slice(-3).map((r) => r.summary), next: rows.at(-1)?.next ?? '未定',
  };
}
export function capReason(state, objective, today) {
  // A lifetime cap must never be downgraded to a resumable daily pause.
  if (state.totalIterations >= objective.maxTotalIter) return 'total_cap';
  if (state.iterationsToday >= objective.maxIterPerDay) return 'daily_iter_cap';
  if (today.hours >= objective.maxHoursPerDay) return 'daily_hours_cap';
  if (state.consecutiveNoop >= objective.maxNoop) return 'noop_streak';
  return null;
}
export function parseControl(text) {
  const value = String(text || '').trim();
  const change = value.match(/^目的変更[:：]\s*([\s\S]+)$/);
  if (change?.[1].trim()) return { command: 'objective', objective: change[1].trim() };
  if (/^(止めて|停止|stop)[。！!]?$/i.test(value)) return { command: 'stop' };
  if (/^(一時停止|pause)[。！!]?$/i.test(value)) return { command: 'pause' };
  if (/^(続けて|再開|continue|go)[。！!]?$/i.test(value)) return { command: 'run' };
  return null;
}
const validId = (id) => /^\d+$/.test(String(id ?? ''));
const compareId = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
function startSnowflake(startedAt) { return String(BigInt(Math.max(0, Date.parse(startedAt) - 1420070400000)) << 22n); }

async function readControls(state, ctx) {
  if (!ctx.token || !ctx.userId) return { messages: [], cursors: {}, errors: [] };
  const headers = { Authorization: `Bot ${ctx.token}`, 'Content-Type': 'application/json' };
  const request = async (url, init = {}) => {
    const response = await ctx.fetchImpl(`${API}${url}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`discord_http_${response.status}`);
    return response.json();
  };
  const channel = readText(path.join(ctx.home, '.claude', 'orgiast-autopilot-channel-id.txt'))
    || readText(path.join(ctx.home, '.claude', 'orgiast-inbox-channel-id.txt'));
  const channels = new Set(channel ? [channel] : []);
  const errors = [];
  try {
    const dm = await request('/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: ctx.userId }) });
    if (dm.id) channels.add(dm.id);
  } catch { errors.push('dm_unavailable'); }
  const messages = [], cursors = {};
  for (const id of channels) {
    // Separate cursors prevent a working channel from acknowledging unread messages
    // in another channel while its API request is failing.
    let cursor = state.controlCursors?.[id] || startSnowflake(state.startedAt);
    const pending = [];
    try {
      for (let page = 0; ; page++) {
        if (page >= 20) throw new Error('control_backlog');
        const batch = await request(`/channels/${encodeURIComponent(id)}/messages?after=${cursor}&limit=100`);
        if (!Array.isArray(batch)) throw new Error('invalid_messages');
        const newer = batch.filter((m) => validId(m.id) && compareId(m.id, cursor) > 0);
        pending.push(...newer);
        if (newer.length) cursor = newer.map((m) => m.id).sort(compareId).at(-1);
        if (batch.length < 100) break;
        if (!newer.length) throw new Error('control_cursor_stalled');
      }
      cursors[id] = cursor;
      messages.push(...pending.filter((m) => m.author?.id === ctx.userId && !m.author?.bot));
    } catch { errors.push(`channel_unavailable:${id}`); }
  }
  return { messages: messages.sort((a, b) => compareId(a.id, b.id)), cursors, errors };
}
export function formatDigest({ hostname, objective, summary, reason, completed = false }) {
  const heading = completed ? '完了' : reason ? `自動一時停止: ${reason}` : objective.objective.split(/\r?\n/)[0];
  return `[autopilot@${hostname}] ${heading}${reason || completed ? `\n${objective.objective.split(/\r?\n/)[0]}` : ''}\n昨日: ${summary.iterations}周 / 進捗 ${summary.progressFrom}%→${summary.progressTo}% / noop ${summary.noop} / Codex ${summary.codex}回\nやった: ${summary.summaries.map((s) => `・${s.replace(/\r?\n/g, ' ')}`).join('\n') || 'なし'}\n次: ${summary.next}\n判断: 「続けて」「止めて」「一時停止」「目的変更: …」をこのチャンネルに返信`;
}
function resumeState(state) {
  state.status = 'running'; state.pausedReason = null;
  // Explicit human continuation gives a stalled objective one fresh attempt.
  state.consecutiveNoop = 0;
}
export function renderHandoff(objective, state, log, target) {
  const recent = log.slice(-3).map((r) => r.summary.replace(/\r?\n/g, ' '));
  while (recent.length < 3) recent.unshift('記録なし');
  return `# autopilot 引き継ぎ\n\n## 次の1目的\n${objective.objective}\n\n## 対象\n${target}\n\n## 完了条件\n${objective.done || '未定（目的に照らして検証する）'}\n\n## 直前セッションの成果（3行）\n${recent.map((s) => `- ${s}`).join('\n')}\n\n## 残TODO（次の1件を先頭に）\n1. ${state.status === 'done' ? 'なし（完了）' : '直近の成果を検証し、目的に向けた次の1施策を選ぶ'}\n\n## 触る前に読む memory\n- 未指定（対象の既存 memory を確認）\n\n## 未決（kim の判断待ち）\n- ${state.pausedReason || 'なし'}\n`;
}

async function execute(command, args, ctx) {
  const { now, paths } = ctx;
  let state = readText(paths.state) ? JSON.parse(readText(paths.state)) : null;
  if (command === 'start') {
    if (state?.status === 'running') return { error: 'already_running' };
    const objective = { objective: args.objective?.trim(), done: args.done || '', ...DEFAULTS };
    for (const [flag, key] of Object.entries({ 'max-iter-per-day': 'maxIterPerDay', 'max-hours-per-day': 'maxHoursPerDay', 'max-noop': 'maxNoop', 'max-total-iter': 'maxTotalIter' })) {
      if (args[flag] !== undefined) objective[key] = Number(args[flag]);
    }
    validateObjective(objective);
    // Keep the previous objective's history, but don't charge it to a new run.
    if (state) {
      const archive = path.join(paths.dir, `archive-${now.getTime()}-${process.pid}`);
      fs.mkdirSync(archive, { recursive: true });
      for (const file of [paths.state, paths.objective, paths.log]) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(archive, path.basename(file)));
    }
    writeObjective(paths.objective, objective);
    fs.writeFileSync(paths.log, '', 'utf8');
    state = { startedAt: now.toISOString(), lastTickAt: null, iterationsToday: 0, dateKey: dateKey(now), consecutiveNoop: 0, totalIterations: 0, status: 'running', pausedReason: null, lastDigestDate: null, lastControlMessageId: null, controlCursors: {}, objectiveStartIteration: 0 };
    writeJson(paths.state, state);
    return { ok: true, status: state.status, objective };
  }
  if (!state) return { error: 'not_started', verdict: 'stop', reason: 'not_started' };
  const objective = readObjective(paths.objective);
  let log = readLog(paths.log);
  const todayKey = dateKey(now);
  if (state.dateKey !== todayKey) { state.dateKey = todayKey; state.iterationsToday = 0; }
  // Recover a completed log append if the process died before saving state.
  for (const row of log.filter((r) => r.iteration > state.totalIterations)) {
    state.totalIterations = row.iteration;
    if (dateKey(row.ts) === todayKey) state.iterationsToday++;
    state.consecutiveNoop = row.noop ? state.consecutiveNoop + 1 : 0;
    if (row.progress >= 100) { state.status = 'done'; state.pausedReason = null; }
  }
  const currentLog = () => log.filter((row) => row.iteration > (state.objectiveStartIteration || 0));
  const save = () => writeJson(paths.state, state);
  const notify = async (reason, completed = false, yesterday = false) => {
    const day = yesterday ? dateKey(new Date(now.getTime() - 86_400_000)) : todayKey;
    let text = formatDigest({ hostname: ctx.hostname, objective, summary: summarize(log, day), reason, completed });
    if (!yesterday) text = text.replace('\n昨日:', '\n今日:');
    try { return await notifyKim(text, { home: ctx.home, token: ctx.token, userId: ctx.userId, fetchImpl: ctx.fetchImpl, webhookFallback: false }); }
    catch { return { delivered: 'none' }; }
  };
  const watchdog = async () => {
    if (state.status !== 'running') return null;
    const reason = capReason(state, objective, summarize(log, todayKey));
    if (!reason) return null;
    state.status = reason === 'total_cap' ? 'stopped' : 'paused'; state.pausedReason = reason;
    save();
    await notify(reason);
    return { reason };
  };
  if (command === 'pre') {
    const result = await readControls(state, ctx);
    let control = null;
    for (const message of result.messages) {
      const parsed = parseControl(message.content);
      if (!parsed) continue;
      control = { command: parsed.command, text: message.content, from: message.author.id, messageId: message.id };
      if (parsed.command === 'objective') {
        objective.objective = parsed.objective; objective.done = '';
        writeObjective(paths.objective, objective); resumeState(state);
        state.objectiveStartIteration = state.totalIterations;
      }
      else if (parsed.command === 'run') {
        if (state.status !== 'done') resumeState(state);
      } else { state.status = parsed.command === 'stop' ? 'stopped' : 'paused'; state.pausedReason = `control_${parsed.command}`; }
      if (!state.lastControlMessageId || compareId(message.id, state.lastControlMessageId) > 0) state.lastControlMessageId = message.id;
    }
    state.controlCursors = { ...state.controlCursors, ...result.cursors };
    state.lastTickAt = now.toISOString();
    await watchdog();
    save();
    if (state.lastDigestDate !== todayKey) {
      const sent = await notify(null, false, true);
      if (sent.delivered === 'dm') { state.lastDigestDate = todayKey; save(); }
    }
    const today = summarize(log, todayKey);
    return { verdict: { running: 'run', paused: 'pause', stopped: 'stop', done: 'done' }[state.status], reason: state.pausedReason,
      objective, budget: { iterationsLeftToday: Math.max(0, objective.maxIterPerDay - state.iterationsToday), hoursLeftToday: Math.max(0, objective.maxHoursPerDay - today.hours), consecutiveNoop: state.consecutiveNoop }, control, recentLog: currentLog().slice(-5), controlErrors: result.errors };
  }
  if (command === 'post') {
    if (state.status !== 'running') return { error: 'not_running', status: state.status };
    const progress = Number(args.progress), nextDelaySec = Number(args['next-delay'] ?? 1500);
    if (!args.summary?.trim() || args.progress === undefined || !Number.isFinite(progress) || progress < 0 || progress > 100 || !Number.isFinite(nextDelaySec) || nextDelaySec < 0) return { error: 'invalid_post' };
    if (args['tokens-out'] !== undefined && (!Number.isFinite(Number(args['tokens-out'])) || Number(args['tokens-out']) < 0)) return { error: 'invalid_tokens_out' };
    const noop = Boolean(args.noop) || progress <= (currentLog().at(-1)?.progress ?? 0);
    const row = { ts: now.toISOString(), host: ctx.hostname, iteration: state.totalIterations + 1, summary: args.summary.trim(), progress, noop, codexUsed: Boolean(args.codex), nextDelaySec: noop ? Math.max(1800, nextDelaySec) : nextDelaySec };
    if (args['tokens-out'] !== undefined) row.tokensOut = Number(args['tokens-out']);
    fs.appendFileSync(paths.log, `${JSON.stringify(row)}\n`, 'utf8');
    log.push(row);
    state.totalIterations++; state.iterationsToday++; state.lastTickAt = now.toISOString(); state.consecutiveNoop = noop ? state.consecutiveNoop + 1 : 0;
    if (progress >= 100) {
      state.status = 'done'; state.pausedReason = null; save(); await notify(null, true);
      return { ok: true, watchdog: null, status: 'done', noop, nextDelaySec: row.nextDelaySec };
    }
    const fired = await watchdog(); save();
    return { ok: true, watchdog: fired, status: state.status, noop, nextDelaySec: row.nextDelaySec };
  }
  if (command === 'status') return { state, objective, today: summarize(log, todayKey) };
  if (command === 'handoff') {
    fs.mkdirSync(path.dirname(paths.handoff), { recursive: true });
    fs.writeFileSync(paths.handoff, renderHandoff(objective, state, currentLog(), paths.objective), 'utf8');
    return { ok: true, path: paths.handoff };
  }
  if (['stop', 'pause', 'resume'].includes(command)) {
    if (command === 'resume') {
      if (state.status === 'done') return { error: 'already_done', status: 'done' };
      resumeState(state);
    } else { state.status = command === 'stop' ? 'stopped' : 'paused'; state.pausedReason = args.reason || `manual_${command}`; }
    const fired = await watchdog(); save();
    return { ok: true, status: state.status, reason: state.pausedReason, watchdog: fired };
  }
  return { error: 'unknown_command' };
}

export function acquireLock(file) {
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readText(file));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return null; }
    catch (e) { if (e.code !== 'ESRCH') return null; }
    // Recover only a confirmed dead owner (never a timeout-based live lock).
    fs.unlinkSync(file);
    return acquireLock(file);
  }
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}

export async function runAutopilot(command, args = {}, options = {}) {
  const paths = autopilotPaths(options);
  fs.mkdirSync(paths.dir, { recursive: true });
  const lock = path.join(paths.dir, 'tick.lock');
  let release;
  try {
    // No age-based stealing: a slow Discord request must not permit concurrent writes.
    release = acquireLock(lock);
    if (!release) return { error: 'busy' };
    const home = paths.home;
    const token = options.token ?? (process.env.DISCORD_BOT_TOKEN?.trim() || readText(path.join(home, '.claude', 'orgiast-discord-bot-token.txt')));
    const userId = options.userId ?? (process.env.ORGIAST_DISCORD_USER_ID?.trim() || readText(path.join(home, '.claude', 'orgiast-discord-user-id.txt')));
    return await execute(command, args, { paths, home, token, userId, now: options.now || new Date(), hostname: options.hostname || os.hostname(), fetchImpl: options.fetchImpl || globalThis.fetch });
  } catch (error) { return { error: error.code || error.message || 'autopilot_error' }; }
  finally { release?.(); }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = Object.fromEntries(['objective', 'done', 'max-iter-per-day', 'max-hours-per-day', 'max-noop', 'max-total-iter', 'summary', 'progress', 'tokens-out', 'next-delay', 'reason'].map((key) => [key, { type: 'string' }]));
    for (const key of ['noop', 'codex', 'pretty']) options[key] = { type: 'boolean' };
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
    const result = await runAutopilot(positionals[0], values);
    if (values.pretty && result.state) result.text = `autopilot: ${result.state.status} / ${result.objective.objective}\n今日 ${result.today.iterations}周 / 合計 ${result.state.totalIterations}周 / 進捗 ${result.today.progressTo}% / ${result.state.pausedReason || '制限内'}`;
    console.log(JSON.stringify(result, null, values.pretty ? 2 : undefined));
  } catch (error) { console.log(JSON.stringify({ error: error.code || error.message })); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = await main();
