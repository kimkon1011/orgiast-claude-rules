// フォールバック backend の健康状態を記録し、直近でタイムアウトまたはポリシー拒否で停滞した backend を
// 一定時間だけチェーンから外す。600 秒を毎回捨ててから死んでいる2番手に落ちる
// 浪費（delegation-health-check の fallback_chain_timeout の元）を止めるのが目的。
// 状態は homeDir/.claude/fallback-backend-history.jsonl に1行 JSON で追記する。
import fs from 'node:fs';
import path from 'node:path';

export const FALLBACK_BACKEND_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6時間

export function fallbackBackendHistoryFile(homeDir) {
  return path.join(homeDir, '.claude', 'fallback-backend-history.jsonl');
}

// {"t":<epoch ms>, "backend":<string>, "outcome":<string>} を1行追記する。
// backend が空文字/undefined のときは何もせず false を返す。
export function recordFallbackBackendOutcome(homeDir, { backend, outcome, now = Date.now() }) {
  const name = typeof backend === 'string' ? backend.trim() : '';
  if (!name) return false;
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

// backend ごとに「最後に記録された outcome」だけを見る。
// それが 'timeout' または 'blocked' で、かつ now - t < cooldownMs なら冷却中とみなして Set に入れる。
// timeout/blocked 以外（ok 等）が最後なら冷却しない＝復帰させる。
export function coolingBackendNames(homeDir, { now = Date.now(), cooldownMs = FALLBACK_BACKEND_COOLDOWN_MS } = {}) {
  const last = new Map();
  for (const row of readFallbackBackendHistory(homeDir)) {
    const name = typeof row.backend === 'string' ? row.backend.trim() : '';
    if (!name) continue;
    const t = Number(row.t);
    if (!Number.isFinite(t)) continue;
    // 追記順に走査しているので、後から来た行で上書きすれば「最後の outcome」が残る。
    last.set(name, { t, outcome: String(row.outcome) });
  }
  const cooling = new Set();
  for (const [name, entry] of last) {
    if ((entry.outcome === 'timeout' || entry.outcome === 'blocked') && now - entry.t < cooldownMs) cooling.add(name);
  }
  return cooling;
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
  if (lowReliability.size === 0 || lowReliability.size >= list.length) return [...list];
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

// name が cooling に含まれる backend を除いた配列を返す。
// keepAtLeastOne が true（既定）で除外した結果が空になる場合は、元の配列をそのまま返す
// （＝候補ゼロで詰むのを防ぐ）。除外した backend は1件につき1行 console.error で出す。
export function skipCoolingBackends(backends, cooling, { keepAtLeastOne = true } = {}) {
  const list = Array.isArray(backends) ? backends : [];
  const names = cooling instanceof Set ? cooling : new Set(cooling || []);
  const kept = [];
  for (const backend of list) {
    const name = backend && backend.name;
    if (names.has(name)) {
      console.error(`[codex-do] fallback backend=${name} は直近でタイムアウトしたため冷却中としてスキップします`);
      continue;
    }
    kept.push(backend);
  }
  if (keepAtLeastOne && kept.length === 0 && list.length > 0) return list;
  return kept;
}
