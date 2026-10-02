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
  return /You(?:'ve| have) hit your usage limit/i.test(String(text || ''));
}

export function writeCodexCooldownFile(file, until, now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ until, reason: 'usage_limit', t: now })}\n`, 'utf8');
}

export function readCodexCooldownUntil(file, now = Date.now()) {
  const until = Number(readJson(file, null)?.until);
  return Number.isFinite(until) && until > now ? until : 0;
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
  if (cooldownUntil) return { deferred: true, reason: 'codex_cooldown', retryAt: cooldownUntil };
  if (origin === 'unattended') {
    const budget = loadBudget(claudeFile(home, 'executor-budget.json'));
    const limit = Number(budget.codex.unattendedPerDay);
    const used = countUnattendedToday(claudeFile(home, 'executor-usage.jsonl'), 'codex', now);
    if (Number.isFinite(limit) && used >= limit) return { deferred: true, reason: 'unattended_budget', retryAt: nextLocalMidnight(now), used, limit };
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
