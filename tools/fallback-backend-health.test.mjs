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

test('skipCoolingBackends は冷却中を除き、全滅する場合は元の配列を返す', () => {
  const backends = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const kept = skipCoolingBackends(backends, new Set(['b']));
  assert.deepEqual(kept.map((x) => x.name), ['a', 'c']);
  // keepAtLeastOne により、全部冷却中でも候補ゼロにせず元の配列をそのまま返す
  const all = skipCoolingBackends(backends, new Set(['a', 'b', 'c']));
  assert.equal(all, backends);
  assert.deepEqual(all.map((x) => x.name), ['a', 'b', 'c']);
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
