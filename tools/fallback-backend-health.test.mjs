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
  unhealthyCandidates,
  applyCandidateHealth,
  isQuotaOutcome,
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

test('24h で 5 回以上かつ失敗が過半数、または品質失敗 3 連続で 6 時間だけ止める', () => {
  const home = tmpHome();
  const now = 10_000_000;
  const rate = [];
  for (let i = 0; i < 5; i++) rate.push({ t: now - 1000 + i, backend: 'openrouter-free', outcome: i < 3 ? 'timeout' : 'ok' });
  assert.equal(unhealthyCandidates(rate, { now })[0].reason, 'failure_rate');
  assert.deepEqual(unhealthyCandidates(rate.map((row, i) => ({ ...row, outcome: i < 2 ? 'timeout' : 'ok' })), { now }), []);
  const half = Array.from({ length: 6 }, (_, i) => ({ t: now - i, backend: 'openrouter', outcome: i < 3 ? 'fail' : 'ok' }));
  assert.deepEqual(unhealthyCandidates(half, { now }), []);
  const written = applyCandidateHealth(home, { rows: rate, now, force: true });
  assert.deepEqual(written, ['openrouter-free']);
  const disabled = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'lanes-disabled.json'), 'utf8'));
  assert.equal(disabled['openrouter-free'].until, now + 6 * 60 * 60 * 1000);
  assert.equal(disabled['openrouter-free'].reason, 'failure_rate');
  fs.writeFileSync(path.join(home, '.claude', 'lanes-disabled.json'), JSON.stringify({ gemini: { reason: 'manual' } }));
  const quality = [1, 2, 3].map((i) => ({ t: now - i, backend: 'cheap-code:glm', outcome: 'quality_fail' }));
  quality.push({ t: now, backend: 'gemini', outcome: 'quality_fail' }, { t: now - 1, backend: 'gemini', outcome: 'quality_fail' }, { t: now - 2, backend: 'gemini', outcome: 'quality_fail' });
  applyCandidateHealth(home, { rows: quality, now, force: true });
  const kept = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'lanes-disabled.json'), 'utf8'));
  assert.equal(kept.gemini.reason, 'manual');
  assert.equal(kept.gemini.until, undefined);
  assert.equal(kept['cheap-code:glm'].reason, 'quality_validation');
  assert.equal(kept['cheap-code:glm'].until, now + 6 * 60 * 60 * 1000);
});

// --- isQuotaOutcome ---

test('isQuotaOutcome は 429 を含む文字列を true と判定する', () => {
  assert.equal(isQuotaOutcome('http_429'), true);
  assert.equal(isQuotaOutcome('HTTP 429 Too Many Requests'), true);
  assert.equal(isQuotaOutcome('QUOTA_EXCEEDED'), true);
});

test('isQuotaOutcome は daily_limit を true と判定する', () => {
  assert.equal(isQuotaOutcome('daily_limit'), true);
});

test('isQuotaOutcome は deferred を true と判定する', () => {
  assert.equal(isQuotaOutcome('deferred'), true);
});

test('isQuotaOutcome は cooldown を true と判定する', () => {
  assert.equal(isQuotaOutcome('cooldown'), true);
});

test('isQuotaOutcome は rate limit を含む文字列を true と判定する', () => {
  assert.equal(isQuotaOutcome('rate_limit'), true);
  assert.equal(isQuotaOutcome('rate-limit exceeded'), true);
});

test('isQuotaOutcome は quota を含む文字列を true と判定する', () => {
  assert.equal(isQuotaOutcome('quota_exceeded'), true);
});

test('isQuotaOutcome は usage limit を含む文字列を true と判定する', () => {
  assert.equal(isQuotaOutcome('usage_limit'), true);
  assert.equal(isQuotaOutcome('usage-limit reached'), true);
});

test('isQuotaOutcome は ok / fail / timeout / quality_fail を false と判定する', () => {
  assert.equal(isQuotaOutcome('ok'), false);
  assert.equal(isQuotaOutcome('success'), false);
  assert.equal(isQuotaOutcome('fail'), false);
  assert.equal(isQuotaOutcome('timeout'), false);
  assert.equal(isQuotaOutcome('quality_fail'), false);
  assert.equal(isQuotaOutcome('blocked'), false);
  assert.equal(isQuotaOutcome(''), false);
  assert.equal(isQuotaOutcome(null), false);
  assert.equal(isQuotaOutcome(undefined), false);
});

// --- unhealthyCandidates のクォータ除外 ---

test('http_429 が5件中4件でも failure_rate にならない', () => {
  const now = 10_000_000;
  const rows = [
    { t: now - 1000, backend: 'groq', outcome: 'ok' },
    { t: now - 2000, backend: 'groq', outcome: 'http_429' },
    { t: now - 3000, backend: 'groq', outcome: 'http_429' },
    { t: now - 4000, backend: 'groq', outcome: 'http_429' },
    { t: now - 5000, backend: 'groq', outcome: 'http_429' },
  ];
  assert.deepEqual(unhealthyCandidates(rows, { now }), []);
});

test('timeout/fail が5件中3件なら従来どおり failure_rate になる（回帰）', () => {
  const now = 10_000_000;
  const rows = [
    { t: now - 1000, backend: 'groq', outcome: 'ok' },
    { t: now - 2000, backend: 'groq', outcome: 'ok' },
    { t: now - 3000, backend: 'groq', outcome: 'timeout' },
    { t: now - 4000, backend: 'groq', outcome: 'fail' },
    { t: now - 5000, backend: 'groq', outcome: 'timeout' },
  ];
  const hits = unhealthyCandidates(rows, { now });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, 'failure_rate');
  assert.equal(hits[0].calls, 5);
  assert.equal(hits[0].failures, 3);
});

test('429 を除いた残りで判定される（ok1 + fail1 + http_429×5 → calls 2 なので停止しない）', () => {
  const now = 10_000_000;
  const rows = [
    { t: now - 1000, backend: 'groq', outcome: 'ok' },
    { t: now - 2000, backend: 'groq', outcome: 'fail' },
    { t: now - 3000, backend: 'groq', outcome: 'http_429' },
    { t: now - 4000, backend: 'groq', outcome: 'http_429' },
    { t: now - 5000, backend: 'groq', outcome: 'http_429' },
    { t: now - 6000, backend: 'groq', outcome: 'http_429' },
    { t: now - 7000, backend: 'groq', outcome: 'http_429' },
  ];
  // nonQuota = 2件（ok + fail）→ calls=2 < 5 なので停止しない
  assert.deepEqual(unhealthyCandidates(rows, { now }), []);
});

test('skipCoolingBackends は keepNames で指定した定額レーンは冷却中でも残す', () => {
  const backends = [{ name: 'cursor-agent' }, { name: 'cheap-code:deepseek' }, { name: 'qwen' }];
  const cooling = new Set(['cursor-agent', 'qwen']);
  const kept = skipCoolingBackends(backends, cooling, { keepNames: ['cursor-agent'] });
  assert.deepEqual(kept.map((b) => b.name), ['cursor-agent', 'cheap-code:deepseek']);
});
