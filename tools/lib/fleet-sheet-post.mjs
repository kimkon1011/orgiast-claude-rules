// fleet sheet (GAS Web アプリ) への POST を一本化する。
//
// GAS 側は ScriptLock を取れないと HTTP 200 + {ok:false,error:'busy'} を返す
// (gas/fleet-status-sheet/WebApp.gs の tryLock(20000))。つまり busy を受け取った
// 時点でサーバは既に 20 秒待っている。クライアントの再送間隔がそれより短いと、
// 全試行が同じロック保持区間の中に落ちて必ず失敗する。夜間バッチでは
// webhook-health(1s/2s)・fleet-sheet-report(5s/15s)・webhook-inventory(再送なし) が
// 同じ GAS ロックを奪い合い、3 ジョブまとめて busy で落ちていた。
//
// ここでは busy に限り指数バックオフ＋ジッタで再送し、待ち時間の合計を
// 1 夜あたり totalBudgetMs に制限する。予算は 3 ジョブで共有するため
// ファイルに置く（ジョブは直列に別プロセスで走る）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactAll } from './redact.mjs';

export const BUSY_POLICY = Object.freeze({
  maxAttempts: 5,
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.25,
  totalBudgetMs: 180_000,
  budgetResetAfterMs: 30 * 60 * 1000,
});

// 夜間サマリ側 (tools/nightly-batch.ps1) がこの語で警告を検出する。
export const BUSY_EXHAUSTED_MARKER = 'busy_exhausted';

export function isBusyBody(body) {
  if (!body || body.ok !== false) return false;
  return /\bbusy\b/i.test(String(body.error ?? ''));
}

// GAS は busy を HTTP 200 で返すが、ロック待ちで 503 を返す経路もある。
// 403 など恒久的な拒否は再送しない。
export function isBusyResponse(response, body) {
  if (!isBusyBody(body)) return false;
  return Boolean(response?.ok) || response?.status === 503;
}

export function backoffDelay(attempt, { random = Math.random, policy = BUSY_POLICY } = {}) {
  const base = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
  // 上限はジッタ適用後にも掛ける。掛けないと 60 秒の 1.25 倍 = 75 秒まで伸びる。
  return Math.max(0, Math.min(Math.round(base * jitter), policy.maxDelayMs));
}

export function defaultBudgetPath(home = os.homedir()) {
  return path.join(home, '.claude', 'fleet-sheet-busy-budget.json');
}

function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// 前夜の残り予算を翌夜へ持ち越さない。同じ日に手で回し直したときも
// budgetResetAfterMs を過ぎていれば新しい予算で始める。
export function readBusyBudget(file, nowMs, policy = BUSY_POLICY) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
  const fresh = state
    && state.date === dayKey(nowMs)
    && Number.isFinite(state.spentMs)
    && Number.isFinite(state.updatedAtMs)
    && nowMs - state.updatedAtMs < policy.budgetResetAfterMs;
  if (!fresh) return { date: dayKey(nowMs), spentMs: 0, updatedAtMs: nowMs };
  return { date: state.date, spentMs: Math.max(0, state.spentMs), updatedAtMs: state.updatedAtMs };
}

export function chargeBusyBudget(file, nowMs, deltaMs, policy = BUSY_POLICY) {
  const state = readBusyBudget(file, nowMs, policy);
  const next = { date: state.date, spentMs: state.spentMs + Math.max(0, deltaMs), updatedAtMs: nowMs };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 予算ファイルが書けなくても送信は止めない */ }
  return next;
}

function safeError(error) {
  return redactAll(String(error?.message || error?.name || 'error'))
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 160);
}

function withAttempts(error, attempts) {
  error.attempts = attempts;
  return error;
}

function appendLog(logFile, line) {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
  } catch { /* ログが書けなくても送信結果は変えない */ }
}

/**
 * fleet sheet へ 1 件 POST する。
 *
 * 戻り値:
 *   { ok: true, attempts, body }                     送信成功
 *   { ok: false, busyExhausted: true, attempts, waitedMs, error: 'busy' }
 *                                                    busy の再送を使い切った
 * busy 以外の失敗（HTTP 4xx/5xx・不正 JSON・恒久拒否・通信断）は throw する。
 */
export async function postFleetSheet(url, payload, {
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => Date.now(),
  timeoutMs = 60_000,
  policy = BUSY_POLICY,
  budgetPath = null,
  logFile = null,
  kind = 'fleet-sheet',
  retryOnNetwork = false,
} = {}) {
  const startedAt = now();
  let attempts = 0;
  let waitedMs = 0;

  const remainingBudget = () => {
    if (!budgetPath) return Math.max(0, policy.totalBudgetMs - (now() - startedAt));
    const state = readBusyBudget(budgetPath, now(), policy);
    return Math.max(0, policy.totalBudgetMs - state.spentMs);
  };
  const charge = (ms) => {
    if (budgetPath) chargeBusyBudget(budgetPath, now(), ms, policy);
  };

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    attempts = attempt;
    const attemptStart = now();
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const elapsed = now() - attemptStart;
      const remaining = remainingBudget() - elapsed;
      if (retryOnNetwork && attempt < policy.maxAttempts && remaining > 0) {
        const delay = Math.min(backoffDelay(attempt, { random, policy }), remaining);
        await sleepImpl(delay);
        waitedMs += elapsed + delay;
        charge(elapsed + delay);
        continue;
      }
      throw withAttempts(new Error(safeError(error)), attempt);
    }

    let body = null;
    let parseFailed = false;
    try { body = text ? JSON.parse(text) : null; } catch { parseFailed = true; }

    if (isBusyResponse(response, body)) {
      const elapsed = now() - attemptStart;
      const remaining = remainingBudget() - elapsed;
      if (attempt < policy.maxAttempts && remaining > 0) {
        const delay = Math.min(backoffDelay(attempt, { random, policy }), remaining);
        await sleepImpl(delay);
        waitedMs += elapsed + delay;
        charge(elapsed + delay);
        continue;
      }
      waitedMs += elapsed;
      charge(elapsed);
      appendLog(logFile, `${new Date(now()).toISOString()} kind=${kind} attempts=${attempts} result=${BUSY_EXHAUSTED_MARKER} waitedMs=${waitedMs} error=busy`);
      return { ok: false, busyExhausted: true, attempts, waitedMs, error: 'busy' };
    }

    if (!response.ok) throw withAttempts(new Error(`fleet sheet HTTP ${response.status}`), attempt);
    if (parseFailed) throw withAttempts(new Error('fleet sheet returned invalid JSON'), attempt);
    if (!body || body.ok !== true) {
      throw withAttempts(new Error(`fleet sheet rejected request: ${redactAll(String(body?.error ?? 'unknown error'))}`), attempt);
    }
    appendLog(logFile, `${new Date(now()).toISOString()} kind=${kind} attempts=${attempt} result=ok error=-`);
    return { ok: true, attempts, body };
  }

  // maxAttempts が 0 以下など、ループに入らなかった場合。
  return { ok: false, busyExhausted: true, attempts, waitedMs, error: 'busy' };
}

export function formatBusyExhausted(result, kind) {
  return `${BUSY_EXHAUSTED_MARKER} kind=${kind} attempts=${result?.attempts ?? 0} waitedMs=${result?.waitedMs ?? 0}`;
}
