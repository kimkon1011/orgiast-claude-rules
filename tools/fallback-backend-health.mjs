// フォールバック backend の健康状態を記録し、直近でタイムアウトまたはポリシー拒否で停滞した backend を
// 一定時間だけチェーンから外す。600 秒を毎回捨ててから死んでいる2番手に落ちる
// 浪費（delegation-health-check の fallback_chain_timeout の元）を止めるのが目的。
// 状態は homeDir/.claude/fallback-backend-history.jsonl に1行 JSON で追記する。
import fs from 'node:fs';
import path from 'node:path';
import { billingFailure } from './lib/lane-real-health.mjs';
import { disableLanesTemporarily, readRestoredAt } from './lib/lane-disabled.mjs';

export const FALLBACK_BACKEND_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6時間

// cheap-code 経由と qwen 直結の deepseek は起動方法だけが異なり、同じ
// OpenRouter / deepseek model を使う。連鎖内スキップ（shouldSkipFallbackBackendAfterTimeout）と
// 冷却（coolingBackendNames）の両方で同一障害ドメインとして扱う。
// 2026-11-26 実測: deepseek が timeout して冷却中なのに cheap-code:deepseek だけ名前が違うため
// 通常予算180秒で再試行され、fallback_chain_timeout 2件/361秒を捨てた。
export function fallbackBackendFailureDomain(backendName) {
  if (backendName === 'cheap-code:deepseek' || backendName === 'deepseek') return 'deepseek-upstream';
  return String(backendName || '');
}

// 履歴に片方しか無くても、ドメイン冷却時にもう片方を Set へ入れるための別名表。
const FAILURE_DOMAIN_MEMBERS = {
  'deepseek-upstream': ['cheap-code:deepseek', 'deepseek'],
};

export function fallbackBackendHistoryFile(homeDir) {
  return path.join(homeDir, '.claude', 'fallback-backend-history.jsonl');
}

// {"t":<epoch ms>, "backend":<string>, "outcome":<string>} を1行追記する。
// backend が空文字/undefined のときは何もせず false を返す。
export function recordFallbackBackendOutcome(homeDir, { backend, outcome, now = Date.now() }) {
  const name = typeof backend === 'string' ? backend.trim() : '';
  if (!name || outcome == null || !String(outcome).trim()) return false;
  const file = fallbackBackendHistoryFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ t: now, backend: name, outcome: String(outcome) })}\n`, 'utf8');
  return true;
}

// jsonl を読み、JSON.parse できた行だけ配列で返す。ファイル無し/壊れた行は無視して [] を返す。
export function readFallbackBackendHistory(homeDir) {
  let text;
  try {
    text = fs.readFileSync(fallbackBackendHistoryFile(homeDir), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // 壊れた行は無視する
    }
  }
  return rows;
}

// 失敗ドメインごとに「最後に記録された outcome」だけを見る。
// それが 'timeout' または 'blocked' で、かつ now - t < cooldownMs なら、同ドメインの全 backend を冷却中とみなす。
// timeout/blocked 以外（ok 等）がドメイン最後なら冷却しない＝復帰させる。
// 名前単位だと deepseek timeout 後に cheap-code:deepseek が通常予算で再試行される（2026-11-26 実測）。
export function coolingBackendNames(homeDir, {
  now = Date.now(),
  cooldownMs = FALLBACK_BACKEND_COOLDOWN_MS,
  failureDomain = fallbackBackendFailureDomain,
} = {}) {
  const lastByName = new Map();
  for (const row of readFallbackBackendHistory(homeDir)) {
    const name = typeof row.backend === 'string' ? row.backend.trim() : '';
    if (!name) continue;
    const t = Number(row.t);
    if (!Number.isFinite(t)) continue;
    // 追記順に走査しているので、後から来た行で上書きすれば「最後の outcome」が残る。
    lastByName.set(name, { t, outcome: String(row.outcome) });
  }
  const lastByDomain = new Map();
  for (const [name, entry] of lastByName) {
    const domain = failureDomain(name);
    const previous = lastByDomain.get(domain);
    if (!previous || entry.t >= previous.t) lastByDomain.set(domain, entry);
  }
  const cooling = new Set();
  for (const [domain, entry] of lastByDomain) {
    if ((entry.outcome === 'timeout' || entry.outcome === 'blocked') && now - entry.t < cooldownMs) {
      for (const [name] of lastByName) {
        if (failureDomain(name) === domain) cooling.add(name);
      }
      for (const member of FAILURE_DOMAIN_MEMBERS[domain] || []) cooling.add(member);
    }
  }
  return cooling;
}

// 冷却中候補を keepAtLeastOne/keepNames で残した場合でも、直近に timeout/blocked した
// backend（と同ドメイン）を先頭へ戻さない。既存 history を再利用し、新しい状態ファイルは作らない。
export function deprioritizeRecentFailures(backends, history, {
  now = Date.now(), cooldownMs = FALLBACK_BACKEND_COOLDOWN_MS,
  failureDomain = fallbackBackendFailureDomain,
} = {}) {
  const list = Array.isArray(backends) ? backends : [];
  const latestByDomain = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const name = String(row?.backend || '').trim();
    const t = Number(row?.t);
    if (!name || !Number.isFinite(t)) continue;
    const domain = failureDomain(name);
    const previous = latestByDomain.get(domain);
    if (!previous || t >= previous.t) latestByDomain.set(domain, { t, outcome: String(row.outcome || '') });
  }
  return [...list].sort((a, b) => {
    const rank = (backend) => {
      const row = latestByDomain.get(failureDomain(String(backend?.name || '')));
      return row && /^(timeout|blocked)$/.test(row.outcome) && now - row.t < cooldownMs ? row.t : -Infinity;
    };
    return rank(a) - rank(b);
  });
}

// backend ごとに直近 windowMs の履歴を集計し、成功率が基準を下回る backend を
// 末尾へ移す（stable partition）。除外はせず配列長は不変。
// history が配列でなければ [] 扱い。
export function deprioritizeUnreliableBackends(backends, history, {
  now = Date.now(),
  windowMs = 7 * 24 * 60 * 60 * 1000,
  minRuns = 10,
  minSuccessRate = 0.4,
} = {}) {
  const list = Array.isArray(backends) ? backends : [];
  const rows = Array.isArray(history) ? history : [];
  const lowReliability = new Set();
  for (const backend of list) {
    const name = backend && backend.name;
    if (!name) continue;
    let runs = 0, ok = 0;
    for (const row of rows) {
      const t = Number(row.t);
      if (!Number.isFinite(t)) continue;
      if (now - t >= windowMs) continue;
      if (String(row.backend).trim() !== name) continue;
      runs++;
      if (row.outcome === 'ok') ok++;
    }
    if (runs >= minRuns && ok / runs < minSuccessRate) {
      lowReliability.add(name);
      console.error(`[codex-do] fallback backend=${name} は直近の成功率が低いため連鎖の後方へ回します (ok=${ok}/${runs})`);
    }
  }
  if (lowReliability.size === 0) return [...list];
  // 全件が低信頼のときは、直近窓の成功率（ok/runs）で降順に安定ソートする。
  // runs<minRuns の backend は成功率不明として元の順位を維持し、低信頼群の前に置く。
  if (lowReliability.size >= list.length) {
    const rateMap = new Map();
    for (const backend of list) {
      const name = backend && backend.name;
      if (!name) continue;
      let runs = 0, ok = 0;
      for (const row of rows) {
        const t = Number(row.t);
        if (!Number.isFinite(t)) continue;
        if (now - t >= windowMs) continue;
        if (String(row.backend).trim() !== name) continue;
        runs++;
        if (row.outcome === 'ok') ok++;
      }
      rateMap.set(name, { runs, ok, rate: runs >= minRuns ? ok / runs : -1 });
    }
    const sorted = [...list].sort((a, b) => {
      const ra = rateMap.get(a?.name) || { runs: 0, ok: 0, rate: -1 };
      const rb = rateMap.get(b?.name) || { runs: 0, ok: 0, rate: -1 };
      // 成功率不明（runs<minRuns）は元の順位を維持（sort は安定なので同値比較で元の順序が保たれる）
      if (ra.rate < 0 && rb.rate < 0) return 0;
      if (ra.rate < 0) return -1;
      if (rb.rate < 0) return 1;
      return rb.rate - ra.rate;
    });
    return sorted;
  }
  const reliable = [], unreliable = [];
  for (const backend of list) {
    if (lowReliability.has(backend?.name)) {
      unreliable.push(backend);
    } else {
      reliable.push(backend);
    }
  }
  return [...reliable, ...unreliable];
}

// 回数制限・枠切れの outcome かどうかを判定する。大文字小文字を区別しない。
export function isQuotaOutcome(outcome) {
  return /429|rate.?limit|quota|usage.?limit|^deferred$|^cooldown$|daily_limit/i.test(String(outcome ?? ''));
}

// 24h で 5 回以上かつ失敗が過半数、または品質検証の失敗が 3 連続なら一時停止の対象。
// 結果不明・回数制限・残高切れは failure_rate の分母・分子から除外する。
// restoredAt（lane-doctor --probe が復帰させた時刻。lanes-restored.json）より前の行は
// 「復帰前の古い失敗」として数えない。復帰直後に24h窓の古い失敗で再停止するのを防ぐ（2026-11-28 05:08 実測）。
export function unhealthyCandidates(rows, { now = Date.now(), windowMs = 24 * 60 * 60 * 1000, restoredAt = {} } = {}) {
  const restored = restoredAt && typeof restoredAt === 'object' && !Array.isArray(restoredAt) ? restoredAt : {};
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.backend || row?.name || row?.provider || '').trim();
    const outcome = String(row?.outcome || row?.status || '').trim();
    if (!name || !outcome || /^(?:undefined|null)$/i.test(outcome)) continue;
    const t = typeof row.t === 'number' ? row.t : Date.parse(row.t);
    if (!Number.isFinite(t) || t < now - windowMs || t > now) continue;
    const cutoff = restored[name.toLowerCase()];
    if (Number.isFinite(cutoff) && t < cutoff) continue;
    const list = groups.get(name) || [];
    list.push({ t, outcome });
    groups.set(name, list);
  }
  const hits = [];
  for (const [name, list] of groups) {
    list.sort((a, b) => a.t - b.t);
    const measured = list.filter((row) => !isQuotaOutcome(row.outcome) && !billingFailure(row.outcome));
    const failures = measured.filter((row) => row.outcome !== 'ok' && row.outcome !== 'success');
    if (measured.length >= 5 && failures.length / measured.length > 0.5) {
      hits.push({ name, reason: 'failure_rate', calls: measured.length, failures: failures.length });
      continue;
    }
    const tail = list.slice(-3);
    if (tail.length === 3 && tail.every((row) => row.outcome === 'quality_fail')) hits.push({ name, reason: 'quality_validation', calls: list.length, failures: 3 });
  }
  return hits;
}

export function applyCandidateHealth(homeDir, { rows, now = Date.now(), force = false } = {}) {
  if (!force && process.env.NODE_TEST_CONTEXT) return [];
  const source = Array.isArray(rows) ? rows : readFallbackBackendHistory(homeDir);
  return disableLanesTemporarily(homeDir, unhealthyCandidates(source, { now, restoredAt: readRestoredAt(homeDir) }), now);
}

// name が cooling に含まれる backend を除いた配列を返す。
// keepAtLeastOne が true（既定）で除外した結果が空になる場合は、元の配列をそのまま返す
// （＝候補ゼロで詰むのを防ぐ）。除外した backend は1件につき1行 console.error で出す。
export function skipCoolingBackends(backends, cooling, { keepAtLeastOne = true, keepNames = [] } = {}) {
  const list = Array.isArray(backends) ? backends : [];
  const names = cooling instanceof Set ? cooling : new Set(cooling || []);
  const keep = new Set(keepNames || []);
  const kept = [];
  for (const backend of list) {
    const name = backend && backend.name;
    if (names.has(name) && !keep.has(name)) {
      console.error(`[codex-do] fallback backend=${name} は直近でタイムアウトしたため冷却中としてスキップします`);
      continue;
    }
    if (names.has(name) && keep.has(name)) {
      console.error(`[codex-do] fallback backend=${name} は冷却中ですが定額レーンのため候補に残します`);
    }
    kept.push(backend);
  }
  if (keepAtLeastOne && kept.length === 0 && list.length > 0) return list;
  return kept;
}
