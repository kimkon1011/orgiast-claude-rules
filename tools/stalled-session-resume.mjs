#!/usr/bin/env node
// No LLM calls here; process execution, notification and file timestamps are injectable.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFiles, inspect } from './session-triage.mjs';
import { runChild, resolveClaudeExe, localDate } from './auto-session.mjs';
import { autoSessionExecutor } from './auto-session-executor.mjs';
import { acquireLock } from './autopilot-tick.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';

export function options(argv = [], env = process.env) {
  const out = { limit: Number(env.STALLED_SESSION_LIMIT ?? 3), timeoutMs: Number(env.STALLED_SESSION_TIMEOUT_MIN ?? 20) * 60000,
    activeMs: Number(env.STALLED_SESSION_ACTIVE_MIN ?? 10) * 60000, dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = Number(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--list') out.list = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (!Number.isSafeInteger(out.limit) || out.limit < 0 || !Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0 || !Number.isFinite(out.activeMs) || out.activeMs < 0) throw new Error('Invalid limit/timeout/active minutes');
  return out;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function saveJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temp, file);
}
export async function detect() {
  return (await Promise.all((await listFiles()).map(inspect))).filter(Boolean);
}

export function skipReason(record, entry, night, closed, mtimeMs, now, activeMs) {
  if (closed.sessions[record.sessionId]) return 'closed';
  if (now - mtimeMs >= 7 * 86400000) return 'session-auto-close対象';
  if (now - mtimeMs <= activeMs || record.sessionId === process.env.CLAUDE_SESSION_ID) return 'active';
  if ((entry.noProgress ?? 0) >= 3) return '3回進捗なし';
  if (entry.attempts?.some(a => a.night === night)) return '今晩処理済み';
  return '';
}

export async function execute(record, { timeoutMs, resultFile, previous = [] }, io = {}) {
  const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
元の会話全文を ${record.file} から読み、依頼・制約・成果物を確認して続行してください。推測で目的を広げないでください。
共有作業ツリーの他セッションの変更を上書きせず、権限や確認待ちを迂回しないでください。個別の通知は不要です。
前回までの再開結果: ${JSON.stringify(previous)}。済んだ作業を繰り返さず、成果物の現状を検証してください。
期限は${timeoutMs / 60000}分です。期限前に終了してください。
実行した成果を ${resultFile} にJSONで保存してください: {"progressed":true/false,"evidence":"変更した成果物と検証結果、または進めない理由"}。
単なる進捗確認・計画・終了コード0は成果に含めません。\n当初依頼: ${record.firstPrompt}\n直近: ${record.lastAssistantText}`;
  const result = await (io.runChild ?? runChild)(io.executable ?? resolveClaudeExe(), prompt, record.cwd, record.cwd, timeoutMs, { resumeSessionId: record.sessionId });
  if (result.status !== 'success') return { outcome: 'error', reason: result.status };
  const report = await (io.readReport ?? readJson)(resultFile, null);
  return { outcome: report?.progressed === true && typeof report.evidence === 'string' && report.evidence.trim() ? 'progressed' : 'no-progress', reason: report?.evidence || '成果記録なし', executor: result.executorUsed };
}

export async function run(config = options(), io = {}) {
  const home = io.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const dir = path.join(home, '.claude');
  const ledgerFile = path.join(dir, 'stalled-session-resume.json');
  const lockFile = `${ledgerFile}.lock`;
  const now = io.now ?? Date.now;
  const night = localDate(new Date(now()));
  const readonly = config.dryRun || config.list;
  let lock;
  if (!readonly) {
    await fs.mkdir(dir, { recursive: true });
    lock = acquireLock(lockFile);
    if (!lock) return { skipped: 'locked', rows: [], results: [] };
  }
  try {
    const ledger = await readJson(ledgerFile, { version: 1, sessions: {}, nights: {} });
    if (ledger.version !== 1 || !ledger.sessions || !ledger.nights) throw new Error('Invalid resume ledger');
    const loadClosed = io.loadClosed ?? (() => readJson(path.join(dir, 'session-closed-ledger.json'), { sessions: {} }));
    const stat = io.stat ?? fs.stat;
    const records = (await (io.detect ?? detect)()).filter(r => ['要対応', '要確認'].includes(r.status)).sort((a, b) => b.score - a.score || a.ageDays - b.ageDays);
    const rows = [], results = [];
    const state = ledger.nights[night] ?? { count: 0, errors: 0, aborted: false };
    for (const record of records) {
      const entry = ledger.sessions[record.sessionId] ?? { attempts: [], noProgress: 0 };
      const closed = await loadClosed();
      const { mtimeMs } = await stat(record.file);
      let reason = skipReason(record, entry, night, closed, mtimeMs, now(), config.activeMs);
      if (!reason && state.aborted) reason = '連続2件エラーで今晩中止';
      if (!reason && state.count >= config.limit) reason = '今晩の件数上限';
      rows.push({ sessionId: record.sessionId, title: record.displayTitle, attempts: entry.attempts.length, skip: reason });
      if (reason) {
        if (!readonly) { entry.skipReason = reason; ledger.sessions[record.sessionId] = entry; }
        continue;
      }
      state.count++;
      if (readonly) continue;
      ledger.nights[night] = state;
      ledger.sessions[record.sessionId] = entry;
      delete entry.skipReason;
      // 起動前に消費を確定し、親が落ちても同じ晩に二重実行しない。
      const attempt = { night, startedAt: new Date(now()).toISOString(), outcome: 'interrupted' };
      entry.attempts.push(attempt);
      entry.noProgress++;
      await saveJson(ledgerFile, ledger);
      let result;
      try {
        if (!record.cwd) throw new Error('cwd missing');
        const resultFile = path.join(dir, `stalled-result-${record.sessionId}-${night}.json`);
        await fs.rm(resultFile, { force: true });
        result = await (io.execute ?? execute)(record, { timeoutMs: config.timeoutMs, resultFile, previous: entry.attempts.slice(-4, -1) });
        if (!['progressed', 'no-progress', 'error'].includes(result?.outcome)) throw new Error('Invalid execution outcome');
      } catch (error) { result = { outcome: 'error', reason: String(error.message) }; }
      Object.assign(attempt, result, { reason: redactSecrets(String(result.reason ?? '')).slice(0, 2000), endedAt: new Date(now()).toISOString() });
      if (result.outcome === 'progressed') entry.noProgress = 0;
      if (entry.noProgress >= 3) entry.skipReason = '3回進捗なし';
      state.errors = result.outcome === 'error' ? state.errors + 1 : 0;
      state.aborted = state.errors >= 2;
      results.push({ title: record.displayTitle, sessionId: record.sessionId, ...attempt });
      await saveJson(ledgerFile, ledger);
      if (state.aborted) break;
    }
    if (!readonly && records.length) await saveJson(ledgerFile, ledger);
    if (results.length) {
      const message = redactSecrets(`夜間セッション再開 (${os.hostname()})\n${results.map(r => `${r.title} (${r.sessionId}): ${r.outcome}`).join('\n')}${state.aborted ? '\n連続2件エラーのため今晩は中止' : ''}`);
      state.notification = await (io.notify ?? notifyKim)(message, { home });
      await saveJson(ledgerFile, ledger);
    }
    return { rows, results, aborted: state.aborted };
  } finally {
    if (lock) lock();
  }
}
export async function main(argv = process.argv.slice(2), io = {}) {
  return run(options(argv), io);
}
if (isEntry(import.meta.url)) {
  try { const config = options(process.argv.slice(2)); const result = await run(config); console.log(redactSecrets(JSON.stringify({ executor: autoSessionExecutor(), ...result }, null, 2))); if (result.results.some(r => r.outcome === 'error')) process.exitCode = 1; }
  catch (error) { console.error(redactSecrets(error.message)); process.exitCode = 1; }
}
