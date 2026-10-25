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
// それが 'timeout' または 'blocked' で、かつ now - t < cooldownMs なら冷却中とみなす。
// timeout/blocked 以外（ok 等）が最後なら冷却しない＝復帰させる。
// 戻り値は 名前 → 最後に失敗した時刻(epoch ms) の Map（失敗時刻が古い順の選別に使う）。
export function coolingBackendLastAt(homeDir, { now = Date.now(), cooldownMs = FALLBACK_BACKEND_COOLDOWN_MS } = {}) {
  const last = new Map();
  for (const row of readFallbackBackendHistory(homeDir)) {
    const name = typeof row.backend === 'string' ? row.backend.trim() : '';
    if (!name) continue;
    const t = Number(row.t);
    if (!Number.isFinite(t)) continue;
    // 追記順に走査しているので、後から来た行で上書きすれば「最後の outcome」が残る。
    last.set(name, { t, outcome: String(row.outcome) });
  }
  const cooling = new Map();
  for (const [name, entry] of last) {
    if ((entry.outcome === 'timeout' || entry.outcome === 'blocked') && now - entry.t < cooldownMs) cooling.set(name, entry.t);
  }
  return cooling;
}

export function coolingBackendNames(homeDir, options = {}) {
  return new Set(coolingBackendLastAt(homeDir, options).keys());
}

// name が cooling に含まれる backend を除いた配列を返す。
// 除外した backend は1件につき1行 console.error で出す。
//
// keepAtLeastOne が true（既定）で全員が冷却中になったときは「1件だけ」を残す。
// 以前は元の配列をそのまま返していたが、それだと冷却が丸ごと無効になり、
// 直近で全滅した3バックエンドを毎回最初から全部やり直して1回30分を捨てていた
// （2026-10-23 実測: 04:23 に3件とも timeout/blocked を記録した後も 05:16〜10:43 の
//   各連鎖が gemini-cli 600秒 → cheap-code:deepseek 900秒 を繰り返し、8件/8022秒を浪費）。
// 残す1件は「最後の失敗が最も古い＝冷却明けが最も近い」backend とする。
// 冷却時刻が分からない Set しか無いときは順序先頭を1件だけ残す（全員は復活させない）。
export function skipCoolingBackends(backends, cooling, { keepAtLeastOne = true } = {}) {
  const list = Array.isArray(backends) ? backends : [];
  const lastAt = cooling instanceof Map ? cooling : null;
  const names = lastAt ? new Set(lastAt.keys()) : new Set(cooling || []);
  const kept = [];
  const skipped = [];
  for (const backend of list) {
    const name = backend && backend.name;
    if (names.has(name)) {
      skipped.push(name);
      continue;
    }
    kept.push(backend);
  }
  for (const name of skipped) {
    console.error(`[codex-do] fallback backend=${name} は直近でタイムアウトしたため冷却中としてスキップします`);
  }
  if (kept.length) return kept;
  if (!keepAtLeastOne || list.length === 0) return kept;
  // 全員冷却中: 冷却明けが最も近い1件だけを試す。
  let pick = list[0];
  if (lastAt) {
    let oldest = Infinity;
    for (const backend of list) {
      const t = lastAt.get(backend && backend.name);
      if (Number.isFinite(t) && t < oldest) {
        oldest = t;
        pick = backend;
      }
    }
  }
  console.error(`[codex-do] fallback backend は全て冷却中です。冷却明けが最も近い ${pick && pick.name} の1件だけを試します`);
  return [pick];
}
