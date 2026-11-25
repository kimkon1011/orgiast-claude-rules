// 実行レーン(Codex / GLM)の「保留」判定。I/O は引数のファイルパスだけで、時刻も注入できる。
// 上限に当たった・無人枠を使い切った場合に、失敗ではなく deferred(終了コード 75)として返すための部品。
import fs from 'node:fs';
import path from 'node:path';
import { providerResetUntil } from '../codex-cooldown.mjs';

export const EX_TEMPFAIL = 75;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BUDGET = { codex: { unattendedPerDay: 8 }, glm: { unattendedPerDay: 20 } };

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export function claudeFile(home, name) { return path.join(home, '.claude', name); }

// "You've hit your usage limit ... try again at Oct 4th, 2026 3:12 AM" を検出して再開時刻(epoch ms)を返す。
// 時刻はPCローカル扱い。解析できなければ24時間後。
export function parseUsageLimitUntil(text, now = Date.now()) {
  return providerResetUntil(text, now, DAY_MS);
}

export function isUsageLimitText(text) {
  return /You(?:['’]ve| have) hit your usage limit/i.test(String(text || ''));
}

export const CODEX_GATE_MAX_COOLDOWN_MS = 5 * 60 * 60 * 1000;
export const CODEX_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// codex-cooldown.json は decideCodexGate が「Codex を起動しない」判断にだけ使う。
// 遠い until をそのまま書くと、枠が回復しても再試行されず、レーンが無音で死ぬ
// (2026-10-11〜14: 週次リセットの 90.5 時間が入り、Codex 本体は健全なのに
// 3 日間 fallback:gemini-cli を選び続けた)。上限を 5 時間に切り、
// 少なくとも 5 時間ごとに 1 回は再probeできるようにする。
export function writeCodexCooldownFile(file, until, now = Date.now()) {
  const requested = Number(until);
  const capped = !Number.isFinite(requested) || requested - now > CODEX_GATE_MAX_COOLDOWN_MS;
  const savedUntil = capped ? now + CODEX_GATE_MAX_COOLDOWN_MS : requested;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ until: savedUntil, reason: capped ? 'usage_limit:capped' : 'usage_limit', t: now })}\n`, 'utf8');
}

// codex-cooldown.json には2つの形がある。
//   { codex: { until, reason, at } } … writeCodexCooldown()(tools/codex-cooldown.mjs)が書く形
//   { until, reason, t }             … writeCodexCooldownFile() が書く旧形式
// トップレベルの until しか読まないと、codex-do が自分で書いたクールダウンを一度も尊重しない
// (2026-10-17 実測)。両方を読み、未来のうち最も遅い until を返す。
export function readCodexCooldownUntil(file, now = Date.now()) {
  const state = readJson(file, null);
  const candidates = [Number(state?.codex?.until), Number(state?.until)].filter((value) => Number.isFinite(value));
  if (candidates.length === 0) return 0;
  const until = Math.max(...candidates);
  return until > now ? until : 0;
}

// provider-limit-history.jsonl(provider, until, reason)の最新行で、until が未来の provider は候補から外す。
export function providerLimitedUntil(historyFile, provider, now = Date.now()) {
  let latest = 0;
  try {
    for (const line of fs.readFileSync(historyFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (String(row?.provider || '').toLowerCase() !== String(provider).toLowerCase()) continue;
      const until = Number(row.until);
      if (Number.isFinite(until) && until > latest) latest = until;
    }
  } catch {}
  return latest > now ? latest : 0;
}

// 無ければ既定で作る。あれば尊重(足りないキーだけ既定で補う)。
export function loadBudget(file) {
  const existing = readJson(file, null);
  if (!existing || typeof existing !== 'object') {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(DEFAULT_BUDGET, null, 2)}\n`, 'utf8'); } catch {}
    return structuredClone(DEFAULT_BUDGET);
  }
  const pick = (name) => ({ ...DEFAULT_BUDGET[name], ...(existing[name] && typeof existing[name] === 'object' ? existing[name] : {}) });
  return { ...existing, codex: pick('codex'), glm: pick('glm') };
}

export function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 当日(ローカル日付)の origin=unattended の呼び出し数。deferred 行は数えない。
export function countUnattendedToday(ledgerFile, provider = 'codex', now = Date.now()) {
  const today = localDateKey(now);
  let count = 0;
  try {
    for (const line of fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.provider !== provider || row?.origin !== 'unattended' || row?.status === 'deferred') continue;
      const t = Date.parse(row.t);
      if (Number.isFinite(t) && localDateKey(t) === today) count++;
    }
  } catch {}
  return count;
}

export function nextLocalMidnight(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

// Codex を起動してよいか。deferred なら { deferred:true, reason, retryAt }。
export function decideCodexGate({ home, origin = 'interactive', now = Date.now() }) {
  const cooldownUntil = readCodexCooldownUntil(claudeFile(home, 'codex-cooldown.json'), now);
  const recheckFile = claudeFile(home, 'codex-cooldown-recheck.json');
  const lastRecheck = Number(readJson(recheckFile, null)?.at);
  const recheck = cooldownUntil - now > CODEX_GATE_MAX_COOLDOWN_MS
    && (!Number.isFinite(lastRecheck) || now - lastRecheck >= CODEX_RECHECK_INTERVAL_MS);
  if (cooldownUntil && !recheck) return { deferred: true, reason: 'codex_cooldown', retryAt: cooldownUntil };
  if (origin === 'unattended') {
    const budget = loadBudget(claudeFile(home, 'executor-budget.json'));
    const limit = Number(budget.codex.unattendedPerDay);
    const used = countUnattendedToday(claudeFile(home, 'executor-usage.jsonl'), 'codex', now);
    if (Number.isFinite(limit) && used >= limit) return { deferred: true, reason: 'unattended_budget', retryAt: nextLocalMidnight(now), used, limit };
  }
  if (recheck) {
    // 無人予算で止まった呼び出しは、生存確認を消費しない。
    fs.mkdirSync(path.dirname(recheckFile), { recursive: true });
    fs.writeFileSync(recheckFile, `${JSON.stringify({ at: now })}\n`, 'utf8');
    return { deferred: false, recheck: true };
  }
  return { deferred: false };
}

export function budgetSummary({ home, now = Date.now() }) {
  const budget = loadBudget(claudeFile(home, 'executor-budget.json'));
  const ledger = claudeFile(home, 'executor-usage.jsonl');
  const row = (name) => {
    const limit = Number(budget[name].unattendedPerDay);
    const used = countUnattendedToday(ledger, name, now);
    return { limit, used, remaining: Math.max(0, limit - used) };
  };
  return { date: localDateKey(now), codex: row('codex'), glm: row('glm') };
}

export function deferredPayload(gate, extra = {}) {
  return { status: 'deferred', reason: gate.reason, retryAt: gate.retryAt, retryAtISO: new Date(gate.retryAt).toISOString(), ...extra };
}

// 呼び出し元用: codex-do の結果(終了コード・stdout)が保留かどうか。保留なら retryAt(ms)を返す。
export function parseDeferred(status, stdout) {
  if (Number(status) !== EX_TEMPFAIL) return null;
  const lines = String(stdout || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o?.status === 'deferred') return { reason: o.reason || 'deferred', retryAt: Number(o.retryAt) || Date.now() + DAY_MS };
    } catch {}
  }
  return { reason: 'deferred', retryAt: Date.now() + DAY_MS };
}
