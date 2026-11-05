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

function parseLimit(value) {
  if (value === 'all') return Infinity;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

export function options(argv = [], env = process.env) {
  const out = { limit: parseLimit(env.STALLED_SESSION_LIMIT ?? 'all'), timeoutMs: Number(env.STALLED_SESSION_TIMEOUT_MIN ?? 20) * 60000,
    activeMs: Number(env.STALLED_SESSION_ACTIVE_MIN ?? 10) * 60000, concurrency: Number(env.STALLED_SESSION_CONCURRENCY ?? 2), deadline: env.STALLED_SESSION_DEADLINE ?? '07:30', dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = parseLimit(argv[++i]);
    else if (argv[i] === '--deadline') out.deadline = argv[++i];
    else if (argv[i] === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--list') out.list = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if ((out.limit !== Infinity && !Number.isSafeInteger(out.limit)) || out.limit < 0 || !Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0 || !Number.isFinite(out.activeMs) || out.activeMs < 0) throw new Error('Invalid limit/timeout/active minutes');
  if (!Number.isSafeInteger(out.concurrency) || out.concurrency < 1 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(out.deadline)) throw new Error('Invalid concurrency/deadline');
  return out;
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

export function titleSkipReason(displayTitle, now) {
  const title = String(displayTitle ?? '');
  if (CLOSABLE_TITLE.test(title)) return '閉じて可';
  const match = WAIT_TITLE.exec(title);
  if (!match) return '';
  const [, yy, month, day, hour, minute] = match;
  const at = (year) => new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
  let deadline = yy ? at(2000 + Number(yy)) : at(new Date(now).getFullYear());
  // 年なし形式は年跨ぎで過去日になり得る。半年以上先なら前年の日付とみなす。
  if (!yy && deadline - now > 180 * 86400000) deadline = at(new Date(now).getFullYear() - 1);
  // 期限切れの待機は解除済みとして再開対象に戻す（永久に無視しない）。
  return now < deadline ? '待機期限前' : '';
}

export function skipReason(record, entry, night, closed, mtimeMs, now, activeMs) {
  if (closed.sessions[record.sessionId]) return 'closed';
  const titleSkip = titleSkipReason(record.displayTitle, now);
  if (titleSkip) return titleSkip;
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
  // 実行役が1つも起動できない(cheap-code 全レーン停止・Claude フォールバック無効)のはセッションの失敗ではない。
  // 2026-10-26 実測: deepseek payment_required で2件が1秒で error 扱い→「連続2件エラーで中止」の誤通知と noProgress 消費。
  if (result.skippedNoExecutor) return { outcome: 'no-executor', reason: `実行役なし: ${String(result.stderr ?? '').trim().slice(-300) || result.executorUsed || 'cheap-code'}` };
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
    const records = (await (io.detect ?? detect)()).filter(r => ['要対応', '要確認'].includes(r.status)).sort((a, b) => (ledger.sessions[a.sessionId]?.attempts?.at(-1)?.night ?? '').localeCompare(ledger.sessions[b.sessionId]?.attempts?.at(-1)?.night ?? '') || b.score - a.score || a.ageDays - b.ageDays);
    const rows = [], results = [];
    const state = ledger.nights[night] ?? { count: 0, errors: 0, aborted: false };
    if (!readonly) { delete state.noExecutor; ledger.nights[night] = state; }
    let fatal;
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
        const entry = ledger.sessions[record.sessionId] ?? { attempts: [], noProgress: chainNoProgress(ledger, parentId) };
        if (parentId && !entry.parentSessionId) entry.parentSessionId = parentId;
        entry.title = record.displayTitle;
        const closed = await loadClosed();
        let mtimeMs;
        try {
          ({ mtimeMs } = await stat(record.file));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          rows.push({ sessionId: record.sessionId, title: record.displayTitle, attempts: entry.attempts.length, skip: '会話ファイル欠損' });
          if (!readonly) { entry.skipReason = '会話ファイル欠損'; ledger.sessions[record.sessionId] = entry; }
          continue;
        }
        let reason = skipReason(record, entry, night, closed, mtimeMs, now(), config.activeMs);
        if (!reason && state.aborted) reason = '連続3件エラーで今晩中止';
        if (!reason && state.noExecutor) reason = '実行役なし';
        if (!reason && now() >= deadline.getTime()) reason = '締切超過(翌晩へ)';
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
            const stop = state.noExecutor ? '実行役なし' : state.aborted ? '連続3件エラーで今晩中止' : now() >= deadline.getTime() ? '締切超過(翌晩へ)' : '';
            if (stop) {
              entry.attempts.pop(); entry.noProgress = Math.max(0, entry.noProgress - 1); state.count--;
              entry.skipReason = stop;
              rows.find(row => row.sessionId === record.sessionId).skip = stop;
              await save(ledger);
              return;
            }
            result = await (io.execute ?? execute)(record, { timeoutMs: config.timeoutMs, resultFile, previous: entry.attempts.slice(-4, -1) });
            if (!['progressed', 'no-progress', 'error', 'no-executor'].includes(result?.outcome)) throw new Error('Invalid execution outcome');
          } catch (error) { result = { outcome: 'error', reason: String(error.message) }; }
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
          Object.assign(attempt, result, { reason: redactSecrets(String(result.reason ?? '')).slice(0, 2000), endedAt: new Date(now()).toISOString() });
          const ancestors = chainAncestors(ledger, entry.parentSessionId);
          if (result.outcome === 'progressed') {
            entry.noProgress = 0;
            for (const ancestor of ancestors) { ancestor.noProgress = 0; delete ancestor.skipReason; }
          } else {
            // 子の不進捗は同じ目的を継ぐ祖先の予算にも加算する。これが無いと子の id が
            // 毎晩変わるだけで祖先の noProgress が増えず、連鎖が retire されない。
            for (const ancestor of ancestors) {
              ancestor.noProgress = (ancestor.noProgress ?? 0) + 1;
              if (ancestor.noProgress >= 3) ancestor.skipReason = '3回進捗なし';
            }
          }
          if (entry.noProgress >= 3) entry.skipReason = '3回進捗なし';
          state.errors = result.outcome === 'error' ? state.errors + 1 : 0;
          state.aborted ||= state.errors >= 3;
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
    if (!readonly && records.length) {
      const closed = await loadClosed();
      const retired = Object.entries(ledger.sessions).filter(([id, entry]) => entry.noProgress >= 3 && !closed.sessions[id]);
      const count = outcome => results.filter(r => r.outcome === outcome).length;
      const summary = `確認 ${results.length}件 / 進んだ ${count('progressed')} / 進まず ${count('no-progress')} / エラー ${count('error')} / 締切で翌晩へ ${rows.filter(r => r.skip === '締切超過(翌晩へ)').length} / 3回進捗なしで停止中 ${retired.length}`;
      const waiting = retired.length ? '\n自動では進められないので kim の判断待ち\n' + retired.slice(0, 20).map(([id, entry]) => `${entry.title ?? id} (${id})`).join('\n') : '';
      const message = redactSecrets(`${summary}\n夜間セッション再開 (${os.hostname()})\n${results.map(r => `${r.title} (${r.sessionId}): ${r.outcome}`).join('\n')}${state.aborted ? '\n連続3件エラーのため今晩は中止' : ''}${waiting}`);
      state.notification = await (io.notify ?? notifyKim)(message, { home });
      await save(ledger);
    }
    return { rows, results, aborted: state.aborted, ...(state.noExecutor ? { noExecutor: state.noExecutor } : {}) };
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
