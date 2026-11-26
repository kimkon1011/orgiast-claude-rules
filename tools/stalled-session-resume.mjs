#!/usr/bin/env node
// Hourly classification and execution are injectable; other modes retain their policy.
import { randomUUID } from 'node:crypto';
import { detectHourly, classifyHourly, acquireSessionLock, runningHourlyProcesses, sessionIsRunning, publishHourlyHeartbeat } from './lib/stalled-session-hourly.mjs';
import { automationModel } from './lib/automation-model.mjs';
import fs from 'node:fs/promises';
import { apply as updateWaitTitle, latestWaitDeadline, waitExtension, waitPrefix } from './session-wait-title.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listFiles, inspect } from './session-triage.mjs';
import { runChild, resolveClaudeExe, localDate } from './auto-session.mjs';
import { autoSessionExecutor } from './auto-session-executor.mjs';
import { acquireLock } from './autopilot-tick.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';
import { autoResumeAllowed, eventResumeAllowed, hourlyResumePolicy, autoResumeDisabledByConfig } from './lib/auto-resume-policy.mjs';
import { evaluateClaudeSeatGuard, formatClaudeSeatGuardSkip } from './lib/claude-seat-guard.mjs';

import { latestSafeStart, parseWaitFooter } from './lib/wait-deadline.mjs';
import { executeCheck, isTimeOnlyCheck } from './auto-progress-check.mjs';
import { fetchClaudePlanUsage } from './claude-plan-usage.mjs';
import { collectGbReportEntries, handoffSession, writeAllLedgers, writeStallLedger } from './stall-ledger.mjs';
import { buildFleetStatus } from './fleet-status.mjs';
import { fetchBeacons } from './fleet-beacon.mjs';
import { main as sendFleetDirective } from './fleet-directive-send.mjs';
import { latestOpenPromises, ledgerFile as progressLedgerFile, readLedger } from './auto-progress-ledger.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { footerValues, NO_ACTION_PATTERN } from './next-action-gate.mjs';
import { parseJsonLoose, readJsonFile } from './lib/json-read.mjs';
import { decideStalledNoticeKind } from './lib/stalled-notice-kind.mjs';

const CHECK_INTERVAL_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const execFileAsync = promisify(execFile);

async function standingPermissions(home, now) {
  const recent = new Map();
  try {
    const raw = await fs.readFile(path.join(home, '.claude', 'stall-ledger', 'standing-sends.jsonl'), 'utf8');
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.sessionId && now - Date.parse(row.at) <= 7 * DAY_MS) recent.set(String(row.sessionId), String(row.permissionId || ''));
    }
  } catch { /* 台帳が無い場合は通常順 */ }
  const names = new Map();
  try {
    const config = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '..', 'config', 'standing-send-permissions.json'), 'utf8'));
    for (const item of config.permissions || []) names.set(String(item.id), String(item.name || item.id));
  } catch { /* 設定欠損時はIDを使う */ }
  return new Map([...recent].map(([sessionId, id]) => [sessionId, names.get(id) || id]));
}

// 実行ログ: ~/.claude/logs/stalled-session-sweep.jsonl に1行追記
async function writeLog(home, entry) {
  const dir = path.join(home, '.claude', 'logs');
  await fs.mkdir(dir, { recursive: true });
  const line = redactSecrets(JSON.stringify(entry)) + '\n';
  await fs.appendFile(path.join(dir, 'stalled-session-sweep.jsonl'), line, 'utf8');
}

// Windows: PowerShell でコマンドライン取得。他OS: /proc/<pid>/cmdline。
// io.processCommandLine で注入可能。
async function defaultProcessCommandLine(pid) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
      ], { timeout: 5000 });
      return (stdout || '').trim();
    } catch { return ''; }
  }
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
  } catch { return ''; }
}

function parseLimit(value) {
  if (value === 'all') return Infinity;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

export function options(argv = [], env = process.env) {
  const hourly = argv.includes('--hourly') || env.STALLED_SESSION_MODE === 'hourly';
  const overdue = hourly || argv.includes('--overdue') || env.STALLED_SESSION_MODE === 'overdue';
  const out = { overdue, hourly, limit: parseLimit(env.STALLED_SESSION_LIMIT ?? (hourly ? '4' : overdue ? '2' : 'all')), timeoutMs: Number(env.STALLED_SESSION_TIMEOUT_MIN ?? 20) * 60000,
    activeMs: Number(env.STALLED_SESSION_ACTIVE_MIN ?? 10) * 60000, concurrency: Number(overdue ? 1 : (env.STALLED_SESSION_CONCURRENCY ?? 2)), deadline: env.STALLED_SESSION_DEADLINE ?? '07:30', dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--overdue' || argv[i] === '--hourly') continue;
    if (argv[i] === '--limit') out.limit = parseLimit(argv[++i]);
    else if (argv[i] === '--deadline') out.deadline = argv[++i];
    else if (argv[i] === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--list') out.list = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if ((out.limit !== Infinity && !Number.isSafeInteger(out.limit)) || out.limit < 0 || !Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0 || !Number.isFinite(out.activeMs) || out.activeMs < 0) throw new Error('Invalid limit/timeout/active minutes');
  if (!Number.isSafeInteger(out.concurrency) || out.concurrency < 1 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(out.deadline)) throw new Error('Invalid concurrency/deadline');
  if (overdue) out.concurrency = 1;
  return out;
}

async function readSanitizedJson(file, fallback) {
  try {
    return readJsonFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    const raw = (await fs.readFile(file)).toString('utf8');
    const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (cleaned === raw) throw error;
    return parseJsonLoose(cleaned, { source: file });
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
let saveCounter = 0;
export async function saveJson(file, value, rename = fs.rename) {
  const temp = `${file}.${process.pid}.${++saveCounter}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
    // Windows readers may temporarily prevent replacement. Total wait: 2975 ms.
    const delays = [25, 50, 100, 200, 400, 800, 1400];
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); return; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
export async function detect(overdue = false, hourly = false, io = {}) {
  if (hourly) return detectHourly(io);
  const files = await listFiles();
  const inspected = await Promise.all(files.map(inspect));
  if (overdue) {
    for (const [index, record] of inspected.entries()) {
      const file = files[index];
      if (!record || (!hourly && !waitDeadline(record.displayTitle))) continue;
      const { assistantText, raw } = readTranscriptContext(record.file);
      record.lastAssistantText = assistantText;
      const extension = waitExtension(raw);
      if (extension) record.waitOverride = new Date(extension.until);
      record.activityMtimeMs = waitExtension(raw, { lastLineOnly: true })?.activityMtimeMs;
      record.detectedMtimeMs = file.mtimeMs;
    }
  }
  return inspected.filter(Boolean);
}

const DEFERRED_PHRASE = /(?:次回|次の起動|後で(?:やる|対応)|以降に(?:実施|再開|対応)|復帰(?:後|したら)|明日(?:やる|対応)|上限.*(?:待ち|解除)|17:02以降)/;
export function deferredPhrase(text = '') {
  return DEFERRED_PHRASE.test(String(text ?? ''));
}

// 再開の連鎖: execute() が作る子セッションの初回プロンプトは
// 「停滞セッション「…」(親sessionId)の承認済みの目的を1歩進めてください」で始まる。
// 夜ごとに子の session id が変わるため、id 単位の noProgress では 3 に到達せず連鎖が
// 自己再生産される（2026-10-13〜10-14 実測: c9ce7174 -> … -> 46cda47c）。親 id を拾って
// 予算を連鎖で引き継ぐことで、同じ目的の再開は合計3回で retire される。
const RESUMED_PROMPT = /停滞セッション「[^」]*」\(([^()\s]{6,})\)の承認済みの目的/;
export function resumedParentId(firstPrompt = '') {
  const match = RESUMED_PROMPT.exec(String(firstPrompt ?? ''));
  return match ? match[1] : '';
}
// 連鎖の祖先で最も進んだ noProgress を返す。祖先の entry が無い所で打ち切る。
export function chainNoProgress(ledger, parentId) {
  const seen = new Set();
  let max = 0;
  for (let id = parentId; id && !seen.has(id); id = ledger.sessions[id]?.parentSessionId) {
    seen.add(id);
    const entry = ledger.sessions[id];
    if (!entry) break;
    max = Math.max(max, entry.noProgress ?? 0);
  }
  return max;
}
function chainAncestors(ledger, parentId) {
  const seen = new Set();
  const ancestors = [];
  for (let id = parentId; id && !seen.has(id); id = ledger.sessions[id]?.parentSessionId) {
    seen.add(id);
    const entry = ledger.sessions[id];
    if (!entry) break;
    ancestors.push(entry);
  }
  return ancestors;
}
// タイトル頭の Stop フック印（tools/session-wait-title.mjs）は、そのセッション自身が
// 「次に kim がすることが無いので閉じてよい」「この時刻まで待つ」と宣言した結果。
// それでも再開すると、済んだ作業を毎晩やり直して枠を消費し、長いものは20分で
// タイムアウトして error 行になり、kim 宛の修復TODOに化ける（2026-11-03 実測:
// 64c3b3c8 は【閉じて可】なのに再開され timeout、5c76ae26 は 18:00 まで待つ宣言の
// 03:44 に再開された）。タイトル印を再開可否の判定に使う。
const CLOSABLE_TITLE = /(?:^|｜)【閉じて可】/;
// 新形式【MM/DD/HH:MMまで】と旧形式【YY/MM/DD/HH:MMまで】の両方を受ける。
const WAIT_TITLE = /^(?:(?:\d{3}|[A-Za-z][A-Za-z0-9-]{1,15})｜)?【(?:(\d{2})\/)?(\d{2})\/(\d{2})\/(\d{2}):(\d{2})まで(?:・納期\d{2}\/\d{2})?】/;

export function waitDeadline(displayTitle, now = Date.now()) {
  const match = WAIT_TITLE.exec(String(displayTitle ?? ''));
  if (!match) return null;
  const [, yy, month, day, hour, minute] = match;
  const at = year => new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
  let deadline = yy ? at(2000 + Number(yy)) : at(new Date(now).getFullYear());
  if (!yy && deadline - now > 180 * 86400000) deadline = at(new Date(now).getFullYear() - 1);
  return { key: match[0].slice(match[0].indexOf('【')), label: `${month}/${day} ${hour}:${minute}`, at: deadline };
}
function recordWait(record, now) {
  const title = waitDeadline(record.displayTitle, now);
  if (!title) return null;
  const { waitUntil, due } = parseWaitFooter(record.lastAssistantText);
  const date = record.waitOverride ?? waitUntil;
  if (!date) return title;
  const prefix = waitPrefix(date, due);
  return { ...waitDeadline(prefix, now), at: date.getTime() };
}

function eventLimit(attempts, sessionId, now) {
  const recent = attempts.filter(attempt => attempt.at > now - HOUR_MS);
  if (recent.length >= 2) return 'global';
  const today = localDate(new Date(now));
  if (attempts.filter(attempt => attempt.sessionId === sessionId && localDate(new Date(attempt.at)) === today).length >= 2) return 'daily';
  return null;
}

export function hourlyEventLimit(attempts, sessionId, now, { hourlyCap = 4, perSessionDailyCap = 6 } = {}) {
  // outcome が 'disabled' または 'no-executor' の試行は実際に Claude を起動していないのでカウントしない
  const effectiveAttempts = attempts.filter(attempt => 
    attempt.outcome !== 'disabled' && attempt.outcome !== 'no-executor'
  );
  
  const recent = effectiveAttempts.filter(attempt => attempt.at > now - HOUR_MS);
  if (recent.length >= hourlyCap) return 'global';
  const today = localDate(new Date(now));
  if (effectiveAttempts.filter(attempt => attempt.sessionId === sessionId && localDate(new Date(attempt.at)) === today).length >= perSessionDailyCap) return 'daily';
  return null;
}

export function hourlySkipReason(record, entry, closed, mtimeMs, now, activeMs) {
  const common = skipReason(record, {}, '', closed, mtimeMs, now, Math.max(activeMs || 0, 30 * 60000 - 1));
  if (common && common !== '3回進捗なし') return common;
  if (entry.forkSessionId && entry.resumedFingerprint === record.lastLineHash) return 'fork先へ引継ぎ済み';
  if (now - mtimeMs > 7 * 24 * HOUR_MS) return '7日超過';
  if ((entry.noProgress ?? 0) >= 3) return '3回進捗なし';
  const wait = recordWait(record, now);
  if (wait) return wait.at <= now ? '' : '待機期限前';
  return '';
}

async function addOverdueInbox(io, home, item) {
  const add = io.addItem ?? (await import('./kim-inbox.mjs')).addItem;
  if (!io.hourlyStats) return add(home, item);
  try { return await add(home, item, { drain: false, lockWaitMs: 1000 }); }
  catch (error) {
    if (!String(error.message).includes('kim-inbox: 台帳が使用中')) throw error;
    const spool = io.spoolItem ?? (await import('./kim-inbox.mjs')).spoolItem;
    return spool(home, item);
  }
}

async function notifyEventLimit(io, home, notices, sessionId, limit, now, policy = {}) {
  const global = limit === 'global';
  const key = global ? 'global' : sessionId;
  const previous = notices[key];
  const day = localDate(new Date(now));
  if (global ? previous > now - HOUR_MS : previous && localDate(new Date(previous)) === day) return;
  try {
    await addOverdueInbox(io, home, {
      kind: 'info', source: 'stalled-session-event-limit', sessionId,
      dedupeKey: `stalled-session-event-limit:${key}:${global ? Math.floor(now / HOUR_MS) : day}`,
      text: global ? `待機セッションのイベント再開は直近1時間で${policy.hourlyCap ?? 2}件に達しました。` : `このセッションのイベント再開は本日${policy.perSessionDailyCap ?? 2}回に達しました。`
    });
    notices[key] = now;
  } catch { /* 通知に失敗したら次回再試行する */ }
}

export function titleSkipReason(displayTitle, now) {
  if (CLOSABLE_TITLE.test(String(displayTitle ?? ''))) return '閉じて可';
  const wait = waitDeadline(displayTitle, now);
  return wait && now < wait.at ? '待機期限前' : '';
}
// overdue の「処理済み」判定は期限更新に繋がる結果だけ。
// no-progress / error / timeout / interrupted / その他は再試行対象（30分バックオフ、同一期限で最大3回）。
// interrupted は起動中ロックがない古いもの（30分超）だけ再試行対象にする。
const OVERDUE_SUCCESS_OUTCOMES = new Set(['progressed', 'no-progress', 'done', 'waiting-human']);
export function overdueSkipReason(record, entry, closed, mtimeMs, now, activeMs) {
  if (entry.waitingHuman?.until > now) return '人の判断待ち';
  const common = skipReason(record, {}, '', closed, mtimeMs, now, activeMs);
  if (common) return common;
  const wait = recordWait(record, now);
  if (!wait || wait.at > now) return '期限切れ待機ではない';
  const attempts = (entry.attempts ?? []).filter(a => a.via && a.outcome !== 'not-in-session' && a.resumedInSession !== false);
  if (attempts.some(a => a.outcome === 'progressed' || a.outcome === 'done' || a.outcome === 'waiting-human')) return '同一期限処理済み';
  if ((entry.noProgress ?? 0) >= 3 && attempts.filter(a => a.outcome === 'no-progress').length >= 3) return '3回進捗なし';
  if (attempts.length >= 3 && attempts.every(a => !OVERDUE_SUCCESS_OUTCOMES.has(a.outcome))) return '同一期限3回エラー';
  if (attempts.length) {
    const last = attempts.at(-1);
    const elapsed = now - Date.parse(last.endedAt ?? last.startedAt);
    if (elapsed < 30 * 60000) return 'エラー後30分待機';
    // interrupted が30分以上経過していれば起動中ロックは切れているとみなし再試行対象
  }
  return '';
}

export function skipReason(record, entry, night, closed, mtimeMs, now, activeMs) {
  const deadline = record.waitOverride ?? latestWaitDeadline(record.lastAssistantText);
  if (closed.sessions[record.sessionId] && !deadline) return 'closed';
  if (entry.waitingHuman?.until > now) return '人の判断待ち';
  const titleSkip = deadline ? (now < deadline.getTime() ? '待機期限前' : '') : titleSkipReason(record.displayTitle, now);
  if (titleSkip) return titleSkip;
  if (now - mtimeMs <= activeMs || record.sessionId === process.env.CLAUDE_SESSION_ID) return 'active';
  if ((entry.noProgress ?? 0) >= 3) return '3回進捗なし';
  if (entry.attempts?.some(a => a.night === night)) return '今晩処理済み';
  return '';
}

// overdue モードでは claude --resume <sessionId> -p "<prompt>" でセッション自身を再開する。
// これにより transcript に追記され、kim がリモート表示で進捗を見られる。
// 予備として cheap-code フォールバックも残すが、transcript が増えなければ progressed にしない。
async function executeOverdue(record, { timeoutMs, resultFile, previous = [], wait }, io = {}) {
  const guardVerdict = io.guardVerdict ?? await (io.evaluateGuard ?? evaluateClaudeSeatGuard)({ home: io.home ?? process.env.ORGIAST_HOME ?? os.homedir(), env: process.env, caller: 'stalled-session-resume:wait-deadline' });
  if (guardVerdict.blocked) return { outcome: 'skipped', executor: 'none', reason: formatClaudeSeatGuardSkip(guardVerdict) };
  const waitInstruction = wait.key === 'hourly-deferred'
    ? 'このセッションは先送りしたまま止まっています。先送りした事項を確認し、'
    : `このセッションの待機期限 ${wait.label} を過ぎました。待っていた事項（相手の返信・外部の状態・自動チェック）を直接照会し、`;
  const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
「次回やる」で終わらせない。先送りするなら、応答の「このセッション」行に新しい期限【MM/DD/HH:MMまで】を書く（毎時の再開ジョブが拾う）。常設許可がある送信（config/standing-send-permissions.json に列挙）は承認待ちに積まず、その許可の範囲で送信して結果を記録する。
${waitInstruction}(a) 進められるなら最後まで進めて検証する (b) 人の判断や操作が必要なら kim-inbox に ask を積み（node tools/kim-inbox.mjs）、応答の「このセッション」行に新しい期限を書く (c) 目的が完了していれば /session-close を実行する。期限を書き換えるだけで終えない。
元の会話全文を ${record.file} から読み、依頼・制約・成果物を確認して続行してください。推測で目的を広げないでください。
共有作業ツリーの他セッションの変更を上書きせず、権限や確認待ちを迂回しないでください。個別の通知は不要です。
前回までの再開結果: ${JSON.stringify(previous)}。済んだ作業を繰り返さず、成果物の現状を検証してください。
期限は${timeoutMs / 60000}分です。期限前に終了してください。
実行結果を ${resultFile} にJSONで保存してください: {"state":"progressed"|"done"|"waiting-human"|"stuck","evidence":"変更した成果物と検証結果、または進めない理由","askId":"kim-inbox の ask ID（waiting-human の時は必須）"}。
progressed=成果物を進めて検証した。
done=目的が完了済み（後続セッションで完了した場合も含む）で、やることが残っていない。
waiting-human=残りが人の判断・操作だけで、kim-inbox に ask を積んだ（既存の open ask でもよい）。
stuck=それ以外で進められなかった。
単なる進捗確認・計画・終了コード0は成果に含めません。\n当初依頼: ${record.firstPrompt}\n直近: ${record.lastAssistantText}`;
  const stat = io.stat ?? fs.stat;
  const size = async () => { try { return (await stat(record.file)).size; } catch { return null; } };
  const before = await size();
  const executable = io.executable ?? resolveClaudeExe();
  const env = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
  const invoke = io.execFile ?? execFileAsync;
  let available = false;
  try {
    const { stdout } = await invoke(executable, ['--help'], { env, timeout: 10000, windowsHide: true });
    available = /--resume/.test(stdout) && /--print/.test(stdout);
  } catch { /* Only unavailable CLI permits the fallback. */ }
  let result;
  if (available) {
    let child;
    try {
      await invoke(executable, ['--resume', record.sessionId, '-p', '--model', automationModel(), prompt], {
        cwd: record.cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      child = { status: 'success', executorUsed: 'claude' };
    } catch (error) {
      child = { status: error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'error', executorUsed: 'claude' };
    }
    result = await executeFallback(record, { timeoutMs, resultFile, previous, wait }, { ...io, runChild: async () => child });
  } else {
    result = await executeFallback(record, { timeoutMs, resultFile, previous, wait }, io);
  }
  const after = await size();
  const resumedInSession = before !== null && after !== null && after > before;
  return resumedInSession ? { ...result, resumedInSession } : {
    ...result, outcome: 'not-in-session', resumedInSession: false,
    reason: `セッション transcript の増加なし: ${result.outcome}: ${result.reason}`,
  };
}

// 従来の cheap-code / codex-do フォールバック（overdue の予備）
async function executeFallback(record, { timeoutMs, resultFile, previous = [], wait = null }, io = {}) {
  const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
${wait ? `このセッションの待機期限 ${wait.label} を過ぎました。待っていた事項（相手の返信・外部の状態・自動チェック）を直接照会し、(a) 進められるなら最後まで進めて検証する (b) 人の判断や操作が必要なら kim-inbox に ask を積み（node tools/kim-inbox.mjs）、応答の「このセッション」行に新しい期限を書く (c) 目的が完了していれば /session-close を実行する。期限を書き換えるだけで終えない。` : ''}
元の会話全文を ${record.file} から読み、依頼・制約・成果物を確認して続行してください。推測で目的を広げないでください。
共有作業ツリーの他セッションの変更を上書きせず、権限や確認待ちを迂回しないでください。個別の通知は不要です。
前回までの再開結果: ${JSON.stringify(previous)}。済んだ作業を繰り返さず、成果物の現状を検証してください。
期限は${timeoutMs / 60000}分です。期限前に終了してください。
実行結果を ${resultFile} にJSONで保存してください: {"state":"progressed"|"done"|"waiting-human"|"stuck","evidence":"変更した成果物と検証結果、または進めない理由","askId":"kim-inbox の ask ID（waiting-human の時は必須）"}。
progressed=成果物を進めて検証した。
done=目的が完了済み（後続セッションで完了した場合も含む）で、やることが残っていない。
waiting-human=残りが人の判断・操作だけで、kim-inbox に ask を積んだ（既存の open ask でもよい）。
stuck=それ以外で進められなかった。
単なる進捗確認・計画・終了コード0は成果に含めません。\n当初依頼: ${record.firstPrompt}\n直近: ${record.lastAssistantText}`;
  const result = await (io.runChild ?? runChild)(io.executable ?? resolveClaudeExe(), prompt, record.cwd, record.cwd, timeoutMs, { resumeSessionId: record.sessionId });
  const execution = { executor: result.executorUsed || 'not-started', executorAttempts: result.executorAttempts ?? [] };
  if (result.skippedSeatGuard) return { ...execution, outcome: 'skipped', reason: String(result.stdout || result.stderr || 'claude-seat-guard') };
  if (result.skippedNoExecutor) return { ...execution, outcome: 'no-executor', reason: `実行役なし: ${String(result.stderr ?? '').trim().slice(-300) || result.executorUsed || 'cheap-code'}` };
  const timedOut = result.status === 'timeout';
  if (result.status !== 'success' && !timedOut) return { ...execution, outcome: 'error', reason: result.status };
  let report;
  try {
    const rawReport = await (io.readReport ?? readSanitizedJson)(resultFile, null);
    report = rawReport;
    if (typeof rawReport === 'string') {
      const cleaned = rawReport.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      report = cleaned.trim() ? parseJsonLoose(cleaned, { source: resultFile }) : null;
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { ...execution, outcome: 'no-report', reason: String(error.message) };
    return { ...execution, outcome: 'error', reason: String(error.message) };
  }
  const evidenceOk = report?.evidence && (
    (typeof report.evidence === 'string' && report.evidence.trim()) ||
    (typeof report.evidence === 'object' && report.evidence !== null && Object.keys(report.evidence).length > 0)
  );
  if (!report || (typeof report === 'object' && Object.keys(report).length === 0)) return { outcome: timedOut ? 'timeout' : 'no-report', reason: timedOut ? result.status : '結果ファイルなし', ...execution };
  const state = report.state ?? (report.progressed === true ? 'progressed' : report.progressed === false ? 'stuck' : 'stuck');
  const reason = typeof report.evidence === 'string' ? report.evidence : JSON.stringify(report.evidence, null, 2) || '成果記録なし';
  let outcome = state === 'progressed' && evidenceOk ? 'progressed'
    : state === 'done' && evidenceOk ? 'done'
      : state === 'waiting-human' && evidenceOk && typeof report.askId === 'string' && report.askId.trim() ? 'waiting-human'
        : 'no-progress';
  if (timedOut && !['progressed', 'done', 'waiting-human'].includes(outcome)) outcome = 'timeout';
  return { outcome, reason: outcome === 'timeout' ? result.status : reason, ...(outcome === 'waiting-human' ? { askId: report.askId.trim() } : {}), ...execution };
}

export async function executeHourlyFork(record, { timeoutMs, resultFile, previous = [], nextStep = '', standingPermission }, io = {}) {
  const home = io.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const guard = await (io.evaluateGuard ?? evaluateClaudeSeatGuard)({ home, caller: 'stalled-session-resume:hourly' });
  if (io.hourlyStats) io.hourlyStats.seatGuard = `${guard.blocked ? 'blocked' : 'allowed'}:${guard.reason}`;
  if (guard.blocked) return { outcome: 'skipped', executor: 'none', reason: formatClaudeSeatGuardSkip(guard) };
  const usage = await (io.fetchClaudePlanUsage ?? fetchClaudePlanUsage)({ home, fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }) });
  const stopPct = (io.hourlyResumePolicy ?? hourlyResumePolicy)().planUsageStopPct ?? 85;
  const percents = usage?.available ? [usage.fiveHour?.utilization, usage.sevenDay?.utilization] : [guard.weeklyPercent, guard.fiveHourPercent];
  if (!percents.some(v => v != null && Number.isFinite(Number(v))) || percents.some(v => v != null && Number(v) >= stopPct)) {
    if (io.hourlyStats) io.hourlyStats.seatGuard += ';plan-usage-stopped';
    return { outcome: 'skipped', executor: 'none', reason: usage?.available ? 'planUsageStopPct' : 'usage-unknown-or-blocked' };
  }
  const forkSessionId = (io.randomUUID ?? randomUUID)();
  const acquire = io.acquireSessionLock ?? acquireSessionLock;
  const releaseSource = acquire(record.sessionId, { home });
  if (!releaseSource) return { outcome: 'skipped', executor: 'none', reason: 'session-locked' };
  let releaseFork;
  try {
    releaseFork = acquire(forkSessionId, { home });
    if (!releaseFork) return { outcome: 'skipped', executor: 'none', reason: 'fork-locked' };
    const stat = await (io.stat ?? fs.stat)(record.file);
    if ((record.detectedMtimeMs != null && stat.mtimeMs !== record.detectedMtimeMs) || (stat.mtimeMs != null && Date.now() - stat.mtimeMs < 30 * 60000) ||
      sessionIsRunning(record.sessionId, await (io.runningProcesses ?? runningHourlyProcesses)())) return { outcome: 'skipped', executor: 'none', reason: 'active' };
    const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
このセッションは先送りしたまま止まっています。元の会話全文を ${record.file} から読み、依頼・制約・成果物を確認してください。推測で目的を広げず、済んだ作業を繰り返さない。
事前判定の次の手順（元の依頼と実データで再確認してから実施）: ${nextStep}
${standingPermission ? `既存の常設許可: ${standingPermission}。今回の禁止事項を上書きしません。` : ''}
共有作業ツリーの他セッションの変更を上書きせず、実行中セッションを停止しない。社外送信・支払い・削除・権限変更は承認ルールに従い、この無人実行では実施せず、必要なら kim-inbox に ask を積む（dedupeKey=${record.sessionId}）。Discord DMは禁止。
完了なら /session-close を実行する。前回結果: ${JSON.stringify(previous)}。
期限は${timeoutMs / 60000}分。結果を ${resultFile} にJSONで保存: {"state":"progressed"|"done"|"waiting-human"|"stuck","evidence":"成果物と検証結果または判断事項","askId":"waiting-human の時は kim-inbox の ask ID"}。単なる計画・終了コード0を成果としない。`;
    const env = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    await io.beforeForkLaunch?.({ forkSessionId, forkFile: path.join(path.dirname(record.file), `${forkSessionId}.jsonl`) });
    let child;
    try {
      await (io.execFile ?? execFileAsync)(io.executable ?? resolveClaudeExe(), ['--resume', record.sessionId, '--fork-session', '--session-id', forkSessionId, '-p', '--model', automationModel(), '--output-format', 'json', prompt],
        { cwd: record.cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      child = { status: 'success', executorUsed: 'claude' };
    } catch (error) {
      if (['ENOENT', 'EACCES'].includes(error.code)) return { outcome: 'no-executor', executor: 'none', reason: error.code };
      child = { status: error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'error', executorUsed: 'claude' };
    }
    const result = await executeFallback(record, { timeoutMs, resultFile, previous }, { ...io, runChild: async () => child });
    const forkFile = path.join(path.dirname(record.file), `${forkSessionId}.jsonl`);
    const persisted = await (io.verifyFork ?? (async file => (await fs.stat(file).catch(() => ({ size: 0 }))).size > 0))(forkFile, forkSessionId);
    return { ...result, ...(persisted ? {} : { outcome: 'not-in-session', reason: `fork transcript 未確認: ${result.reason || result.outcome}` }),
      launched: true, forkSessionId, forkFile, resumedInSession: persisted };
  } finally { releaseFork?.(); releaseSource(); }
}

export async function execute(record, { timeoutMs, resultFile, previous = [], wait = null, event, hourly: hourlyOpt = false, standingPermission, nextStep }, io = {}) {
  const hourly = hourlyOpt === true || event === 'hourly';
  const allowed = hourly
    ? (io.hourlyResumePolicy ?? hourlyResumePolicy)().hourlyResume === true
    : wait ? ['check-met', 'due-risk'].includes(event) && eventResumeAllowed() : autoResumeAllowed();
  if (!allowed) return { outcome: 'disabled', reason: '自動再開は廃止（config/auto-resume.json）', executor: 'none' };
  if (hourly) return executeHourlyFork(record, { timeoutMs, resultFile, previous, standingPermission, nextStep }, io);
  // hourly モード・overdue モードでは claude --resume でセッション自身を再開する
  const overdueWait = wait ?? (hourly ? { key: 'hourly-deferred', label: '先送り（次回やる）', at: Date.now() } : null);
  if (overdueWait) {
    return executeOverdue(record, { timeoutMs, resultFile, previous, wait: overdueWait }, io);
  }
  const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
元の会話全文を ${record.file} から読み、依頼・制約・成果物を確認して続行してください。推測で目的を広げないでください。
共有作業ツリーの他セッションの変更を上書きせず、権限や確認待ちを迂回しないでください。個別の通知は不要です。
${standingPermission ? `この件には常設許可「${standingPermission}」があります。承認待ちにせず、許可の範囲で送信し、送信結果を記録せよ。` : ''}
前回までの再開結果: ${JSON.stringify(previous)}。済んだ作業を繰り返さず、成果物の現状を検証してください。
期限は${timeoutMs / 60000}分です。期限前に終了してください。
実行結果を ${resultFile} にJSONで保存してください: {"state":"progressed"|"done"|"waiting-human"|"stuck","evidence":"変更した成果物と検証結果、または進めない理由","askId":"kim-inbox の ask ID（waiting-human の時は必須）"}。
progressed=成果物を進めて検証した。
done=目的が完了済み（後続セッションで完了した場合も含む）で、やることが残っていない。
waiting-human=残りが人の判断・操作だけで、kim-inbox に ask を積んだ（既存の open ask でもよい）。
stuck=それ以外で進められなかった。
単なる進捗確認・計画・終了コード0は成果に含めません。\n当初依頼: ${record.firstPrompt}\n直近: ${record.lastAssistantText}`;
  const result = await (io.runChild ?? runChild)(io.executable ?? resolveClaudeExe(), prompt, record.cwd, record.cwd, timeoutMs, { resumeSessionId: record.sessionId });
  const execution = { executor: result.executorUsed || 'not-started', executorAttempts: result.executorAttempts ?? [] };
  if (result.skippedSeatGuard) return { ...execution, outcome: 'skipped', reason: String(result.stdout || result.stderr || 'claude-seat-guard') };
  // 実行役が1つも起動できない(cheap-code 全レーン停止・Claude フォールバック無効)のはセッションの失敗ではない。
  // 2026-10-26 実測: deepseek payment_required で2件が1秒で error 扱い→「連続2件エラーで中止」の誤通知と noProgress 消費。
  // 実行役記録を常に伝播させる（executorAttempts）
  if (result.skippedNoExecutor) return { ...execution, outcome: 'no-executor', reason: `実行役なし: ${String(result.stderr ?? '').trim().slice(-300) || result.executorUsed || 'cheap-code'}` };
  const timedOut = result.status === 'timeout';
  if (result.status !== 'success' && !timedOut) return { ...execution, outcome: 'error', reason: result.status };
  // deepseek-v4-flash が結果JSONに制御文字を混入することがある（2026-11-06 実測）.
  // io.readReport が指定されていればそれを使い、無ければファイルから制御文字無害化後に parse する。
  // parse 失敗時は null として no-progress 扱いにする（error にすると state.errors が増えて
  // 「連続3件エラー→今晩中止」のトリガーになる）。io.readReport の例外は結果ファイルが読めない
  // ことを意味し error 扱いにする。
  let report;
  try {
    const rawReport = await (io.readReport ?? readSanitizedJson)(resultFile, null);
    report = rawReport;
    if (typeof rawReport === 'string') {
      const cleaned = rawReport.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      report = cleaned.trim() ? parseJsonLoose(cleaned, { source: resultFile }) : null;
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { ...execution, outcome: 'no-report', reason: String(error.message) };
    return { ...execution, outcome: 'error', reason: String(error.message) };
  }
  const evidenceOk = report?.evidence && (
    (typeof report.evidence === 'string' && report.evidence.trim()) ||
    (typeof report.evidence === 'object' && report.evidence !== null && Object.keys(report.evidence).length > 0)
  );
  if (!report || (typeof report === 'object' && Object.keys(report).length === 0)) return { outcome: timedOut ? 'timeout' : 'no-report', reason: timedOut ? result.status : '結果ファイルなし', ...execution };
  const state = report.state ?? (report.progressed === true ? 'progressed' : report.progressed === false ? 'stuck' : 'stuck');
  let rawReason = typeof report.evidence === 'string' ? report.evidence : JSON.stringify(report.evidence, null, 2) || '成果記録なし';
  // Guard: deepseek subagent が evidence を toString() で [object Object] として
  // シリアライズした場合、情報が失われているので代替メッセージに置換する
  if (rawReason === '[object Object]') rawReason = 'evidence serialization failed (deepseek toString())';
  if (rawReason === '[object Promise]') rawReason = 'evidence serialization failed (deepseek toString())';
  const reason = rawReason;
  let outcome = state === 'progressed' && evidenceOk ? 'progressed'
    : state === 'done' && evidenceOk ? 'done'
      : state === 'waiting-human' && evidenceOk && typeof report.askId === 'string' && report.askId.trim() ? 'waiting-human'
        : 'no-progress';
  if (timedOut && !['progressed', 'done', 'waiting-human'].includes(outcome)) outcome = 'timeout';
  return { outcome, reason: outcome === 'timeout' ? result.status : reason, ...(outcome === 'waiting-human' ? { askId: report.askId.trim() } : {}), ...execution };
}

function openChecks(home, sessionId) {
  return latestOpenPromises(readLedger(progressLedgerFile(home)).filter(row => row.sessionId === sessionId))
    .filter(row => row.check && row.status !== 'waiting_user' && row.status !== 'scheduled' &&
      row.status !== 'starting' && row.status !== 'start_overdue' && !isTimeOnlyCheck(row.check));
}

export async function run(config = options(), io = {}) {
  if (!config.hourly) return runInternal(config, io);
  const stats = { seatGuard: 'not-checked', unlinked: 0, rows: [], results: [] };
  let result, failure;
  try { result = await runInternal(config, { ...io, hourlyStats: stats }); return result; }
  catch (error) { failure = error; throw error; }
  finally {
    const heartbeat = await (io.publishHeartbeat ?? publishHourlyHeartbeat)({ home: io.home ?? process.env.ORGIAST_HOME ?? os.homedir(),
      repo: path.resolve(import.meta.dirname, '..'), now: (io.now ?? Date.now)(), rows: result?.rows ?? stats.rows, results: result?.results ?? stats.results,
      unlinked: stats.unlinked, seatGuard: stats.seatGuard, dryRun: !!config.dryRun, error: failure?.message || result?.skipped || stats.error || '' });
    if (result) result.heartbeat = heartbeat;
    if (isEntry(import.meta.url) && heartbeat?.line) console.log(heartbeat.line);
  }
}

async function runInternal(config = options(), io = {}) {
  const overdue = config.overdue === true;
  const hourly = config.hourly === true;
  const hourlyPolicy = (io.hourlyResumePolicy ?? hourlyResumePolicy)();
  if (hourly) config.limit = Math.min(config.limit, hourlyPolicy.hourlyCap);
  const home = io.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  let usageState = 'not-checked';
  let usageBlocked = false;
  if (hourly && !config.dryRun && !config.list) {
    const usage = await (io.fetchClaudePlanUsage ?? fetchClaudePlanUsage)({ home, fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }) });
    if (!usage?.available) usageState = 'usage-unknown';
    else {
      const high = Math.max(Number(usage.fiveHour?.utilization) || 0, Number(usage.sevenDay?.utilization) || 0);
      usageState = `usage-${high}`;
      usageBlocked = high >= hourlyPolicy.planUsageStopPct;
    }
  }
  const dir = path.join(home, '.claude');
  const ledgerFile = path.join(dir, 'stalled-session-resume.json');
  const lockFile = `${ledgerFile}.lock`;
  const now = io.now ?? Date.now;
  const night = localDate(new Date(now()));
  const deadline = new Date(now());
  const [hours, minutes] = (config.deadline ?? '07:30').split(':').map(Number);
  deadline.setHours(hours, minutes, 0, 0);
  let saves = Promise.resolve();
  const save = ledger => {
    const snapshot = structuredClone(ledger);
    saves = saves.catch(() => {}).then(() => saveJson(ledgerFile, snapshot));
    return saves;
  };
  const readonly = config.dryRun || config.list;
  const concurrency = overdue ? 1 : (config.concurrency ?? 2);
  const startMs = now();
  const startedAt = new Date(startMs).toISOString();
  let lock, lockInfo;
  if (!readonly) {
    await fs.mkdir(dir, { recursive: true });
    lock = acquireLock(lockFile);
    if (!lock) {
      // pid 再利用対策: lock ファイルの pid のコマンドラインを確認する
      let pid;
      try { pid = Number(await fs.readFile(lockFile, 'utf8')); } catch { pid = 0; }
      let cmdline = '', mtime = 0;
      if (pid > 0) {
        cmdline = await (io.processCommandLine ?? defaultProcessCommandLine)(pid);
        try { mtime = (await fs.stat(lockFile)).mtimeMs; } catch { mtime = 0; }
      }
      const alive = cmdline.includes('stalled-session-resume');
      lockInfo = { pid, alive, cmdline: cmdline.slice(0, 80), mtime };
      if (!alive && (cmdline || (mtime > 0 && now() - mtime > 6 * 3600000))) {
        // 古い lock とみなして削除し、1回だけ取り直す
        await fs.unlink(lockFile).catch(() => {});
        lock = acquireLock(lockFile);
      }
      if (!lock) {
        const logEntry = { ts: startedAt, endedAt: new Date(now()).toISOString(), host: os.hostname(), pid: process.pid, night, mode: config.dryRun ? 'dry' : config.list ? 'list' : 'run', outcome: 'locked', lockOwner: lockInfo };
        await writeLog(home, logEntry);
        if (!readonly && !config.dryRun && !config.list) {
          const msg = redactSecrets(`停滞セッション全件確認: 今晩は未実行（理由: locked by pid ${pid} ${cmdline.slice(0, 80)}）。翌晩に再試行します。`);
          await (io.notify ?? notifyKim)(msg, { home });
          process.exitCode = 3;
        }
        return { skipped: 'locked', rows: [], results: [], lockOwner: lockInfo };
      }
    }
  }
  let rows = [], results = [], fatal, thrown;
  try {
    const ledger = await readJson(ledgerFile, { version: 1, sessions: {}, nights: {} });
    if (ledger.version !== 1 || !ledger.sessions || !ledger.nights) throw new Error('Invalid resume ledger');
    if (overdue) {
      ledger.overdue ??= {};
      ledger.eventAttempts ??= [];
      ledger.eventLimitNotices ??= {};
    }
    const familyId = id => { const seen = new Set(); while (ledger.forks?.[id] && !seen.has(id)) { seen.add(id); id = ledger.forks[id]; } return id; };
    if (hourly) {
      ledger.hourlyFamilies ??= {};
      // Recover a fork whose parent stopped before collecting its result.
      for (const entry of Object.values(ledger.overdue)) {
        const pending = entry.pendingFork;
        if (pending && (await fs.stat(pending.file).catch(() => ({ size: 0 }))).size > 0) {
          entry.forkSessionId = pending.id;
          entry.resumedFingerprint = pending.fingerprint;
        }
      }
    }
    const standing = hourly ? await standingPermissions(home, now()) : new Map();
    let fleetRows = io.fleetRows;
    const loadFleetRows = async () => {
      if (fleetRows) return fleetRows;
      const result = await (io.fetchBeacons ?? fetchBeacons)({ home, fetchImpl: io.fetch, timeoutMs: 15000, retries: 0 });
      const pcMap = io.pcMap ?? await readJson(path.resolve(import.meta.dirname, '..', 'fleet-pc-map.json'), {});
      fleetRows = buildFleetStatus({ pcMap, beacons: result.beacons, serverPolls: result.serverPolls, now: now() });
      return fleetRows;
    };
    if (hourly && usageBlocked) await loadFleetRows();
    const loadClosed = io.loadClosed ?? (() => readJson(path.join(dir, 'session-closed-ledger.json'), { sessions: {} }));
    let closeSaves = Promise.resolve();
    const closeSession = io.closeSession ?? (async (sessionId, value) => {
      const file = path.join(dir, 'session-closed-ledger.json');
      closeSaves = closeSaves.catch(() => {}).then(async () => {
        const closed = await readJson(file, { sessions: {} });
        closed.sessions ??= {};
        if (!closed.sessions[sessionId]) { closed.sessions[sessionId] = value; await saveJson(file, closed); }
      });
      await closeSaves;
    });
    const stat = io.stat ?? fs.stat;
    const overdueOrder = record => {
      const wait = recordWait(record, now());
      const key = JSON.stringify([record.sessionId, wait?.key]);
      const entry = ledger.overdue?.[key];
      const attempts = (entry?.attempts ?? []).filter(a => a.via && a.outcome !== 'not-in-session' && a.resumedInSession !== false);
      const last = attempts.at(-1);
      return {
        deferredAt: !!entry?.deferredAt,
        expired: !!wait && wait.at <= now(),
        attempts: attempts.length,
        lastAt: Date.parse(last?.endedAt ?? last?.startedAt ?? '') || 0,
        deadlineAt: wait?.at ?? Infinity
      };
    };
    const hourlyOrder = record => {
      const wait = recordWait(record, now());
      const parsedDue = parseWaitFooter(record.lastAssistantText).due;
      const dueAt = parsedDue?.getTime?.() ?? wait?.at ?? Infinity;
      const dueSoon = dueAt >= now() && dueAt <= now() + 24 * HOUR_MS;
      return { standing: standing.has(record.sessionId), dueSoon, dueAt, expiredAt: wait?.at <= now() ? wait.at : Infinity, deferredOnly: !wait };
    };
    const overdueTitle = record => overdueOrder(record).expired;
    const detected = await (io.detect ?? detect)(overdue, hourly, { home, now: now() });
    if (io.hourlyStats) io.hourlyStats.unlinked = detected.unlinked || 0;
    const records = detected
      .filter(r => overdue ? (hourly ? true : !!recordWait(r, now())) : ['要対応', '要確認'].includes(r.status))
      .sort((a, b) => {
        if (hourly) {
          const left = hourlyOrder(a), right = hourlyOrder(b);
          return Number(right.standing) - Number(left.standing)
            || Number(right.dueSoon) - Number(left.dueSoon)
            || left.dueAt - right.dueAt
            || left.expiredAt - right.expiredAt
            || Number(left.deferredOnly) - Number(right.deferredOnly)
            || (a.ageDays ?? 0) - (b.ageDays ?? 0);
        }
        if (overdue) {
          const left = overdueOrder(a), right = overdueOrder(b);
          return Number(right.deferredAt) - Number(left.deferredAt)
            || Number(right.expired) - Number(left.expired)
            || left.attempts - right.attempts
            || left.lastAt - right.lastAt
            || left.deadlineAt - right.deadlineAt
            || b.score - a.score;
        }
        return Number(overdueTitle(b)) - Number(overdueTitle(a))
          || (ledger.sessions[a.sessionId]?.attempts?.at(-1)?.night ?? '').localeCompare(ledger.sessions[b.sessionId]?.attempts?.at(-1)?.night ?? '')
          || b.score - a.score || a.ageDays - b.ageDays;
      });
    rows = []; results = [];
    if (io.hourlyStats) Object.assign(io.hourlyStats, { rows, results });
    let hourlyGuard = { blocked: false, reason: 'not-checked' };
    if (hourly) {
      hourlyGuard = await (io.evaluateGuard ?? evaluateClaudeSeatGuard)({ home, caller: 'stalled-session-resume:hourly-preflight' });
      if (io.hourlyStats) io.hourlyStats.seatGuard = `${hourlyGuard.blocked ? 'blocked' : 'allowed'}:${hourlyGuard.reason};${usageState}`;
    }
    const decisions = new Map();
    if (hourly) {
      const closed = await loadClosed();
      const toJudge = records.filter(record => {
        const entry = ledger.overdue[JSON.stringify([record.sessionId, recordWait(record, now())?.key ?? 'hourly-deferred'])] || {};
        return !hourlySkipReason(record, { ...entry, noProgress: Math.max(entry.noProgress || 0, ledger.hourlyFamilies[familyId(record.sessionId)]?.noProgress || 0) }, closed, record.detectedMtimeMs ?? now() - DAY_MS, now(), config.activeMs);
      });
      if (isEntry(import.meta.url)) console.log(JSON.stringify({ candidates: records.length, judging: toJudge.length, unlinked: detected.unlinked || 0 }));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, toJudge.length) }, async () => {
        while (cursor < toJudge.length) {
          const record = toJudge[cursor++];
          try { decisions.set(record.sessionId, await (io.classifyHourly ?? classifyHourly)(record, { home })); }
          catch (error) { decisions.set(record.sessionId, { action: 'skip', reason: redactSecrets(String(error.message)).slice(0, 300), nextStep: '', error: true }); }
          const decision = decisions.get(record.sessionId);
          if (io.onDecision) io.onDecision({ sessionId: record.sessionId, ...decision });
          else if (isEntry(import.meta.url)) console.log(redactSecrets(JSON.stringify({ sessionId: record.sessionId, ...decision })));
        }
      }));
    }
    const state = (overdue ? null : ledger.nights[night]) ?? { count: 0, errors: 0, aborted: false };
    if (!readonly && !overdue) { delete state.noExecutor; ledger.nights[night] = state; }
    const pending = [...records], running = new Set(), busy = new Set();
    let handoffCount = 0;
    const cwdKeys = new Map();
    for (const record of records) {
      let cwd = record.cwd ?? '';
      if (cwd) { try { cwd = await fs.realpath(cwd); } catch { cwd = path.resolve(cwd); } }
      cwdKeys.set(record, process.platform === 'win32' ? cwd.toLowerCase() : cwd);
    }
    try {
      while (pending.length || running.size) {
        if (fatal) throw fatal;
        const index = pending.findIndex(record => !busy.has(cwdKeys.get(record)));
        if (running.size >= concurrency || index < 0) { await Promise.race(running); continue; }
        const [record] = pending.splice(index, 1);
        const parentId = resumedParentId(record.firstPrompt);
        // 連鎖の子は、祖先が積んだ noProgress を引き継いでから数える（夜ごとに id が変わっても
        // 「同じ目的への挑戦」として合計3回で retire させる）。
        const wait = recordWait(record, now());
        const overdueKey = JSON.stringify([record.sessionId, wait?.key ?? 'hourly-deferred']);
        const entries = overdue ? ledger.overdue : ledger.sessions;
        const entryKey = overdue ? overdueKey : record.sessionId;
        const entry = entries[entryKey] ?? { attempts: [], noProgress: (overdue ? 0 : chainNoProgress(ledger, parentId)) };
        if (hourly) entry.noProgress = Math.max(entry.noProgress || 0, ledger.hourlyFamilies[familyId(record.sessionId)]?.noProgress || 0);
        if (!overdue && parentId && !entry.parentSessionId) entry.parentSessionId = parentId;
        entry.title = record.displayTitle;
        const closed = await loadClosed();
        let mtimeMs;
        try {
          ({ mtimeMs } = await stat(record.file));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          rows.push({ sessionId: record.sessionId, title: record.displayTitle, attempts: entry.attempts.length, skip: '会話ファイル欠損' });
          if (!readonly) { entry.skipReason = '会話ファイル欠損'; entries[entryKey] = entry; }
          continue;
        }
        const resumeAllowed = hourly ? hourlyPolicy.hourlyResume && !usageBlocked : overdue ? (io.eventResumeAllowed ?? eventResumeAllowed)() : autoResumeAllowed();
        const eligibilityEntry = overdue || resumeAllowed ? entry : {};
        let reason = hourly ? hourlySkipReason(record, eligibilityEntry, closed, record.activityMtimeMs ?? mtimeMs, now(), config.activeMs) : overdue ? overdueSkipReason(record, eligibilityEntry, closed, record.activityMtimeMs ?? mtimeMs, now(), config.activeMs) : skipReason(record, eligibilityEntry, night, closed, mtimeMs, now(), config.activeMs);
        if (overdue && record.detectedMtimeMs !== undefined && record.detectedMtimeMs !== mtimeMs) reason = 'active';
        const row = { sessionId: record.sessionId, title: record.displayTitle, attempts: entry.attempts.length, skip: reason,
          due: parseWaitFooter(record.lastAssistantText).due?.toISOString() || '' };
        rows.push(row);
        if (hourly && !reason) {
          try {
            row.decision = decisions.get(record.sessionId) ?? { action: 'skip', reason: '事前判定対象外', nextStep: '' };
            if (row.decision.error && io.hourlyStats) io.hourlyStats.error = row.decision.reason;
            entry.decision = row.decision;
            record.lastLineHash ||= row.decision.fingerprint;
            if (row.decision.action !== 'resume') {
              row.skip = row.decision.action;
              if (!readonly) {
                if (row.decision.action === 'waiting-human') {
                  const noticeKind = decideStalledNoticeKind({ reason: row.decision.reason, nextStep: row.decision.nextStep });
                  const subject = noticeKind === 'info' ? `【停滞の記録】${record.displayTitle}` : `【再開の判断待ち】${record.displayTitle}`;
                  const delivery = await addOverdueInbox(io, home, { kind: noticeKind, forceKind: true, source: 'stalled-session-hourly-preflight', sessionId: record.sessionId,
                    dedupeKey: record.sessionId, text: redactSecrets(`${subject}\n理由: ${row.decision.reason}\n確認事項: ${row.decision.nextStep}`) });
                  row.askSubject = subject;
                  row.askDelivery = delivery?.delivered || delivery?.status || 'saved';
                  if (isEntry(import.meta.url)) console.log(JSON.stringify({ sessionId: record.sessionId, askSubject: redactSecrets(subject), askDelivery: row.askDelivery }));
                }
                entries[entryKey] = entry; await save(ledger);
              }
              continue;
            }
            if (readonly) { row.plannedAction = 'fork再開（dry-run: 起動なし）'; continue; }
          } catch (error) {
            row.skip = '事前判定・ask保存失敗'; row.error = redactSecrets(String(error.message)).slice(0, 200);
            if (io.hourlyStats) io.hourlyStats.error = row.error;
            continue;
          }
        }
        if (!readonly && hourly && (usageBlocked || hourlyGuard.blocked) && !reason && handoffCount < hourlyPolicy.hourlyCap) {
          await loadFleetRows();
          const handoff = (io.handoffSession ?? handoffSession)({
            record: { ...entry, title: record.displayTitle, sessionId: record.sessionId, hostname: os.hostname(), cwd: record.cwd,
              firstUserText: record.firstPrompt, lastAssistantText: record.lastAssistantText, due: parseWaitFooter(record.lastAssistantText).due?.toISOString(),
              reason: `${entry.skipReason || '利用量の上限で元PCで再開できない'}\n事前判定の次の手順: ${row.decision?.nextStep || ''}\nこの無人再開では社外送信・支払い・削除・権限変更・Discord DMを実施しない。必要な判断はkim-inboxのaskに記録する。` },
            fleetRows, repo: path.resolve(import.meta.dirname, '..'), home, now: now(), stopPct: hourlyPolicy.planUsageStopPct,
            directiveSender: io.directiveSender ?? sendFleetDirective
          });
          if (handoff.handedOff) {
            handoffCount++;
            Object.assign(entry, { handedOffTo: handoff.target, handedOffAt: handoff.handedOffAt, skipReason: '移管済み' });
            entries[entryKey] = entry;
            Object.assign(row, { skip: '移管済み', plannedAction: '他PCへ移管', handedOffTo: handoff.target, handedOffAt: handoff.handedOffAt });
            await save(ledger);
            continue;
          }
        }
        if (hourly && !reason && hourlyGuard.blocked) { row.skip = formatClaudeSeatGuardSkip(hourlyGuard); continue; }
        let event;
        let humanAsk;
        if (overdue && !reason) {
          const { due, remainingMs } = parseWaitFooter(record.lastAssistantText);
          const safeStart = latestSafeStart(due, remainingMs);
          // 一覧・dry-run では外部 check を実行しない。
          if (readonly) {
            row.plannedAction = hourly && resumeAllowed ? '毎時再開' : hourly && usageBlocked ? '他PCへ移管' : resumeAllowed ? 'open check と納期を判定' : '納期と次の確認時刻を判定';
            continue;
          }
          const checks = hourly ? [] : (io.openChecks ?? openChecks)(home, record.sessionId);
          const met = checks.some(check => (io.executeCheck ?? executeCheck)(check, { home }).code === 0);
          const checkedAt = now();
          if (record.detectedMtimeMs !== undefined && (await stat(record.file).catch(() => ({}))).mtimeMs !== mtimeMs) {
            row.skip = 'active';
            continue;
          }
          event = hourly ? 'hourly' : met ? 'check-met' : safeStart && checkedAt >= safeStart.getTime() ? 'due-risk' : null;
          const footer = footerValues(String(record.lastAssistantText ?? '').replace(/：/g, ':'));
          if (!hourly && !checks.length && footer?.nextAction && !NO_ACTION_PATTERN.test(footer.nextAction) &&
              /判断|承認|決裁|同意|支払|署名|押印|選択/.test(footer.nextAction)) {
            humanAsk = async () => {
              const source = 'stalled-session-resume-overdue';
              await addOverdueInbox(io, home, { kind: 'ask', source, sessionId: record.sessionId,
                dedupeKey: `${source}:${record.sessionId}:${wait?.key || 'hourly'}`, text: redactSecrets(footer.nextAction) });
            };
          }
          row.plannedAction = event ?? '待機期限を延長';
          if (!event || !resumeAllowed) {
            if (event && humanAsk) {
              try {
                await humanAsk();
                entry.waitingHuman = { until: checkedAt + 7 * 24 * HOUR_MS };
                entries[entryKey] = entry;
                row.skip = '人の判断待ち';
              } catch { row.skip = '判断依頼の配達に失敗'; }
            } else if (event) {
              row.skip = 'イベント再開は無効';
            } else {
              const nextCheckAt = startMs + (Math.floor((checkedAt - startMs) / CHECK_INTERVAL_MS) + 1) * CHECK_INTERVAL_MS;
              const until = new Date(Math.min(nextCheckAt, safeStart?.getTime() ?? Infinity));
              const title = await (io.updateWaitTitle ?? updateWaitTitle)(
                { transcript_path: record.file, session_id: record.sessionId },
                { waitUntil: until, expectedMtimeMs: mtimeMs }
              );
              row.skip = title ? '待機期限を延長' : 'タイトル更新なし';
            }
            continue;
          }
          const limit = hourly
            ? hourlyEventLimit(ledger.eventAttempts.map(a => ({ ...a, sessionId: familyId(a.sessionId) })), familyId(record.sessionId), checkedAt, hourlyPolicy)
            : eventLimit(ledger.eventAttempts, record.sessionId, checkedAt);
          if (limit) {
            await notifyEventLimit(io, home, ledger.eventLimitNotices, record.sessionId, limit, checkedAt, hourly ? hourlyPolicy : {});
            reason = limit === 'global' ? 'イベント再開の時間上限' : 'イベント再開の日次上限';
          }
        }
        if (resumeAllowed) {
          if (!reason && state.aborted) reason = '連続3件エラーで今晩中止';
          if (!reason && state.noExecutor) reason = '実行役なし';
          if (!reason && !overdue && now() >= deadline.getTime()) reason = '締切超過(翌晩へ)';
          if (!reason && state.count >= config.limit) reason = overdue ? '今回の件数上限' : '今晩の件数上限';
        }
        row.skip = reason;
        if (reason) {
          if (!readonly) { entry.skipReason = reason; entries[entryKey] = entry; }
          if (!readonly && overdue && ['今回の件数上限', 'イベント再開の時間上限'].includes(reason)) entry.deferredAt ??= now();
          continue;
        }
        if (!resumeAllowed && wait) {
          row.skip = '待機専用モードで監視';
          continue;
        }
        if (!resumeAllowed) {
          row.skip = '自動再開は廃止';
          if (readonly) continue;
          entry.skipReason = '自動再開は廃止';
          entries[entryKey] = entry;
          ledger.autoResumeDisabledNotified ??= {};
          if (!ledger.autoResumeDisabledNotified[record.sessionId]) {
            if ((io.autoResumeDisabledByConfig ?? autoResumeDisabledByConfig)()) {
              console.log(`[stalled-session-resume] auto-resume disabled by config, skipping kim-inbox notification for session ${record.sessionId}`);
              ledger.autoResumeDisabledNotified[record.sessionId] = new Date(now()).toISOString();
            } else {
              try {
                const { addItem } = await import('./kim-inbox.mjs');
                await (io.addItem ?? addItem)(home, { kind: 'info', source: 'stalled-session-auto-resume-disabled', sessionId: record.sessionId, dedupeKey: `auto-resume-disabled:${record.sessionId}`, text: `自動再開は行いません。続けるときはこのセッションを開いて指示してください: claude --resume ${record.sessionId}` });
                ledger.autoResumeDisabledNotified[record.sessionId] = new Date(now()).toISOString();
              } catch { /* 通知失敗時は次回再試行する */ }
            }
          }
          await save(ledger);
          continue;
        }
        state.count++;
        if (readonly) continue;
        if (!overdue) ledger.nights[night] = state;
        entries[entryKey] = entry;
        delete entry.skipReason;
        delete entry.deferredAt;
        // 起動前に消費を確定し、親が落ちても同じ晩に二重実行しない。
        const attempt = { night, startedAt: new Date(now()).toISOString(), outcome: 'interrupted', executor: 'not-started', ...(overdue ? { via: 'claude-resume' } : {}) };
        entry.attempts.push(attempt);
        entry.noProgress++;
        await save(ledger);
        // Scheduler owns launches; completions share a serialized snapshot writer.
        const cwdKey = cwdKeys.get(record);
        busy.add(cwdKey);
        const job = (async () => {
          let result, eventReservation;
          try {
            // 既に完了済み（auto-progress-resume state = done/progressed）ならスキップ
            const aprFile = path.join(home, '.claude', `auto-progress-resume-${record.sessionId}.json`);
            try {
              const apr = JSON.parse(await fs.readFile(aprFile, 'utf8'));
              if ((apr.state === 'done' || apr.state === 'progressed') && !overdue) {
                entry.attempts.pop(); entry.noProgress = Math.max(0, entry.noProgress - 1); state.count--;
                entry.skipReason = '完了済み';
                rows.find(row => row.sessionId === record.sessionId).skip = '完了済み';
                await save(ledger);
                return;
              }
            } catch { /* apr file not found or parse error, continue to resume attempt */ }
            if (!record.cwd) throw new Error('cwd missing');
            const resultFile = path.join(dir, `stalled-result-${record.sessionId}-${night}.json`);
            await fs.rm(resultFile, { force: true });
            const stop = state.noExecutor ? '実行役なし' : state.aborted ? '連続3件エラーで今晩中止' : !overdue && now() >= deadline.getTime() ? '締切超過(翌晩へ)' : '';
            if (stop) {
              entry.attempts.pop(); entry.noProgress = Math.max(0, entry.noProgress - 1); state.count--;
              entry.skipReason = stop;
              rows.find(row => row.sessionId === record.sessionId).skip = stop;
              await save(ledger);
              return;
            }
            if (overdue) {
              const at = now();
              ledger.eventAttempts = ledger.eventAttempts.filter(attempt =>
                attempt.at > at - HOUR_MS || localDate(new Date(attempt.at)) === localDate(new Date(at)));
              eventReservation = { sessionId: record.sessionId, at };
              ledger.eventAttempts.push(eventReservation);
              await save(ledger);
            }
            result = await (io.execute ?? execute)(record, { timeoutMs: config.timeoutMs, resultFile, previous: entry.attempts.slice(-4, -1), wait: overdue ? wait : null, event, hourly, standingPermission: standing.get(record.sessionId), nextStep: row.decision?.nextStep }, { ...io, home,
              beforeForkLaunch: hourly ? async ({ forkSessionId, forkFile }) => {
                ledger.forks ??= {}; ledger.forks[forkSessionId] = record.sessionId;
                entry.pendingFork = { id: forkSessionId, file: forkFile, fingerprint: row.decision?.fingerprint };
                ledger.hourlyFamilies[familyId(record.sessionId)] = { ...ledger.hourlyFamilies[familyId(record.sessionId)], noProgress: entry.noProgress };
                await save(ledger);
              } : undefined,
            });
            if (!['progressed', 'done', 'waiting-human', 'no-progress', 'no-report', 'timeout', 'error', 'no-executor', 'not-in-session', 'disabled', 'skipped'].includes(result?.outcome)) throw new Error('Invalid execution outcome');
            if (hourly && result.forkSessionId && result.launched) {
              ledger.forks ??= {}; ledger.forks[result.forkSessionId] = record.sessionId;
              if (result.resumedInSession === true) {
                entry.forkSessionId = result.forkSessionId; entry.resumedFingerprint = row.decision?.fingerprint;
              }
            }
            if (hourly && ['skipped', 'disabled', 'no-executor'].includes(result.outcome)) {
              if (eventReservation) eventReservation.outcome = 'disabled';
              state.count--; entry.noProgress = Math.max(0, entry.noProgress - 1);
              ledger.hourlyFamilies[familyId(record.sessionId)] = { ...ledger.hourlyFamilies[familyId(record.sessionId)], noProgress: entry.noProgress };
            }
          } catch (error) { const msg = String(error.message ?? ''); result = { outcome: /timeout|timed out|ETIMEDOUT|aborted due to timeout/i.test(msg) ? 'timeout' : 'error', reason: msg }; }
          if (humanAsk && ['error', 'not-in-session', 'no-executor', 'disabled', 'timeout'].includes(result.outcome) && !entry.waitingHuman) {
            try {
              await humanAsk();
              entry.waitingHuman = { until: now() + 7 * 24 * HOUR_MS };
            } catch { /* 通知に失敗したら次回再試行する */ }
          }
          if (overdue && result.outcome === 'no-executor') result = { ...result, outcome: 'error' };
          if (result.outcome === 'no-executor') {
            // 起動前に消費した試行を戻す(このセッションは何も試されていない)。レーン停止の通知は
            // delegation-health が障害詳細を通知する。ここでは集計だけ送り、新規起動を打ち切る。
            entry.attempts.pop();
            entry.noProgress = Math.max(0, entry.noProgress - 1);
            state.count--;
            state.noExecutor = redactSecrets(String(result.reason ?? '')).slice(0, 500);
            await save(ledger);
            return;
          }
          // overdue で予備 executor が成功しても transcript が増えなければ progressed にしない
          if (overdue && result.resumedInSession === false && result.outcome !== 'not-in-session') {
            result = { ...result, outcome: 'not-in-session', reason: `予備executor成功だがセッション自身の再開ではない: ${result.reason}` };
          }
          Object.assign(attempt, result, { executor: result.executor || 'not-started', reason: redactSecrets(String(result.reason ?? '')).slice(0, 2000), endedAt: new Date(now()).toISOString() });
          if (eventReservation && eventReservation.outcome !== 'disabled') eventReservation.outcome = result.outcome;
          const ancestors = overdue ? [] : chainAncestors(ledger, entry.parentSessionId);
          if (result.outcome === 'progressed') {
            entry.noProgress = 0;
            for (const ancestor of ancestors) { ancestor.noProgress = 0; delete ancestor.skipReason; }
          } else if (result.outcome === 'done' || result.outcome === 'waiting-human') {
            entry.noProgress = Math.max(0, entry.noProgress - 1);
            if (result.outcome === 'done') {
              await closeSession(record.sessionId, { closedAt: new Date(now()).toISOString(), reason: 'stalled-resume-done', status: '完了', title: record.displayTitle, cwd: record.cwd, file: record.file });
            } else {
              entry.waitingHuman = { askId: result.askId, until: now() + 7 * 86400000 };
            }
          } else {
            // 子の不進捗は同じ目的を継ぐ祖先の予算にも加算する。これが無いと子の id が
            // 毎晩変わるだけで祖先の noProgress が増えず、連鎖が retire されない。
            for (const ancestor of ancestors) {
              ancestor.noProgress = (ancestor.noProgress ?? 0) + 1;
              if (ancestor.noProgress >= 3) ancestor.skipReason = '3回進捗なし';
            }
          }
          if (hourly && result.launched) ledger.hourlyFamilies[familyId(record.sessionId)] = { ...ledger.hourlyFamilies[familyId(record.sessionId)], noProgress: entry.noProgress };
          if (!overdue) {
            if (entry.noProgress >= 3) entry.skipReason = '3回進捗なし';
            // 時間切れは今晩中止の判定対象外: 連続エラーに加算もリセットもしない（noProgress は no-progress 同様に加算済み）。
            if (result.outcome === 'error') state.errors += 1;
            else if (result.outcome !== 'timeout') state.errors = 0;
            state.aborted ||= state.errors >= 3;
          }
          if (overdue && (entry.noProgress ?? 0) >= 3 && (hourly || entry.attempts.filter(a => a.outcome === 'no-progress').length >= 3) && !entry.notifiedNoProgress && !(hourly && ledger.hourlyFamilies[familyId(record.sessionId)]?.notifiedNoProgress)) {
            entry.skipReason = '3回進捗なし';
            entry.notifiedNoProgress = true;
            try { await addOverdueInbox(io, home, { kind: 'ask', source: 'stall-hourly-no-progress', sessionId: record.sessionId,
              dedupeKey: `stall-hourly-no-progress:${record.sessionId}:${localDate(new Date(now()))}`,
              text: `${record.displayTitle}：3回再開しても進まないため停止。止まっている理由: ${attempt.reason || '進捗記録なし'}。判断してほしいこと: 自動再開を続けるか、終了するか。` });
              if (hourly) ledger.hourlyFamilies[familyId(record.sessionId)].notifiedNoProgress = true;
            }
            catch { /* 通知失敗は再開に影響させない */ }
          }
          const hourlyDue = hourly ? parseWaitFooter(record.lastAssistantText).due : null;
          if (hourlyDue && hourlyDue.getTime() <= now() + 24 * HOUR_MS && !['progressed', 'done'].includes(attempt.outcome)) {
            try { await addOverdueInbox(io, home, { kind: 'ask', source: 'stall-hourly-due-risk', sessionId: record.sessionId,
              dedupeKey: `stall-hourly-due-risk:${record.sessionId}:${localDate(new Date(now()))}`,
              text: `${record.displayTitle}：納期${hourlyDue.toISOString()}まで24時間以内。止まっている理由: ${attempt.reason || attempt.outcome}。判断してほしいこと: 残作業の優先順位または進め方を決めてください。` }); }
            catch { /* 次回再試行 */ }
          }
          // overdue で同一期限3回エラーになったら kim-inbox に info を1回だけ積む。
          if (overdue && entry.attempts.filter(a => a.via && a.outcome !== 'not-in-session').length >= 3 && !entry.notified3Error && !OVERDUE_SUCCESS_OUTCOMES.has(attempt.outcome)) {
            entry.notified3Error = true;
            const overdueMsg = `【期限切れ再開 3回失敗】${record.displayTitle} (${record.sessionId})\n期限: ${wait?.label || ''}\n最終 executorAttempts: ${JSON.stringify(attempt.executorAttempts ?? [])}\n最終 outcome: ${attempt.outcome}\n最終 reason: ${attempt.reason || ''}`;
            try { await (io.notify ?? notifyKim)(overdueMsg, { home }); }
            catch { /* 通知失敗は再開に影響させない */ }
          }
          results.push({ title: record.displayTitle, sessionId: record.sessionId, ...attempt });
          await save(ledger);
        })();
        const tracked = job.finally(() => { busy.delete(cwdKey); running.delete(tracked); });
        running.add(tracked);
        // Keep rejections observed while the scheduler is awaiting filesystem IO.
        tracked.catch(error => { fatal = error; });
      }
    } finally { await Promise.all([...running]); }
    if (fatal) throw fatal;

    if (!readonly && records.length) await save(ledger);
    if (!overdue && autoResumeAllowed() && !readonly && records.length) {
      const closed = await loadClosed();
      const retired = Object.entries(overdue ? {} : ledger.sessions).filter(([id, entry]) => entry.noProgress >= 3 && !closed.sessions[id]);
      const count = outcome => results.filter(r => r.outcome === outcome).length;
      const summary = `確認 ${results.length}件 / 進んだ ${count('progressed')} / 完了確認 ${count('done')} / 人待ち ${count('waiting-human')} / 進まず ${count('no-progress')} / セッション未反映 ${count('not-in-session')} / 記録なし ${count('no-report')} / 時間切れ ${count('timeout')} / エラー ${count('error')} / 締切で翌晩へ ${rows.filter(r => r.skip === '締切超過(翌晩へ)').length} / 3回進捗なしで停止中 ${retired.length}`;
      const waiting = retired.length ? '\n自動では進められないので kim の判断待ち\n' + retired.slice(0, 20).map(([id, entry]) => `${entry.title ?? id} (${id})`).join('\n') : '';
      const message = redactSecrets(`${summary}\n${overdue ? '待機期限切れセッション再開' : '夜間セッション再開'} (${os.hostname()})\n${results.map(r => `${r.title} (${r.sessionId}): ${r.outcome}`).join('\n')}${state.aborted ? '\n連続3件エラーのため今晩は中止' : ''}${waiting}`);
      const allClean = !state.aborted && !state.noExecutor && count('not-in-session') === 0 && count('no-progress') === 0 && count('no-report') === 0 && count('timeout') === 0 && count('error') === 0 && retired.length === 0;
      state.notification = allClean ? { skipped: 'all-clean' } : await (io.notify ?? notifyKim)(message, { home });
      await save(ledger);
    }
    return { rows, results, aborted: state.aborted, ...(state.noExecutor ? { noExecutor: state.noExecutor } : {}) };
  } catch (error) { thrown = error; throw error; } finally {
    if (lock) lock();
    // 実行ログ: 例外で落ちる場合も finally で書く
    if (!readonly) {
      const outcome = thrown || fatal ? 'error' : 'ran';
      const counts = {};
      for (const r of results) {
        const key = r.outcome || 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
      }
      for (const r of rows) {
        if (r.skip) { counts[`skipped:${r.skip}`] = (counts[`skipped:${r.skip}`] ?? 0) + 1; }
      }
      const logEntry = {
        ts: startedAt, endedAt: new Date(now()).toISOString(), host: os.hostname(), pid: process.pid,
        night, mode: hourly ? 'hourly' : config.dryRun ? 'dry' : config.list ? 'list' : 'run', outcome, counts, usage: usageState,
        ...(lockInfo ? { reclaimedLock: lockInfo } : {}),
        ...(fatal || thrown ? { error: redactSecrets(String((thrown?.message ?? thrown) || (fatal?.message ?? fatal))).slice(0, 2000) } : {})
      };
      await writeLog(home, logEntry).catch(() => {});
      if (hourly) {
        const resultById = new Map(results.map(item => [item.sessionId, item]));
        const entries = rows.filter(row => row.skip !== '完了済み').map(row => {
          const result = resultById.get(row.sessionId);
          return { title: row.title, sessionId: row.sessionId, due: row.due,
            type: row.skip === '移管済み' ? '移管済み' : row.skip === '3回進捗なし' ? '打ち切り' : row.title?.includes('まで】') ? '期限切れ' : '先送り',
            lastResult: result?.outcome || row.skip || '候補', lastAttemptAt: result?.endedAt || now(), handedOffTo: row.handedOffTo, handedOffAt: row.handedOffAt };
        });
        if (os.hostname() === '000KimPC') entries.push(...collectGbReportEntries({ now: now() }));
        try {
          const localLedger = writeStallLedger({ home, hostname: os.hostname(), entries, now: now() });
          if (os.hostname() === '000KimPC') {
            let allRows = io.fleetRows;
            if (!allRows) {
              const fetched = await (io.fetchBeacons ?? fetchBeacons)({ home, fetchImpl: io.fetch, timeoutMs: 15000, retries: 0 });
              const pcMap = io.pcMap ?? await readJson(path.resolve(import.meta.dirname, '..', 'fleet-pc-map.json'), {});
              allRows = buildFleetStatus({ pcMap, beacons: fetched.beacons, serverPolls: fetched.serverPolls, now: now() });
            }
            writeAllLedgers({ home, ownLedger: { hostname: os.hostname(), updatedAt: new Date(now()).toISOString(), summary: localLedger.summary }, fleetRows: allRows, now: now() });
          }
        } catch { /* 台帳失敗で再開結果を失わない */ }
      }
      if (outcome === 'error' && !config.dryRun && !config.list) {
        const reason = redactSecrets(String(thrown?.message ?? thrown ?? fatal?.message ?? fatal ?? '')).slice(0, 200);
        const msg = `停滞セッション全件確認: 今晩は途中で失敗（理由: ${reason}）。翌晩に再試行します。`;
        await (io.notify ?? notifyKim)(msg, { home }).catch(() => {});
        process.exitCode = 3;
      }
    }
  }
}
export async function main(argv = process.argv.slice(2), io = {}) {
  return run(options(argv), io);
}
if (isEntry(import.meta.url)) {
  try { const config = options(process.argv.slice(2)); const result = await run(config); console.log(redactSecrets(JSON.stringify({ executor: config.hourly ? 'claude-fork-session' : autoSessionExecutor(), ...result }, null, 2))); if (result.results.some(r => r.outcome === 'error')) process.exitCode = 1; }
  catch (error) { console.error(redactSecrets(error.message)); process.exitCode = 1; }
}
