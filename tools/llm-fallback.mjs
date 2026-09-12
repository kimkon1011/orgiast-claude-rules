import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FALLBACK_CHAIN = Object.freeze([
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  // 無料の Groq、定額の GLM、以降の従量プロバイダの順で費用を抑える。
  { provider: 'glm', model: 'glm-5.3' },
  { provider: 'cerebras', model: 'zai-glm-4.7' },
  // Genspark Pro は前払いクレジットなので従量課金プロバイダより先に使う。
  { provider: 'genspark', model: 'gpt-5.6-luna' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'grok', model: 'grok-3' },
  { provider: 'kimi', model: 'kimi-k3' },
]);

export const COST_PER_MILLION = Object.freeze({
  groq: [0.15, 0.60], openrouter: [0.59, 0.79], gemini: [0.75, 3.75], deepseek: [0.27, 1.10],
  grok: [3, 15], kimi: [3, 15], mistral: [2, 6], cerebras: [0, 0], codex: [0, 0],
});

export const KNOWN_CHEAP_PROVIDERS = Object.freeze([
  'groq', 'glm', 'cerebras', 'deepseek', 'openrouter', 'gemini', 'gemini-cli',
  'grok', 'kimi', 'mistral', 'ollama', 'codex', 'qwen-code', 'genspark',
]);

const ROUTING_TABLE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routing-table.json');

// eval 実測のルーティング表(tools/routing-table.json)から、指定カテゴリで最安の候補を返す。
// 表が無い・カテゴリが無い・暫定計測(provisional)のどれでも null を返し、既定の連鎖を使わせる。
export function preferredForCategory(category) {
  const name = String(category || '').trim().toLowerCase();
  if (!name) return null;
  try {
    const table = JSON.parse(fs.readFileSync(ROUTING_TABLE, 'utf8'));
    const entry = table?.categories?.[name];
    if (!entry || !entry.provider) return null;
    return { provider: entry.provider, model: entry.model, ...(entry.provisional ? { provisional: true } : {}) };
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function localDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dailyCost(file, timestamp) {
  try {
    const day = localDay(timestamp);
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).reduce((total, line) => {
      if (!line.trim()) return total;
      let record;
      try { record = JSON.parse(line); } catch { return total; }
      if (localDay(record.t) !== day) return total;
      const rates = COST_PER_MILLION[record.provider];
      return rates ? total + ((Number(record.in) || 0) * rates[0] + (Number(record.out) || 0) * rates[1]) / 1_000_000 : total;
    }, 0);
  } catch { return 0; }
}

function threshold(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function classifyFailure(status) {
  if (status == null || status === 429 || (status >= 500 && status <= 599)) return 'retry';
  return 'next';
}

function retryAfterMs(response, now = Date.now()) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function statusName(status) {
  return status == null ? 'network' : `http_${status}`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reasonForLog(reason, maxLength = 140) {
  const singleLine = String(reason || 'unknown failure').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

export async function callWithFallback({ start, chain = FALLBACK_CHAIN, payloadFor, fetchImpl = fetch, onAttempt, onFailover, sleepImpl = defaultSleep, cooldownFile, ledgerFile, now = () => Date.now() }) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const timestamp = now();
  const cost = dailyCost(ledgerFile || path.join(home, '.claude', 'executor-usage.jsonl'), timestamp);
  const warn = threshold('ORGIAST_LLM_DAILY_WARN_USD', 1);
  const hard = threshold('ORGIAST_LLM_DAILY_HARD_USD', 5);
  if (cost > hard) throw new Error(`本日の従量上限 $${hard.toFixed(2)} に達したため停止しました（概算 $${cost.toFixed(2)}）。ORGIAST_LLM_DAILY_HARD_USD で変更可`);
  if (cost > warn) console.error(`[cost] 本日の安いAI実行者 概算 $${cost.toFixed(2)} が警告値 $${warn.toFixed(2)} を超過`);

  const candidates = [];
  const seen = new Set();
  const deepseekGateway = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };
  const expanded = start?.provider === 'deepseek' ? [start, deepseekGateway, ...chain] : [start, ...chain];
  for (const candidate of expanded.filter(Boolean)) {
    if (seen.has(candidate.provider)) continue;
    seen.add(candidate.provider);
    candidates.push(candidate);
  }

  // routing-overrides.json の demote 有効期限が切れるまで、該当 provider を連鎖の末尾へ回す
  // (cost-improve-loop が provider_unhealthy を検出した時に書く。B4 2026-09-07)。
  // start として明示された provider は呼び出し元の意思なので先頭のまま。
  // cooldown と同じく node --test 配下では実環境のファイルを読まない。
  let demotedProviders = [];
  if (cooldownFile != null || !process.env.NODE_TEST_CONTEXT) {
    const overridesPath = cooldownFile
      ? path.join(path.dirname(cooldownFile), 'routing-overrides.json')
      : path.join(home, '.claude', 'routing-overrides.json');
    try {
      const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
      demotedProviders = Object.entries(overrides?.demote || {})
        .filter(([, until]) => Number(Date.parse(until)) > timestamp)
        .map(([provider]) => String(provider).toLowerCase());
    } catch {}
  }
  if (demotedProviders.length) {
    const rank = (candidate) => (demotedProviders.includes(candidate.provider) && candidate.provider !== start.provider ? 1 : 0);
    candidates.sort((a, b) => rank(a) - rank(b)); // Array#sort は安定なので同 rank 内の元順を保つ
    for (const provider of demotedProviders) {
      if (provider !== start.provider) console.error(`[routing] ${provider} はdemote中のため連鎖の末尾へ回します`);
    }
  }

  // node --test 配下では、呼び出し側が隔離先を明示した場合だけ永続化する。
  // 将来テストが cooldownFile を渡し忘れても実環境の受け皿を止めないための多重防御。
  const useCooldown = chain.length > 0 && (cooldownFile != null || !process.env.NODE_TEST_CONTEXT);
  const cooldownPath = cooldownFile || path.join(home, '.claude', 'provider-cooldown.json');
  const cooldowns = useCooldown ? readJson(cooldownPath, {}) : {};
  const available = useCooldown ? candidates.filter(({ provider }) => !(Number(cooldowns?.[provider]?.until) > timestamp)) : candidates;
  const selectedCandidates = available.length ? available : candidates;
  if (useCooldown && available.length) {
    for (const candidate of candidates) {
      const state = cooldowns?.[candidate.provider];
      if (Number(state?.until) <= timestamp || !state) continue;
      const minutes = Math.max(1, Math.ceil((state.until - timestamp) / 60000));
      console.error(`[cooldown] ${candidate.provider} はスキップ (${state.reason || 'unknown'}, 残り${minutes}分)`);
    }
  }

  let cooldownDirty = false;
  function setCooldown(provider, status, response) {
    if (!useCooldown) return;
    let duration = 0;
    if (status === 402) duration = 24 * 60 * 60 * 1000;
    else if ([401, 403].includes(status)) duration = 6 * 60 * 60 * 1000;
    else if (status === 429) duration = retryAfterMs(response, timestamp) ?? 30 * 60 * 1000;
    if (!duration) return;
    cooldowns[provider] = { until: timestamp + duration, reason: `http_${status}`, at: timestamp };
    cooldownDirty = true;
  }
  function clearCooldown(provider) {
    if (useCooldown && cooldowns?.[provider]) { delete cooldowns[provider]; cooldownDirty = true; }
  }
  function saveCooldowns() {
    if (!cooldownDirty) return;
    try { fs.mkdirSync(path.dirname(cooldownPath), { recursive: true }); fs.writeFileSync(cooldownPath, `${JSON.stringify(cooldowns, null, 2)}\n`); } catch {}
  }

  const failures = [];
  const requests = new Map();
  async function requestAt(index) {
    if (!requests.has(index)) requests.set(index, await payloadFor(selectedCandidates[index]));
    return requests.get(index);
  }

  let attempted = 0;
  for (let candidateIndex = 0; candidateIndex < selectedCandidates.length; candidateIndex++) {
    const candidate = selectedCandidates[candidateIndex];
    const request = await requestAt(candidateIndex);
    if (!request) continue;
    let lastReason = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const began = Date.now();
      let response;
      let status;
      let detail = '';
      try {
        response = await fetchImpl(request.url, request.init);
        status = response.status;
        if (response.ok) {
          await onAttempt?.({ candidate, attempt, status: 'ok', response, secs: (Date.now() - began) / 1000, failover: candidate.provider !== start.provider });
          clearCooldown(candidate.provider);
          saveCooldowns();
          return { response, candidate, failover: candidate.provider !== start.provider };
        }
        detail = (await response.clone().text().catch(() => '')).slice(0, 400);
        lastReason = `HTTP${status}${detail ? `: ${detail}` : ''}`;
      } catch (error) {
        lastReason = `network: ${error?.message || String(error)}`;
      }
      attempted++;
      await onAttempt?.({ candidate, attempt, status: statusName(status), response, reason: lastReason, secs: (Date.now() - began) / 1000, failover: candidate.provider !== start.provider });
      setCooldown(candidate.provider, status, response);

      const kind = classifyFailure(status);
      if (kind !== 'retry' || attempt === 2) break;
      const specified = retryAfterMs(response);
      if (specified != null && specified > 60000) break;
      await sleepImpl(specified ?? 1000 * 2 ** attempt);
    }
    const reason = lastReason || 'unknown failure';
    failures.push({ candidate, reason });
    for (let nextIndex = candidateIndex + 1; nextIndex < selectedCandidates.length; nextIndex++) {
      if (!await requestAt(nextIndex)) continue;
      await onFailover?.({ from: candidate, to: selectedCandidates[nextIndex], reason: reasonForLog(reason) });
      break;
    }
  }

  const summary = failures.length
    ? failures.map(({ candidate, reason }) => `${candidate.provider}:${candidate.model} ${reason}`).join('; ')
    : '利用可能なキーを持つ候補がありません';
  const error = new Error(`全候補が失敗しました: ${summary}`);
  error.failures = failures;
  saveCooldowns();
  throw error;
}
