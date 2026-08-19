export const FALLBACK_CHAIN = Object.freeze([
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'kimi', model: 'kimi-k3' },
]);

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

export async function callWithFallback({ start, chain = FALLBACK_CHAIN, payloadFor, fetchImpl = fetch, onAttempt, onFailover, sleepImpl = defaultSleep }) {
  const candidates = [];
  const seen = new Set();
  for (const candidate of [start, ...chain].filter(Boolean)) {
    if (seen.has(candidate.provider)) continue;
    seen.add(candidate.provider);
    candidates.push(candidate);
  }

  const failures = [];
  const requests = new Map();
  async function requestAt(index) {
    if (!requests.has(index)) requests.set(index, await payloadFor(candidates[index]));
    return requests.get(index);
  }

  let attempted = 0;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex];
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
          return { response, candidate, failover: candidate.provider !== start.provider };
        }
        detail = (await response.clone().text().catch(() => '')).slice(0, 400);
        lastReason = `HTTP${status}${detail ? `: ${detail}` : ''}`;
      } catch (error) {
        lastReason = `network: ${error?.message || String(error)}`;
      }
      attempted++;
      await onAttempt?.({ candidate, attempt, status: statusName(status), response, reason: lastReason, secs: (Date.now() - began) / 1000, failover: candidate.provider !== start.provider });

      const kind = classifyFailure(status);
      if (kind !== 'retry' || attempt === 2) break;
      const specified = retryAfterMs(response);
      if (specified != null && specified > 60000) break;
      await sleepImpl(specified ?? 1000 * 2 ** attempt);
    }
    const reason = lastReason || 'unknown failure';
    failures.push({ candidate, reason });
    for (let nextIndex = candidateIndex + 1; nextIndex < candidates.length; nextIndex++) {
      if (!await requestAt(nextIndex)) continue;
      await onFailover?.({ from: candidate, to: candidates[nextIndex], reason: reasonForLog(reason) });
      break;
    }
  }

  const summary = failures.length
    ? failures.map(({ candidate, reason }) => `${candidate.provider}:${candidate.model} ${reason}`).join('; ')
    : '利用可能なキーを持つ候補がありません';
  const error = new Error(`全候補が失敗しました: ${summary}`);
  error.failures = failures;
  throw error;
}
