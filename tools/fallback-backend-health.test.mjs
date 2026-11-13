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
  deprioritizeUnreliableBackends,
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

test('deprioritizeUnreliableBackends: gemini-cli(3/15) と cheap-code:deepseek(17/24) で低成功率の gemini が末尾へ移る', () => {
  const now = 1_000_000_000;
  const history = [];
  for (let i = 0; i < 15; i++) {
    history.push({ t: now - 3600 * 1000, backend: 'gemini-cli', outcome: i < 3 ? 'ok' : 'timeout' });
  }
  for (let i = 0; i < 24; i++) {
    history.push({ t: now - 3600 * 1000, backend: 'cheap-code:deepseek', outcome: i < 17 ? 'ok' : 'timeout' });
  }
  const backends = [{ name: 'gemini-cli' }, { name: 'cheap-code:deepseek' }, { name: 'openrouter-free' }];
  const result = deprioritizeUnreliableBackends(backends, history, { now, windowMs: 7 * 24 * 3600 * 1000, minRuns: 10, minSuccessRate: 0.4 });
  assert.deepEqual(result.map((b) => b.name), ['cheap-code:deepseek', 'openrouter-free', 'gemini-cli']);
  assert.equal(result.length, 3);
});

test('deprioritizeUnreliableBackends: runs<minRuns (9回で全部timeout) なら順序不変', () => {
  const now = 1_000_000_000;
  const history = [];
  for (let i = 0; i < 9; i++) {
    history.push({ t: now - 3600 * 1000, backend: 'gemini-cli', outcome: 'timeout' });
  }
  const backends = [{ name: 'gemini-cli' }, { name: 'cheap-code:deepseek' }];
  const result = deprioritizeUnreliableBackends(backends, history, { now, windowMs: 7 * 24 * 3600 * 1000, minRuns: 10, minSuccessRate: 0.4 });
  assert.deepEqual(result.map((b) => b.name), ['gemini-cli', 'cheap-code:deepseek']);
});

test('deprioritizeUnreliableBackends: windowMs より古い行は数えない', () => {
  const now = 1_000_000_000;
  // 14日前→古くてカウントされないはず
  const history = [
    { t: now - 14 * 24 * 3600 * 1000, backend: 'gemini-cli', outcome: 'ok' },
    { t: now - 14 * 24 * 3600 * 1000, backend: 'gemini-cli', outcome: 'timeout' },
  ];
  // 10日前→window 7日なので古い
  const backends = [{ name: 'gemini-cli' }, { name: 'openrouter-free' }];
  const result = deprioritizeUnreliableBackends(backends, history, { now, windowMs: 7 * 24 * 3600 * 1000, minRuns: 10, minSuccessRate: 0.4 });
  // runs=2 < minRuns=10 かつ古いので順序不変
  assert.deepEqual(result.map((b) => b.name), ['gemini-cli', 'openrouter-free']);
});

test('deprioritizeUnreliableBackends: 全 backend が低成功率でも成功率順に並ぶ（a=0/11, b=3/11）', () => {
  const now = 1_000_000_000;
  const history = [
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'ok' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'ok' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'ok' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' },
  ];
  const backends = [{ name: 'a' }, { name: 'b' }];
  const result = deprioritizeUnreliableBackends(backends, history, { now, windowMs: 7 * 24 * 3600 * 1000, minRuns: 10, minSuccessRate: 0.4 });
  // b は 3/11=27%、a は 0/11=0%。b の方が成功率が高いので先に来る
  assert.deepEqual(result.map((b) => b.name), ['b', 'a']);
});

test('deprioritizeUnreliableBackends: 全件低信頼でも runs<minRuns は成功率不明として低信頼群の前に置く', () => {
  const now = 1_000_000_000;
  const history = [
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'a', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
    { t: now - 3600 * 1000, backend: 'c', outcome: 'timeout' },
  ];
  // b は runs=5 < minRuns=10 → 成功率不明
  for (let i = 0; i < 5; i++) {
    history.push({ t: now - 3600 * 1000, backend: 'b', outcome: 'timeout' });
  }
  const backends = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const result = deprioritizeUnreliableBackends(backends, history, { now, windowMs: 7 * 24 * 3600 * 1000, minRuns: 10, minSuccessRate: 0.4 });
  // b は成功率不明なので先頭、a(0/11) と c(0/11) は同率→安定ソートで元の順序
  assert.deepEqual(result.map((b) => b.name), ['b', 'a', 'c']);
});

test('deprioritizeUnreliableBackends: 入力配列を破壊しない', () => {
  const now = 1_000_000_000;
  const history = [];
  for (let i = 0; i < 15; i++) {
    history.push({ t: now - 3600 * 1000, backend: 'gemini-cli', outcome: i < 3 ? 'ok' : 'timeout' });
  }
  const original = [{ name: 'gemini-cli' }, { name: 'cheap-code:deepseek' }];
  const copy = [...original];
  const result = deprioritizeUnreliableBackends(original, history, { now, windowMs: 7 * 24 * 3600 * 1000, minRuns: 10, minSuccessRate: 0.4 });
  assert.deepEqual(original.map((b) => b.name), copy.map((b) => b.name), '入力配列は変更されていない');
  assert.notEqual(result, original, '新しい配列を返している');
});
