// Gmail API 呼び出しの共通リトライ関数。
// HTTP 429 / 403(quota超過) / 5xx を指数バックオフで最大4回リトライする。

const RETRY_DELAYS = [5000, 15000, 45000]; // 指数バックオフ 5s, 15s, 45s
const MAX_RETRIES = 4; // 初回 + 3回リトライ
const MAX_WAIT_MS = 90000; // 待ち合計上限 90秒

// リトライ対象のエラーか判定する。
export function isRetryableError(response, bodyText) {
  const status = response.status;
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  if (status === 403) {
    return /rateLimitExceeded|userRateLimitExceeded|Quota exceeded|RATE_LIMIT_EXCEEDED/.test(bodyText);
  }
  return false;
}

// Retry-After ヘッダーから待ち時間（ミリ秒）を取得する。
export function retryAfterMs(response) {
  const val = response.headers?.get?.('Retry-After') || '';
  const sec = parseInt(val, 10);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

// 指数バックオフ + jitter（0〜20%）の待ち時間（ミリ秒）を返す。
export function backoffDelayMs(attempt, { random = Math.random } = {}) {
  const base = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length) - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  const jitter = 1 + random() * 0.2;
  return Math.round(base * jitter);
}

// Gmail API 呼び出しをリトライ付きで実行する。
// 成功時は Response を返す。リトライ不能なエラーまたは最大試行回数超過時は throw する。
// リトライ毎に新しい AbortSignal.timeout(30_000) を使う。
export async function gmailFetchWithRetry(url, options, { fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random, onRetry = () => {} } = {}) {
  let totalWait = 0;
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(30_000);
    const response = await fetchImpl(url, { ...options, signal });
    if (response.ok) return response;
    const body = await response.text().catch(() => '');
    if (!isRetryableError(response, body) || attempt >= MAX_RETRIES - 1) {
      const err = new Error(`Gmail API ${response.status}: ${body.slice(0, 200)}`);
      err.status = response.status;
      err.body = body;
      throw err;
    }
    const delay = retryAfterMs(response) || backoffDelayMs(attempt + 1, { random });
    totalWait += delay;
    if (totalWait > MAX_WAIT_MS) {
      const err = new Error(`Gmail API ${response.status}: ${body.slice(0, 200)}`);
      err.status = response.status;
      err.body = body;
      throw err;
    }
    onRetry(attempt + 1, delay);
    await sleep(delay);
  }
}