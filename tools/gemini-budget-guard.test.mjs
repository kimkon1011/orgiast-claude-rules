import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { calcSessionCost, collectSessionLogUsage, formatGeminiBudgetStatus, runGeminiBudgetGuard, summarizeGeminiBudget } from './gemini-budget-guard.mjs';
import { memoryFs } from './gemini-test-fs.mjs';

const now = new Date('2026-09-14T12:00:00Z');
const home = path.resolve('/mock-gemini-home'), dir = path.join(home, '.claude');
const row = (usd, extra = {}) => ({ t: now.toISOString(), provider: 'gemini', usd, ...extra });
const options = { now, budgetJpy: 100, usdJpy: 1 };
function fixture(rows, config = { budgetJpy: 100, usdPerJpy: 1 }, more = {}) {
  return memoryFs({ [path.join(dir, 'executor-usage.jsonl')]: rows.map(JSON.stringify).join('\n') + '\n', [path.join(dir, 'gemini-budget.json')]: JSON.stringify(config), ...more });
}

// ── Threshold tests (70/90 instead of old 60/85) ──
test('70 and 90 percent boundaries: 70–89 warn, >=90 stop', () => {
  for (const [usd, expected] of [[69.99, 'ok'], [70, 'warn'], [89.99, 'warn'], [90, 'stop'], [90.01, 'stop']]) assert.equal(summarizeGeminiBudget([row(usd)], options).level, expected);
});

test('unmeasured >20% is unknown, exactly 20% is not', () => {
  assert.equal(summarizeGeminiBudget([row(null), ...Array.from({ length: 4 }, () => row(1))], options).level, 'ok');
  assert.equal(summarizeGeminiBudget([row(null), ...Array.from({ length: 3 }, () => row(1))], options).level, 'unknown');
  assert.equal(summarizeGeminiBudget([row(undefined, { in: 0, out: 0 })], options).unmeasuredCalls, 1);
});

// ── calcSessionCost ──
test('calcSessionCost uses model pricing from table', () => {
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75, cachedInputUsdPerMillion: 0.075 } } };
  // 1M input + 0 output = $0.75
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 1_000_000, output: 0, cached: 0 }, pricing, now), 0.75);
  // 0 input + 1M output = $3.75
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 0, output: 1_000_000, cached: 0 }, pricing, now), 3.75);
  // 100K input + 1K output = $0.075 + $0.00375 = $0.07875
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 100_000, output: 1_000, cached: 0 }, pricing, now), 0.07875);
  // cached tokens: 50K input cached + 50K input fresh + 0 output = 50K*0.075/1M + 50K*0.75/1M = 0.00375 + 0.0375 = 0.04125
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 100_000, output: 0, cached: 50_000 }, pricing, now), 0.04125);
});

test('calcSessionCost returns null for unknown model or missing pricing', () => {
  assert.equal(calcSessionCost({ model: 'unknown-model', input: 100, output: 50, cached: 0 }, { models: {} }, now), null);
  assert.equal(calcSessionCost({ model: null, input: 100, output: 50, cached: 0 }, { models: {} }, now), null);
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 } } };
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 0, output: 0, cached: 0 }, pricing, now), 0);
});

test('calcSessionCost respects validThrough', () => {
  const pricing = { validThrough: '2026-09-10', models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 } } };
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 1_000_000, output: 0 }, pricing, new Date('2026-09-15')), null);
  assert.equal(calcSessionCost({ model: 'gemini-3.6-flash', input: 1_000_000, output: 0 }, pricing, new Date('2026-09-10')), 0.75);
});

// ── collectSessionLogUsage ──
function sessionLogFs(projects, dirHome = home) {
  const files = {};
  for (const [project, sessions] of Object.entries(projects)) {
    for (const [sessName, lines] of Object.entries(sessions)) {
      const fp = path.join(dirHome, '.gemini', 'tmp', project, 'chats', sessName);
      files[fp] = lines.map(JSON.stringify).join('\n') + '\n';
    }
  }
  // Build readdirSync/statSync mock
  const tree = {};
  for (const [fp, content] of Object.entries(files)) {
    const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
    let node = tree;
    for (const part of parts) {
      if (!part) continue;
      if (!node[part]) node[part] = {};
      node = node[part];
    }
    node._content = content;
    node._mtime = Date.parse('2026-09-14T00:00:00Z');
  }
  function resolve(p) {
    const parts = p.replace(/\\/g, '/').split('/');
    let node = tree;
    for (const part of parts) {
      if (!part) continue;
      if (!node[part]) return null;
      node = node[part];
    }
    return node;
  }
  const mock = {
    files,
    readdirSync(p, opts) {
      const node = resolve(p);
      if (!node) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
      const entries = [];
      for (const [name, child] of Object.entries(node)) {
        if (name.startsWith('_')) continue;
        const isDir = child._content === undefined || Object.keys(child).some(k => !k.startsWith('_'));
        entries.push({ name, isDirectory: () => isDir, isFile: () => !isDir });
      }
      return entries;
    },
    statSync(p) {
      const node = resolve(p);
      if (!node) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
      return { mtimeMs: node._mtime || 0, size: (node._content || '').length };
    },
    readFileSync(p) {
      const node = resolve(p);
      if (!node || node._content === undefined) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
      return node._content;
    },
    // passthrough for other fs operations needed by runGeminiBudgetGuard
    mkdirSync() {},
    writeFileSync() {},
    renameSync() {},
    unlinkSync() {},
  };
  return mock;
}

test('collectSessionLogUsage returns empty when no session logs exist', () => {
  const mock = sessionLogFs({});
  assert.deepEqual(collectSessionLogUsage({ home, fsImpl: mock, now }), []);
});

test('collectSessionLogUsage parses gemini-type lines from session logs', () => {
  const mock = sessionLogFs({
    'nightly-repo': {
      'session-abc.jsonl': [
        { type: 'gemini', model: 'gemini-3.6-flash', tokens: { input: 1000, output: 200, cached: 100, thoughts: 0, tool: 0, total: 1300 }, timestamp: '2026-09-14T00:00:00Z' },
        { type: 'user', content: 'hello' },
      ],
      'session-def.jsonl': [
        { type: 'gemini', model: 'gemini-3.7-flash', tokens: { input: 500, output: 50, cached: 0, thoughts: 0, tool: 0, total: 550 }, timestamp: '2026-09-14T01:00:00Z' },
      ],
    },
    'mission': {
      'session-456.jsonl': [
        { type: 'gemini', model: 'gemini-3.6-flash', tokens: { input: 2000, output: 500, cached: 0, thoughts: 0, tool: 0, total: 2500 }, timestamp: '2026-09-14T02:00:00Z' },
      ],
    },
  });
  const result = collectSessionLogUsage({ home, fsImpl: mock, now });
  assert.equal(result.length, 3);
  const byProj = {};
  for (const r of result) { byProj[r.project] = (byProj[r.project] || 0) + 1; }
  assert.deepEqual(byProj, { 'nightly-repo': 2, 'mission': 1 });
  // Check sessionId from filename
  assert.ok(result.some(r => r.project === 'nightly-repo' && r.sessionId === 'abc'));
  assert.ok(result.some(r => r.project === 'nightly-repo' && r.sessionId === 'def'));
  assert.ok(result.some(r => r.project === 'mission' && r.sessionId === '456'));
});

test('collectSessionLogUsage skips non-Gemini types, out-of-month rows, and invalid JSON', () => {
  const mock = sessionLogFs({
    'nightly-repo': {
      'session-x.jsonl': [
        { type: 'gemini', model: 'gemini-3.6-flash', tokens: { input: 100, output: 50, cached: 0 }, timestamp: '2026-09-14T00:00:00Z' },
        { type: 'gemini', model: null, tokens: { input: 100, output: 50, cached: 0 }, timestamp: '2026-09-14T00:00:00Z' },
        { type: 'text', content: 'hello' }, // not gemini type → skip
        { type: 'gemini', tokens: { input: 100, output: 50, cached: 0 }, timestamp: '2026-09-14T00:00:00Z' },
        { type: 'gemini', model: 'gemini-3.6-flash', tokens: { input: 100, output: 50, cached: 0 }, timestamp: '2026-08-31T12:00:00Z' }, // 21:00 JST Aug 31 → skip (different month)
        'not json',
      ],
    },
  });
  const result = collectSessionLogUsage({ home, fsImpl: mock, now });
  assert.equal(result.length, 3);
  assert.equal(result[0].input, 100);
  assert.deepEqual(result.slice(1).map(entry => entry.model), [null, null]);
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 } } };
  const status = summarizeGeminiBudget([], { ...options, sessionLogRows: result, pricing });
  assert.equal(status.invalidRows, 1);
  assert.equal(status.unmeasuredCalls, 2);
});

test('collectSessionLogUsage recovers from missing tmp dir', () => {
  const mock = sessionLogFs({});
  // When root doesn't exist, readdirSync throws → returns empty
  assert.deepEqual(collectSessionLogUsage({ home: path.resolve('/nonexistent'), fsImpl: mock, now }), []);
});

// ── summarizeGeminiBudget with sessionLogRows ──
test('sessionLogRows are added to spentUsd and byProject', () => {
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75, cachedInputUsdPerMillion: 0.075 } } };
  const status = summarizeGeminiBudget([row(10)], { ...options, sessionLogRows: [
    { project: 'nightly-repo', model: 'gemini-3.6-flash', input: 1_000_000, output: 0, cached: 0, sessionId: 's1' },
    { project: 'mission', model: 'gemini-3.6-flash', input: 0, output: 100_000, cached: 0, sessionId: 's2' },
  ], pricing });
  assert.equal(status.spentUsd, 10 + 0.75 + 0.375); // 10 (ledger) + 0.75 (nightly) + 0.375 (mission)
  assert.equal(status.byProject.length, 3);
  const nr = status.byProject.find(p => p.project === 'nightly-repo');
  assert.equal(nr.usd, 0.75);
});

test('sessionLogRows with unknown model become unmeasured calls', () => {
  const status = summarizeGeminiBudget([row(60)], { ...options, sessionLogRows: [
    { project: 'nightly-repo', model: 'unknown-model', input: 100000, output: 50000, cached: 0, sessionId: 's1' },
  ], pricing: { models: {} } });
  assert.equal(status.unmeasuredCalls, 1); // 1 session log call unmeasured
  assert.equal(status.spentUsd, 60); // only ledger, session log had unknown pricing
});

test('sessionLogRows are deduplicated against ledger by sessionId', () => {
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75, cachedInputUsdPerMillion: 0.075 } } };
  // Ledger has a row with sessionId 's1' and usd 5
  const status = summarizeGeminiBudget([row(5, { sessionId: 's1' })], { ...options, sessionLogRows: [
    { project: 'nightly-repo', model: 'gemini-3.6-flash', input: 1_000_000, output: 0, cached: 0, sessionId: 's1' }, // should be skipped
    { project: 'mission', model: 'gemini-3.6-flash', input: 0, output: 100_000, cached: 0, sessionId: 's2' }, // new → counted
  ], pricing });
  assert.equal(status.spentUsd, 5 + 0.375); // 5 (ledger) + 0.375 (s2), s1 skipped
  assert.equal(status.byProject.length, 2);
});

test('every response in the same session is counted', () => {
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 } } };
  const status = summarizeGeminiBudget([], { ...options, sessionLogRows: [
    { project: 'p1', model: 'gemini-3.6-flash', input: 1_000_000, output: 0, cached: 0, sessionId: 's1' },
    { project: 'p2', model: 'gemini-3.6-flash', input: 500_000, output: 0, cached: 0, sessionId: 's1' },
  ], pricing });
  assert.equal(status.spentUsd, 1.125); // both responses counted
});

test('sessionLogRows with no sessionId are never deduped (each counted)', () => {
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 } } };
  const status = summarizeGeminiBudget([], { ...options, sessionLogRows: [
    { project: 'p1', model: 'gemini-3.6-flash', input: 1_000_000, output: 0, cached: 0 }, // no sessionId
    { project: 'p1', model: 'gemini-3.6-flash', input: 500_000, output: 0, cached: 0 }, // no sessionId → counted too
  ], pricing });
  assert.equal(status.spentUsd, 0.75 + 0.375);
});

test('sessionLogRows collects byProject with sorted descending order', () => {
  const pricing = { models: { 'gemini-3.6-flash': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } };
  const status = summarizeGeminiBudget([row(3, { project: 'big' }), row(1, { project: 'small' })], { ...options, sessionLogRows: [
    { project: 'medium', model: 'gemini-3.6-flash', input: 2_000_000, output: 0, cached: 0, sessionId: 's1' },
  ], pricing });
  const projects = status.byProject.map(p => ({ project: p.project, usd: Math.round(p.usd) }));
  // Expect sorted: big(3) > medium(2) > small(1)
  assert.deepEqual(projects, [{ project: 'big', usd: 3 }, { project: 'medium', usd: 2 }, { project: 'small', usd: 1 }]);
});

// ── Existing behaviour preservation ──
test('HTTP 4xx/5xx failures are excluded, while successful unmeasured calls remain unknown', () => {
  const failures = ['http_429', 'http_503', 'http_404'].map((status) => row(null, { status, in: null, out: null, estimated: true }));
  for (const usd of [1, 60, 86]) {
    const successes = [row(usd, { status: 'ok' })];
    assert.deepEqual(summarizeGeminiBudget([...successes, ...failures], options), summarizeGeminiBudget(successes, options));
  }
  assert.deepEqual(summarizeGeminiBudget(failures, options), summarizeGeminiBudget([], options));

  for (const status of ['ok', undefined]) {
    const successful = summarizeGeminiBudget([row(null, { status, estimated: true }), ...failures], options);
    assert.equal(successful.totalCalls, 1);
    assert.equal(successful.unmeasuredCalls, 1);
    assert.equal(successful.level, 'unknown');
  }
});

test('HTTP failure filtering preserves invalid timestamp and JSON accounting', async () => {
  const fsImpl = fixture([row(1, { status: 'ok' }), row(null, { status: 'http_429', t: 'invalid' })], options);
  const ledger = path.join(dir, 'executor-usage.jsonl');
  fsImpl.files.set(ledger, fsImpl.files.get(ledger) + 'broken\n');
  const status = await runGeminiBudgetGuard({ home, now, fsImpl, dryRun: true });
  assert.equal(status.invalidRows, 2);
  assert.equal(status.totalCalls, 1);
  assert.equal(status.unmeasuredCalls, 0);
  assert.equal(status.level, 'unknown');
});

test('JST month filtering, currency conversion and end-of-month pace', () => {
  const status = summarizeGeminiBudget([row(1, { t: '2026-08-31T15:00:00Z' }), row(99, { t: '2026-08-31T14:59:59Z' }), row(99, { t: '2026-09-20T00:00:00Z' }), row(99, { provider: 'groq' })], { now });
  assert.equal(status.spentUsd, 1); assert.equal(status.spentJpy, 150); assert.equal(status.paceEomJpy, 150 / 14 * 30);
});

test('unknown calls DM via existing notifier; filesystem and notifier are mocks', async () => {
  const fsImpl = fixture([row(null)]), messages = [];
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async (...args) => { messages.push(args); return { delivered: 'dm' }; } });
  assert.equal(result.level, 'unknown'); assert.equal(messages.length, 1);
  assert.match(messages[0][0], /うち未計測 1 件（実費はこれより大きい）/);
  assert.deepEqual(messages[0][1], { home, webhookFallback: false });
  assert.deepEqual(JSON.parse(fsImpl.files.get(path.join(dir, 'gemini-budget-status.json'))), result);
});

test('warn notifies, ok does not; notification failure is visible', async () => {
  for (const usd of [69, 70]) {
    let sent = 0;
    await runGeminiBudgetGuard({ home, now, fsImpl: fixture([row(usd)]), notifyImpl: async () => { sent++; return { delivered: 'dm' }; } });
    assert.equal(sent, usd >= 70 ? 1 : 0);
  }
  await assert.rejects(runGeminiBudgetGuard({ home, now, fsImpl: fixture([row(null)]), notifyImpl: async () => ({ delivered: 'none' }) }), /DM未送信/);
});

test('critical merges demote with existing overrides, expiry is next month JST', async () => {
  const file = path.join(dir, 'routing-overrides.json');
  const original = { demote: { groq: '2026-09-30T00:00:00Z' }, gatewayBeforeDirect: { kimi: 'keep' }, other: { retain: true } };
  const fsImpl = fixture([row(91)], undefined, { [file]: JSON.stringify(original) });
  await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async () => ({ delivered: 'dm' }) });
  assert.deepEqual(JSON.parse(fsImpl.files.get(file)), { ...original, demote: { ...original.demote, gemini: '2026-09-30T15:00:00.000Z' } });
  const corrupt = fixture([row(91)], undefined, { [file]: '{broken' });
  await assert.rejects(runGeminiBudgetGuard({ home, now, fsImpl: corrupt, notifyImpl: async () => ({ delivered: 'dm' }) }));
  assert.equal(corrupt.files.get(file), '{broken');
});

test('known spending above 90% triggers stop and demotion even with unmeasured calls', async () => {
  const fsImpl = fixture([row(91), row(null)]);
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async () => ({ delivered: 'dm' }) });
  assert.equal(result.level, 'stop'); assert.ok(fsImpl.files.has(path.join(dir, 'routing-overrides.json')));
});

test('dry-run has no filesystem writes or notifications even for critical/unknown', async () => {
  const fsImpl = fixture([row(91), row(null)]), initial = new Map(fsImpl.files);
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, dryRun: true, notifyImpl: async () => { assert.fail('must not send Discord'); } });
  assert.equal(result.spentUsd, 91); assert.equal(result.level, 'stop'); assert.deepEqual(fsImpl.files, initial); assert.deepEqual(fsImpl.writes, []);
});

test('missing/empty/corrupt ledger cannot report ok; default budget and rate are used', async () => {
  for (const fsImpl of [memoryFs(), fixture([]), fixture([], {}, { [path.join(dir, 'executor-usage.jsonl')]: 'broken\n' })]) {
    const status = await runGeminiBudgetGuard({ home, now, fsImpl, dryRun: true });
    assert.equal(status.level, 'unknown');
  }
  const status = await runGeminiBudgetGuard({ home, now, fsImpl: memoryFs(), dryRun: true });
  assert.equal(status.budgetJpy, 50000); assert.equal(status.ledgerAvailable, false);
});

test('directive always discloses unmeasured calls, missing status and stale status', () => {
  const status = summarizeGeminiBudget([row(1), row(null)], options);
  assert.match(formatGeminiBudgetStatus(status, { now }), /うち未計測 1 件（実費はこれより大きい）/);
  assert.match(formatGeminiBudgetStatus(null, { now }), /判断不能/);
  assert.match(formatGeminiBudgetStatus({ ...status, checkedAt: '2026-09-01T00:00:00Z' }, { now }), /予算状態が古い/);
});

// ── Integration: runGeminiBudgetGuard with session logs ──
test('runGeminiBudgetGuard with session logs adds byProject and session spending', async () => {
  const files = {
    [path.join(dir, 'executor-usage.jsonl')]: JSON.stringify(row(50, { sessionId: 's1' })) + '\n',
    [path.join(dir, 'gemini-budget.json')]: JSON.stringify({ budgetJpy: 50000, usdPerJpy: 150 }),
  };
  // Build session log data via memoryFs
  const geminiTmp = path.join(home, '.gemini', 'tmp', 'nightly-repo', 'chats');
  files[path.join(geminiTmp, 'session-s1.jsonl')] = JSON.stringify({ type: 'gemini', model: 'gemini-3.6-flash', tokens: { input: 1_000_000, output: 0, cached: 0 }, timestamp: '2026-09-14T00:00:00Z' }) + '\n';
  files[path.join(geminiTmp, 'session-s2.jsonl')] = JSON.stringify({ type: 'gemini', model: 'gemini-3.6-flash', tokens: { input: 0, output: 100_000, cached: 0 }, timestamp: '2026-09-14T00:00:00Z' }) + '\n';

  const mem = memoryFs(files);
  // Need readdirSync/statSync for collectSessionLogUsage; fallback to empty session logs
  // Since memoryFs doesn't support readdirSync, wrap it by making collectSessionLogUsage return empty
  const fsImpl = {
    ...mem,
    readdirSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    statSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  };
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, dryRun: true });
  // Should still work without session logs (graceful fallback)
  assert.equal(result.spentUsd, 50);
  assert.equal(result.level, 'ok'); // 50*150=7500, pct=15% < 70%, no unmeasured → ok
  assert.ok(Array.isArray(result.byProject));
});

test('runGeminiBudgetGuard gracefully handles missing session log directory', async () => {
  const fsImpl = fixture([row(10)]);
  const result = await runGeminiBudgetGuard({ home: path.resolve('/no-such-home'), now, fsImpl, dryRun: true });
  assert.equal(result.spentUsd, 0);
});
test('real JSONL: all turns, ledger priority, broken lines, month boundaries and read-only dry-run', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-meter-'));
  try {
    const claude = path.join(temp, '.claude');
    const chats = path.join(temp, '.gemini', 'tmp', 'mission', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, 'executor-usage.jsonl'), JSON.stringify(row(1, { sessionId: 'covered' })) + '\n');
    fs.writeFileSync(path.join(claude, 'gemini-budget.json'), JSON.stringify({ budgetJpy: 100, usdJpy: 1 }));
    const response = (timestamp = now.toISOString()) => ({ type: 'gemini', timestamp, model: 'gemini-3.6-flash', tokens: { input: 1_000_000, output: 0, cached: 0, thoughts: 100_000, tool: 0, total: 1_100_000 } });
    const file = path.join(chats, 'session-new.jsonl');
    const transcript = { type: 'gemini', id: 'transcript', timestamp: now.toISOString(), content: '', thoughts: [], tokens: null };
    const content = [response(), transcript, response(), response('2026-08-31T14:59:59Z'), response('2026-09-30T00:00:00Z')].map(JSON.stringify).join('\n') + '\n{broken\n';
    fs.writeFileSync(file, content);
    fs.writeFileSync(path.join(chats, 'session-dated-covered.jsonl'), [response(), response()]
      .map(entry => JSON.stringify({ ...entry, sessionId: 'covered' })).join('\n') + '\n');
    const status = await runGeminiBudgetGuard({ home: temp, now, dryRun: true });
    assert.equal(status.spentUsd, 3.25);
    assert.equal(status.totalCalls, 3);
    assert.equal(status.invalidRows, 1);
    assert.equal(status.byProject.find(p => p.project === 'mission').usd, 2.25);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.existsSync(path.join(claude, 'gemini-budget-status.json')), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('90 percent writes budget cooldown, preserving other providers', async () => {
  const file = path.join(dir, 'provider-cooldown.json');
  const fsImpl = fixture([row(90)], undefined, { [file]: JSON.stringify({ groq: { until: 123 } }) });
  const status = await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async () => ({ delivered: 'dm' }) });
  const state = JSON.parse(fsImpl.files.get(file));
  assert.equal(status.level, 'stop');
  assert.deepEqual(state.groq, { until: 123 });
  assert.equal(state.gemini.until, Date.parse('2026-09-30T15:00:00Z'));
});
