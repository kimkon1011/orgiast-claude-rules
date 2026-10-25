import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  FALLBACK_BACKEND_COOLDOWN_MS,
  fallbackBackendHistoryFile,
  recordFallbackBackendOutcome,
  readFallbackBackendHistory,
  coolingBackendNames,
  coolingBackendLastAt,
  skipCoolingBackends,
} = await import('./fallback-backend-health.mjs');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbh-home-'));
}

test('履歴ファイルが無いとき coolingBackendNames は空 Set（例外を投げない）', () => {
  const home = tmpHome();
  const cooling = coolingBackendNames(home);
  assert.equal(cooling instanceof Set, true);
  assert.equal(cooling.size, 0);
  assert.deepEqual(readFallbackBackendHistory(home), []);
});

test('timeout を記録した backend は冷却に入る', () => {
  const home = tmpHome();
  const now = 1_000_000;
  assert.equal(recordFallbackBackendOutcome(home, { backend: 'cheap-code:deepseek', outcome: 'timeout', now }), true);
  const cooling = coolingBackendNames(home, { now: now + 1000 });
  assert.ok(cooling.has('cheap-code:deepseek'));
});

test('timeout の後に ok が記録されると冷却は解除される（最後の outcome だけを見る）', () => {
  const home = tmpHome();
  const now = 2_000_000;
  recordFallbackBackendOutcome(home, { backend: 'x', outcome: 'timeout', now });
  recordFallbackBackendOutcome(home, { backend: 'x', outcome: 'ok', now: now + 10 });
  const cooling = coolingBackendNames(home, { now: now + 20 });
  assert.equal(cooling.has('x'), false);
});

test('blocked を記録した backend は冷却に入り、その後の ok で解除される', () => {
  const home = tmpHome();
  const now = 3_000_000;
  recordFallbackBackendOutcome(home, { backend: 'gemini-cli', outcome: 'blocked', now });
  assert.ok(coolingBackendNames(home, { now: now + 10 }).has('gemini-cli'));
  recordFallbackBackendOutcome(home, { backend: 'gemini-cli', outcome: 'ok', now: now + 20 });
  assert.equal(coolingBackendNames(home, { now: now + 30 }).has('gemini-cli'), false);
});

test('cooldownMs を過ぎた古い timeout は冷却しない', () => {
  const home = tmpHome();
  const now = 5_000_000;
  recordFallbackBackendOutcome(home, { backend: 'y', outcome: 'timeout', now });
  const within = coolingBackendNames(home, { now: now + FALLBACK_BACKEND_COOLDOWN_MS - 1 });
  assert.ok(within.has('y'));
  const beyond = coolingBackendNames(home, { now: now + FALLBACK_BACKEND_COOLDOWN_MS + 1 });
  assert.equal(beyond.has('y'), false);
});

test('skipCoolingBackends は冷却中を除いた配列を返す', () => {
  const backends = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const kept = skipCoolingBackends(backends, new Map([['b', 1]]));
  assert.deepEqual(kept.map((x) => x.name), ['a', 'c']);
});

test('全員冷却中でも全件は復活させず、最後の失敗が最も古い1件だけを残す', () => {
  // 2026-10-23 実測の再発防止: 3件とも timeout/blocked のあと元の配列を丸ごと返していたため、
  // 冷却が無効化されて gemini-cli 600秒 → cheap-code:deepseek 900秒 を毎回捨てていた。
  const backends = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const kept = skipCoolingBackends(backends, new Map([['a', 300], ['b', 100], ['c', 200]]));
  assert.deepEqual(kept.map((x) => x.name), ['b']);
  assert.equal(kept.length, 1);
});

test('冷却時刻が無い Set でも全員冷却中なら1件だけ残す（全件復活させない）', () => {
  const backends = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const kept = skipCoolingBackends(backends, new Set(['a', 'b', 'c']));
  assert.equal(kept.length, 1);
  assert.deepEqual(kept.map((x) => x.name), ['a']);
});

test('coolingBackendLastAt は冷却中の backend と最後の失敗時刻を返し、ok で消える', () => {
  const home = tmpHome();
  const now = 4_000_000;
  recordFallbackBackendOutcome(home, { backend: 'gemini-cli', outcome: 'timeout', now });
  recordFallbackBackendOutcome(home, { backend: 'cheap-code:deepseek', outcome: 'blocked', now: now + 50 });
  const cooling = coolingBackendLastAt(home, { now: now + 100 });
  assert.equal(cooling.get('gemini-cli'), now);
  assert.equal(cooling.get('cheap-code:deepseek'), now + 50);
  recordFallbackBackendOutcome(home, { backend: 'gemini-cli', outcome: 'ok', now: now + 200 });
  assert.equal(coolingBackendLastAt(home, { now: now + 300 }).has('gemini-cli'), false);
});

test('skipCoolingBackends は除外した backend を1行だけ console.error で報告する', () => {
  const original = console.error;
  const lines = [];
  console.error = (msg) => { lines.push(String(msg)); };
  try {
    skipCoolingBackends([{ name: 'a' }, { name: 'b' }], new Set(['b']));
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[codex-do] fallback backend=b は直近でタイムアウトしたため冷却中としてスキップします');
});

test('backend が空のとき recordFallbackBackendOutcome は false を返しファイルを作らない', () => {
  const home = tmpHome();
  assert.equal(recordFallbackBackendOutcome(home, { backend: '', outcome: 'timeout' }), false);
  assert.equal(recordFallbackBackendOutcome(home, { backend: undefined, outcome: 'timeout' }), false);
  assert.equal(fs.existsSync(fallbackBackendHistoryFile(home)), false);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});
