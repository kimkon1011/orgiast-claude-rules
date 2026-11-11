#!/usr/bin/env node
// No LLM calls here; process execution, notification and file timestamps are injectable.
import fs from 'node:fs/promises';
import { latestWaitDeadline, waitPrefix } from './session-wait-title.mjs';
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

const execFileAsync = promisify(execFile);

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
  const overdue = argv.includes('--overdue') || env.STALLED_SESSION_MODE === 'overdue';
  const out = { overdue, limit: parseLimit(env.STALLED_SESSION_LIMIT ?? (overdue ? '2' : 'all')), timeoutMs: Number(env.STALLED_SESSION_TIMEOUT_MIN ?? 20) * 60000,
    activeMs: Number(env.STALLED_SESSION_ACTIVE_MIN ?? 10) * 60000, concurrency: Number(overdue ? 1 : (env.STALLED_SESSION_CONCURRENCY ?? 2)), deadline: env.STALLED_SESSION_DEADLINE ?? '07:30', dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--overdue') continue;
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
    const raw = await fs.readFile(file, 'utf8');
    const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return JSON.parse(cleaned);
  } catch { return fallback; }
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
export async function detect() {
  return (await Promise.all((await listFiles()).map(inspect))).filter(Boolean);
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
const WAIT_TITLE = /^(?:\d{3}｜)?【(?:(\d{2})\/)?(\d{2})\/(\d{2})\/(\d{2}):(\d{2})まで】/;

export function waitDeadline(displayTitle, now) {
  const match = WAIT_TITLE.exec(String(displayTitle ?? ''));
  if (!match) return null;
  const [, yy, month, day, hour, minute] = match;
  const at = year => new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
  let deadline = yy ? at(2000 + Number(yy)) : at(new Date(now).getFullYear());
  if (!yy && deadline - now > 180 * 86400000) deadline = at(new Date(now).getFullYear() - 1);
  return { key: match[0].replace(/^\d{3}｜/, ''), label: `${month}/${day} ${hour}:${minute}`, at: deadline };
}
export function titleSkipReason(displayTitle, now) {
  if (CLOSABLE_TITLE.test(String(displayTitle ?? ''))) return '閉じて可';
  const wait = waitDeadline(displayTitle, now);
  return wait && now < wait.at ? '待機期限前' : '';
}
// overdue の「処理済み」判定は progressed / no-progress だけ。
// error / timeout / interrupted / その他は再試行対象（30分バックオフ、同一期限で最大3回）。
// interrupted は起動中ロックがない古いもの（30分超）だけ再試行対象にする。
const OVERDUE_SUCCESS_OUTCOMES = new Set(['progressed', 'no-progress', 'done', 'waiting-human']);
export function overdueSkipReason(record, entry, closed, mtimeMs, now, activeMs) {
  if (entry.waitingHuman?.until > now) return '人の判断待ち';
  const common = skipReason(record, {}, '', closed, mtimeMs, now, activeMs);
  if (common) return common;
  const wait = waitDeadline(record.displayTitle, now);
  if (!wait || wait.at > now) return '期限切れ待機ではない';
  const attempts = (entry.attempts ?? []).filter(a => a.outcome !== 'not-in-session' && a.resumedInSession !== false);
  if (attempts.some(a => OVERDUE_SUCCESS_OUTCOMES.has(a.outcome))) return '同一期限処理済み';
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
  const deadline = latestWaitDeadline(record.lastAssistantText);
  if (closed.sessions[record.sessionId] && !deadline) return 'closed';
  if (entry.waitingHuman?.until > now) return '人の判断待ち';
  const titleSkip = titleSkipReason(deadline ? waitPrefix(deadline) : record.displayTitle, now);
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
  const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
このセッションの待機期限 ${wait.label} を過ぎました。待っていた事項（相手の返信・外部の状態・自動チェック）を直接照会し、(a) 進められるなら最後まで進めて検証する (b) 人の判断や操作が必要なら kim-inbox に ask を積み（node tools/kim-inbox.mjs）、応答の「このセッション」行に新しい期限を書く (c) 目的が完了していれば /session-close を実行する。期限を書き換えるだけで終えない。
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
      await invoke(executable, ['--resume', record.sessionId, '-p', prompt], {
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
  if (result.skippedNoExecutor) return { ...execution, outcome: 'no-executor', reason: `実行役なし: ${String(result.stderr ?? '').trim().slice(-300) || result.executorUsed || 'cheap-code'}` };
  const timedOut = result.status === 'timeout';
  if (result.status !== 'success' && !timedOut) return { ...execution, outcome: 'error', reason: result.status };
  let report;
  try {
    const rawReport = await (io.readReport ?? readSanitizedJson)(resultFile, null);
    report = rawReport;
    if (typeof rawReport === 'string') {
      const cleaned = rawReport.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      report = cleaned.trim() ? JSON.parse(cleaned) : null;
    }
  } catch (error) { return { ...execution, outcome: 'error', reason: String(error.message) }; }
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

export async function execute(record, { timeoutMs, resultFile, previous = [], wait = null }, io = {}) {
  // overdue モードでは claude --resume でセッション自身を再開する
  if (wait) {
    return executeOverdue(record, { timeoutMs, resultFile, previous, wait }, io);
  }
  const prompt = `停滞セッション「${record.displayTitle}」(${record.sessionId})の承認済みの目的を1歩進めてください。
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
      report = cleaned.trim() ? JSON.parse(cleaned) : null;
    }
  } catch (error) { return { ...execution, outcome: 'error', reason: String(error.message) }; }
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

export async function run(config = options(), io = {}) {
  const overdue = config.overdue === true;
  const home = io.home ?? process.env.ORGIAST_HOME ?? os.homedir();
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
  const startedAt = new Date(now()).toISOString();
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
    if (overdue) ledger.overdue ??= {};
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
    const overdueTitle = record => {
      const wait = waitDeadline(record.displayTitle, now());
      return !!wait && wait.at <= now();
    };
    const records = (await (io.detect ?? detect)())
      .filter(r => overdue ? !!waitDeadline(r.displayTitle, now()) : ['要対応', '要確認'].includes(r.status))
      .sort((a, b) => (overdue ? Number(!!ledger.overdue[JSON.stringify([b.sessionId, waitDeadline(b.displayTitle, now())?.key])]?.deferredAt) - Number(!!ledger.overdue[JSON.stringify([a.sessionId, waitDeadline(a.displayTitle, now())?.key])]?.deferredAt) : 0)
        || Number(overdueTitle(b)) - Number(overdueTitle(a))
        || (ledger.sessions[a.sessionId]?.attempts?.at(-1)?.night ?? '').localeCompare(ledger.sessions[b.sessionId]?.attempts?.at(-1)?.night ?? '')
        || b.score - a.score || a.ageDays - b.ageDays);
    rows = []; results = [];
    const state = (overdue ? null : ledger.nights[night]) ?? { count: 0, errors: 0, aborted: false };
    if (!readonly && !overdue) { delete state.noExecutor; ledger.nights[night] = state; }
    const pending = [...records], running = new Set(), busy = new Set();
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
        if (running.size >= (config.concurrency ?? 2) || index < 0) { await Promise.race(running); continue; }
        const [record] = pending.splice(index, 1);
        const parentId = resumedParentId(record.firstPrompt);
        // 連鎖の子は、祖先が積んだ noProgress を引き継いでから数える（夜ごとに id が変わっても
        // 「同じ目的への挑戦」として合計3回で retire させる）。
        const wait = waitDeadline(record.displayTitle, now());
        const overdueKey = JSON.stringify([record.sessionId, wait?.key]);
        const entries = overdue ? ledger.overdue : ledger.sessions;
        const entryKey = overdue ? overdueKey : record.sessionId;
        const entry = entries[entryKey] ?? { attempts: [], noProgress: (overdue ? 0 : chainNoProgress(ledger, parentId)) };
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
        let reason = overdue ? overdueSkipReason(record, entry, closed, mtimeMs, now(), config.activeMs) : skipReason(record, entry, night, closed, mtimeMs, now(), config.activeMs);
        if (!reason && state.aborted) reason = '連続3件エラーで今晩中止';
        if (!reason && state.noExecutor) reason = '実行役なし';
        if (!reason && !overdue && now() >= deadline.getTime()) reason = '締切超過(翌晩へ)';
        if (!reason && state.count >= config.limit) reason = overdue ? '今回の件数上限' : '今晩の件数上限';
        rows.push({ sessionId: record.sessionId, title: record.displayTitle, attempts: entry.attempts.length, skip: reason, ...(overdue ? { plannedAction: `claude --resume ${record.sessionId} -p <待機期限プロンプト> で再開する予定` } : {}) });
        if (reason) {
          if (!readonly) { entry.skipReason = reason; entries[entryKey] = entry; }
          // overdue で件数上限に溢れたものは、skipReason を削除して次回再試行対象にする
          if (!readonly && overdue && reason === '今回の件数上限') {
            entry.deferredAt ??= now();
          }
          continue;
        }
        state.count++;
        if (readonly) continue;
        if (!overdue) ledger.nights[night] = state;
        entries[entryKey] = entry;
        delete entry.skipReason;
        delete entry.deferredAt;
        // 起動前に消費を確定し、親が落ちても同じ晩に二重実行しない。
        const attempt = { night, startedAt: new Date(now()).toISOString(), outcome: 'interrupted', executor: 'not-started' };
        entry.attempts.push(attempt);
        entry.noProgress++;
        await save(ledger);
        // Scheduler owns launches; completions share a serialized snapshot writer.
        const cwdKey = cwdKeys.get(record);
        busy.add(cwdKey);
        const job = (async () => {
          let result;
          try {
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
            result = await (io.execute ?? execute)(record, { timeoutMs: config.timeoutMs, resultFile, previous: entry.attempts.slice(-4, -1), wait: overdue ? wait : null });
            if (!['progressed', 'done', 'waiting-human', 'no-progress', 'no-report', 'timeout', 'error', 'no-executor', 'not-in-session'].includes(result?.outcome)) throw new Error('Invalid execution outcome');
          } catch (error) { const msg = String(error.message ?? ''); result = { outcome: /timeout|timed out|ETIMEDOUT|aborted due to timeout/i.test(msg) ? 'timeout' : 'error', reason: msg }; }
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
          if (!overdue) {
            if (entry.noProgress >= 3) entry.skipReason = '3回進捗なし';
            // 時間切れは今晩中止の判定対象外: 連続エラーに加算もリセットもしない（noProgress は no-progress 同様に加算済み）。
            if (result.outcome === 'error') state.errors += 1;
            else if (result.outcome !== 'timeout') state.errors = 0;
            state.aborted ||= state.errors >= 3;
          }
          // overdue で同一期限3回失敗したら kim-inbox に info を1回だけ積む
          // 今回の attempt が成功扱い（progressed/no-progress）の場合は通知しない
          if (overdue && entry.attempts.filter(a => a.outcome !== 'not-in-session').length >= 3 && !entry.notified3Error && !OVERDUE_SUCCESS_OUTCOMES.has(attempt.outcome)) {
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
    if (!readonly && records.length && (!overdue || results.length)) {
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
    // overdue モード: 期限切れから2時間以上経過し、誰も再開していないセッションがあれば kim-inbox に ask を積む
    if (overdue && !readonly) {
      const nowMs = now();
      const twoHoursAgo = nowMs - 2 * 3600000;
      for (const record of records) {
        const wait = waitDeadline(record.displayTitle, nowMs);
        if (!wait || wait.at > twoHoursAgo) continue;
        const overdueKey = JSON.stringify([record.sessionId, wait?.key]);
        const entry = ledger.overdue?.[overdueKey];
        if (!entry) continue;
        // 既に progressed / done / waiting-human ならスキップ
        const lastAttempt = entry.attempts?.at(-1);
        if (lastAttempt && OVERDUE_SUCCESS_OUTCOMES.has(lastAttempt.outcome)) continue;
        // 既に kim-inbox に通知済みならスキップ
        if (entry.notifiedStaleOverdue) continue;
        if (['closed', '閉じて可', 'active', '人の判断待ち'].includes(entry.skipReason)) continue;
        try { if ((await stat(record.file)).mtimeMs > wait.at) continue; } catch { continue; }
        const staleMsg = `【期限切れ再開 放置】${record.displayTitle} (${record.sessionId})\n期限: ${wait.label}\n期限切れから2時間以上経過しましたが、誰も再開していません。手動で確認してください。\nsource: stalled-session-resume-overdue`;
        try {
          const { addItem } = await import('./kim-inbox.mjs');
          await (io.addItem ?? addItem)(home, { kind: 'ask', text: staleMsg, source: 'stalled-session-resume-overdue', sessionId: record.sessionId });
          entry.notifiedStaleOverdue = true;
        } catch { /* kim-inbox が使えなければ通知は諦める */ }
      }
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
        night, mode: config.dryRun ? 'dry' : config.list ? 'list' : 'run', outcome, counts,
        ...(lockInfo ? { reclaimedLock: lockInfo } : {}),
        ...(fatal || thrown ? { error: redactSecrets(String((thrown?.message ?? thrown) || (fatal?.message ?? fatal))).slice(0, 2000) } : {})
      };
      await writeLog(home, logEntry).catch(() => {});
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
  try { const config = options(process.argv.slice(2)); const result = await run(config); console.log(redactSecrets(JSON.stringify({ executor: autoSessionExecutor(), ...result }, null, 2))); if (result.results.some(r => r.outcome === 'error')) process.exitCode = 1; }
  catch (error) { console.error(redactSecrets(error.message)); process.exitCode = 1; }
}
