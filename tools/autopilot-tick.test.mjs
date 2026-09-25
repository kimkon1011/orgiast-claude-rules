import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAutopilot, autopilotPaths, parseControl, capReason, dateKey, acquireLock } from './autopilot-tick.mjs';

const NOW = new Date('2026-09-21T01:00:00Z');
const snow = (offset) => String((BigInt(NOW.getTime() - 1420070400000 + offset) << 22n));
function fixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opts = { home, dir: path.join(home, 'state'), now: NOW, token: '', userId: '', hostname: 'test-pc', fetchImpl: async () => { throw new Error('unexpected network'); }, ...overrides };
  const call = (command, args = {}, extra = {}) => runAutopilot(command, args, { ...opts, ...extra });
  return { opts, call, paths: autopilotPaths(opts) };
}
function discord(t, overrides = {}) {
  const channels = { control: [], dm: [] }, sent = [], calls = [];
  const f = fixture(t, { token: 'test-token', userId: 'kim', ...overrides });
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude', 'orgiast-autopilot-channel-id.txt'), 'control');
  const unavailable = new Set();
  f.opts.fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bot test-token');
    if (url.endsWith('/users/@me/channels')) return { ok: true, json: async () => ({ id: 'dm' }) };
    const parsed = new URL(url), channel = parsed.pathname.split('/')[4];
    if (unavailable.has(channel)) return { ok: false, status: 503 };
    if (init.method === 'POST') { sent.push(JSON.parse(init.body).content); return { ok: true }; }
    const after = BigInt(parsed.searchParams.get('after'));
    return { ok: true, json: async () => channels[channel].filter((m) => BigInt(m.id) > after).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(0, 100).reverse() };
  };
  const message = (text, n, user = 'kim') => ({ id: snow(n), content: text, author: { id: user }, timestamp: new Date(NOW.getTime() + n).toISOString() });
  return { ...f, channels, sent, calls, message, unavailable };
}

test('start validates limits and refuses a second running objective', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('start', { objective: 'test', 'max-noop': 0 })).error, 'invalid_maxNoop');
  assert.equal((await f.call('start', { objective: 'test', 'max-total-iter': 1.5 })).error, 'invalid_maxTotalIter');
  assert.equal((await f.call('start', { objective: 'test', done: 'tests pass' })).status, 'running');
  assert.equal((await f.call('start', { objective: 'other' })).error, 'already_running');
  assert.equal((await f.call('pre')).verdict, 'run');
  assert.equal((await f.call('pre')).control, null);
});

test('cap boundaries: iter/hours/noop/total and lifetime stop precedence', () => {
  const objective = { maxIterPerDay: 20, maxHoursPerDay: 6, maxNoop: 3, maxTotalIter: 200 };
  const state = { totalIterations: 0, iterationsToday: 0, consecutiveNoop: 0 };
  assert.equal(capReason(state, objective, { hours: 5.99 }), null);
  assert.equal(capReason({ ...state, iterationsToday: 20 }, objective, { hours: 0 }), 'daily_iter_cap');
  assert.equal(capReason(state, objective, { hours: 6 }), 'daily_hours_cap');
  assert.equal(capReason({ ...state, consecutiveNoop: 3 }, objective, { hours: 0 }), 'noop_streak');
  assert.equal(capReason({ ...state, totalIterations: 200, iterationsToday: 20 }, objective, { hours: 6 }), 'total_cap');
});

test('JST rollover clears daily count but requires explicit resume from pause', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test', 'max-iter-per-day': 1 });
  assert.equal((await f.call('post', { summary: 'work', progress: 10 })).watchdog.reason, 'daily_iter_cap');
  assert.equal((await f.call('resume')).status, 'paused');
  const tomorrow = { now: new Date('2026-09-21T15:00:00Z') };
  const pre = await f.call('pre', {}, tomorrow);
  assert.equal(pre.verdict, 'pause');
  assert.equal(pre.budget.iterationsLeftToday, 1);
  assert.equal((await f.call('resume', {}, tomorrow)).status, 'running');
  assert.equal((await f.call('status', {}, tomorrow)).state.totalIterations, 1);
  assert.equal(dateKey('2026-09-21T14:59:59Z'), '2026-09-21');
  assert.equal(dateKey('2026-09-21T15:00:00Z'), '2026-09-22');
});

test('hours cap uses the range of today log timestamps and fires immediately on post', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test', 'max-hours-per-day': 1 });
  await f.call('post', { summary: 'first', progress: 10 });
  const result = await f.call('post', { summary: 'second', progress: 20 }, { now: new Date(NOW.getTime() + 3_600_000) });
  assert.equal(result.status, 'paused');
  assert.equal(result.watchdog.reason, 'daily_hours_cap');
  assert.match(f.sent[0], /\[autopilot@test-pc\] 異常停止: daily_hours_cap/);
});

test('consecutiveNoop resets on progress, unchanged progress is noop, watchdog only notifies on transition', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test', 'max-noop': 2 });
  await f.call('pre');
  await f.call('post', { summary: 'blocked', progress: 0, noop: true });
  assert.equal((await f.call('status')).state.consecutiveNoop, 1);
  await f.call('post', { summary: 'success', progress: 10, codex: true });
  assert.equal((await f.call('status')).state.consecutiveNoop, 0);
  const same = await f.call('post', { summary: 'same', progress: 10, 'next-delay': 10 });
  assert.equal(same.noop, true);
  assert.equal(same.nextDelaySec, 1800);
  const fired = await f.call('post', { summary: 'blocked', progress: 10 });
  assert.deepEqual(fired.watchdog, { reason: 'noop_streak' });
  await f.call('pre');
  assert.equal(f.sent.filter((s) => s.includes('異常停止')).length, 1);
  assert.equal((await f.call('resume')).status, 'running');
  assert.equal((await f.call('status')).state.consecutiveNoop, 0);
});

test('total cap stops and cannot be bypassed with resume', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test', 'max-total-iter': 1 });
  const post = await f.call('post', { summary: 'work', progress: 10 });
  assert.equal(post.status, 'stopped');
  assert.equal(post.watchdog.reason, 'total_cap');
  assert.equal((await f.call('resume')).status, 'stopped');
});

test('control parser handles exact Japanese/English commands without substring false positives', () => {
  for (const text of ['止めて', '停止', 'stop', 'STOP!']) assert.equal(parseControl(text).command, 'stop');
  for (const text of ['一時停止', 'pause']) assert.equal(parseControl(text).command, 'pause');
  for (const text of ['続けて', '再開', 'continue', 'go']) assert.equal(parseControl(text).command, 'run');
  for (const text of ['目的変更: 新目的', '目的変更：新目的']) assert.deepEqual(parseControl(text), { command: 'objective', objective: '新目的' });
  for (const text of ['ongoing', 'stop しないで', '目的変更:', '一時停止について調べて']) assert.equal(parseControl(text), null);
});

test('only kim commands apply; chronological control + DM handling and no message replay', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test' });
  f.channels.control.push(f.message('stop', 1, 'other'), { ...f.message('stop', 2), author: { id: 'kim', bot: true } });
  assert.equal((await f.call('pre')).verdict, 'run');
  f.channels.control.push(f.message('一時停止', 3));
  const pause = await f.call('pre');
  assert.equal(pause.verdict, 'pause');
  assert.equal(pause.control.messageId, snow(3));
  f.channels.dm.push(f.message('続けて', 4));
  assert.equal((await f.call('pre')).verdict, 'run');
  assert.equal((await f.call('pre')).control, null);
  f.channels.control.push(f.message('止めて', 5));
  assert.equal((await f.call('pre')).verdict, 'stop');
  f.channels.dm.push(f.message('目的変更：新しい目的', 6));
  const changed = await f.call('pre');
  assert.equal(changed.verdict, 'run');
  assert.equal(changed.objective.objective, '新しい目的');
  assert.equal((await f.call('status')).state.lastControlMessageId, snow(6));
});

test('offline channel does not lose controls when the DM cursor advances', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test' });
  f.channels.control.push(f.message('stop', 1));
  f.channels.dm.push(f.message('continue', 2));
  f.unavailable.add('control');
  assert.equal((await f.call('pre')).verdict, 'run');
  f.unavailable.clear();
  assert.equal((await f.call('pre')).verdict, 'stop');
  assert.equal((await f.call('pre')).control, null);
});

test('inbox fallback, history before start excluded, pagination processes over 100 messages', async (t) => {
  const f = discord(t);
  fs.renameSync(path.join(f.opts.home, '.claude', 'orgiast-autopilot-channel-id.txt'), path.join(f.opts.home, '.claude', 'orgiast-inbox-channel-id.txt'));
  await f.call('start', { objective: 'test' });
  f.channels.control.push(f.message('stop', -100));
  for (let n = 1; n <= 150; n++) f.channels.control.push(f.message(n === 150 ? 'pause' : 'hello', n));
  const pre = await f.call('pre');
  assert.equal(pre.verdict, 'pause');
  assert.equal(pre.control.messageId, snow(150));
  assert.equal((await f.call('pre')).control, null);
});

test('running pre/post and day rollover never send progress DMs; logs retain work', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'digest goal' });
  await f.call('pre');
  for (let n = 1; n <= 4; n++) await f.call('post', { summary: `work${n}`, progress: n * 10 });
  await f.call('pre', {}, { now: new Date('2026-09-22T01:00:00Z') });
  assert.equal(f.sent.length, 0);
  assert.match(fs.readFileSync(f.paths.log, 'utf8'), /work1[\s\S]*work4/);
});

test('done is durable, notifies once, and handoff contains the seven session-close headings', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test', done: 'pass tests' });
  assert.equal((await f.call('post', { summary: 'verified', progress: 100 })).status, 'done');
  assert.match(f.sent[0], /\[autopilot@test-pc\] 完了/);
  assert.equal((await f.call('post', { summary: 'duplicate', progress: 100 })).error, 'not_running');
  assert.equal((await f.call('resume')).error, 'already_done');
  f.channels.dm.push(f.message('continue', 1));
  assert.equal((await f.call('pre')).verdict, 'done');
  assert.equal((await f.call('handoff')).ok, true);
  const text = fs.readFileSync(f.paths.handoff, 'utf8');
  for (const title of ['次の1目的', '対象', '完了条件', '直前セッションの成果（3行）', '残TODO（次の1件を先頭に）', '触る前に読む memory', '未決（kim の判断待ち）']) assert.ok(text.includes(`## ${title}\n`));
  assert.match(text, /pass tests/);
});

test('pause reason is in handoff; new start archives history', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'first' });
  await f.call('post', { summary: 'work', progress: 10 });
  await f.call('pause', { reason: 'needs_kim' });
  await f.call('handoff');
  assert.match(fs.readFileSync(f.paths.handoff, 'utf8'), /needs_kim/);
  await f.call('start', { objective: 'second' });
  assert.equal((await f.call('status')).state.totalIterations, 0);
  const archive = fs.readdirSync(f.paths.dir).find((n) => n.startsWith('archive-'));
  assert.match(fs.readFileSync(path.join(f.paths.dir, archive, 'log.jsonl'), 'utf8'), /work/);
});

test('invalid post does not mutate state or log and imports do not execute main', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test' });
  for (const progress of [-1, 101, 'oops', undefined]) assert.equal((await f.call('post', { summary: 'x', progress })).error, 'invalid_post');
  assert.equal((await f.call('status')).state.totalIterations, 0);
  assert.equal(fs.readFileSync(f.paths.log, 'utf8'), '');
});

test('locking rejects overlapping writes and recovers a dead owner', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.paths.dir, { recursive: true });
  const file = path.join(f.paths.dir, 'tick.lock');
  const release = acquireLock(file);
  assert.equal((await f.call('start', { objective: 'test' })).error, 'busy');
  release();
  fs.writeFileSync(file, '2147483647');
  assert.equal((await f.call('start', { objective: 'test' })).status, 'running');
});

test('CLI smoke with HOME and AUTOPILOT_HOME isolated; stdout always JSON and exit 0', (t) => {
  const f = fixture(t);
  const env = { ...process.env, HOME: f.opts.home, USERPROFILE: f.opts.home, ORGIAST_HOME: f.opts.home, AUTOPILOT_HOME: f.paths.dir, DISCORD_BOT_TOKEN: '', ORGIAST_DISCORD_USER_ID: '' };
  const cli = (args) => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'autopilot-tick.mjs'), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(cli(['start', '--objective', 'テスト']).ok, true);
  assert.equal(cli(['pre']).verdict, 'run');
  assert.equal(cli(['post', '--summary', 'x', '--progress', '10']).ok, true);
  assert.match(cli(['status', '--pretty']).text, /今日 1周/);
  assert.equal(cli(['handoff']).ok, true);
  assert.ok(cli(['--unknown']).error);
});

test('objective change resets progress baseline but preserves daily and lifetime budgets', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'first' });
  await f.call('post', { summary: 'complete first', progress: 100 });
  f.channels.dm.push(f.message('目的変更: second', 1));
  const pre = await f.call('pre');
  assert.equal(pre.verdict, 'run');
  assert.deepEqual(pre.recentLog, []);
  const post = await f.call('post', { summary: 'new progress', progress: 10 });
  assert.equal(post.noop, false);
  const state = (await f.call('status')).state;
  assert.equal(state.iterationsToday, 2);
  assert.equal(state.totalIterations, 2);
});

test('crash after appending log does not lose a charged iteration or allow bypassing caps', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test', 'max-total-iter': 1 });
  fs.appendFileSync(f.paths.log, JSON.stringify({ ts: NOW.toISOString(), iteration: 1, summary: 'appended before crash', progress: 10, noop: false }) + '\n');
  assert.equal((await f.call('pre')).verdict, 'stop');
  assert.equal((await f.call('status')).state.totalIterations, 1);
});

function candidates(f, body) {
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude', 'next-actions.md'), body);
}

test('done pre replenishes in priority order, skips human work and previous objective, sends once', async (t) => {
  const asked = [];
  const f = discord(t, { askImpl: async (candidate) => { asked.push(candidate); return candidate.objective === '電話する' ? 'No' : 'Yes'; } });
  await f.call('start', { objective: '前の目的' });
  await f.call('post', { summary: 'verified', progress: 100 });
  f.sent.length = 0;
  candidates(f, '## 明日の推奨アクション（今日）\n1. 前の目的\n2. 電話する\n   - first_step: 顧客へ電話\n3. テスト修正\n   - first_step: テストを実行\n4. 後回し\n');
  const pre = await f.call('pre');
  assert.equal(pre.verdict, 'run');
  assert.equal(pre.objective.objective, 'テスト修正');
  assert.match(pre.objective.context, /テストを実行/);
  assert.equal(pre.objective.done, '');
  assert.deepEqual(asked.map(c => c.objective), ['電話する', 'テスト修正']);
  assert.match(asked[0].context, /顧客へ電話/);
  assert.deepEqual(pre.recentLog, []);
  await f.call('pre');
  assert.deepEqual(f.sent, ['次の目的: テスト修正（止めるなら『止めて』と返信）']);
  const state = (await f.call('status')).state;
  assert.equal(state.objectiveHistory.at(-1).objective, '前の目的');
  assert.equal(state.iterationsToday, 1);
  assert.equal(state.totalIterations, 1);
  assert.equal((await f.call('post', { summary: 'new work', progress: 10 })).noop, false);
});

test('never-started pre starts a candidate with mocked classifier and notifier', async (t) => {
  const sent = [];
  const f = fixture(t, { askImpl: async () => 'Yes', notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; } });
  candidates(f, '## 推奨アクション\n- 自動テスト修正\n');
  assert.equal((await f.call('pre')).verdict, 'run');
  assert.equal((await f.call('status')).objective.objective, '自動テスト修正');
  assert.equal(sent.length, 1);
});

test('no eligible candidates leaves absent/done state and files unchanged, without DM', async (t) => {
  for (const done of [false, true]) {
    const f = discord(t, { askImpl: async () => 'No' });
    if (done) { await f.call('start', { objective: 'previous' }); await f.call('post', { summary: 'verified', progress: 100 }); }
    f.sent.length = 0;
    for (const body of ['', '## 別の節\n1. テスト修正', '## 推奨アクション\n1. ピック作業\n']) {
      candidates(f, body);
      const before = fs.existsSync(f.paths.state) ? fs.readFileSync(f.paths.state, 'utf8') : null;
      const pre = await f.call('pre');
      assert.equal(pre.verdict, done ? 'done' : 'stop');
      assert.equal(fs.existsSync(f.paths.state) ? fs.readFileSync(f.paths.state, 'utf8') : null, before);
      assert.deepEqual(f.sent, []);
    }
  }
});

test('replenishment preserves daily, time and lifetime caps', async (t) => {
  for (const [flag, limit, reason] of [['max-iter-per-day', 1, 'daily_iter_cap'], ['max-total-iter', 1, 'total_cap'], ['max-hours-per-day', 1, 'daily_hours_cap']]) {
    const f = discord(t, { askImpl: async () => 'Yes' });
    await f.call('start', { objective: 'first', [flag]: limit });
    if (flag === 'max-hours-per-day') await f.call('post', { summary: 'start work', progress: 10 });
    const extra = { now: new Date(NOW.getTime() + 3_600_000) };
    await f.call('post', { summary: 'verified', progress: 100 }, extra);
    candidates(f, '## 推奨アクション\n1. second');
    const pre = await f.call('pre', {}, extra);
    assert.equal(pre.reason, reason);
    assert.notEqual(pre.verdict, 'run');
    assert.equal(pre.objective[flag === 'max-iter-per-day' ? 'maxIterPerDay' : flag === 'max-total-iter' ? 'maxTotalIter' : 'maxHoursPerDay'], limit);
    assert.ok(f.sent.every(text => text.split('\n').length <= 3));
  }
});

test('stop controls take precedence over refill and terminal history survives start', async (t) => {
  const f = discord(t, { askImpl: async () => { throw new Error('must not classify'); } });
  await f.call('start', { objective: 'first' });
  await f.call('post', { summary: 'verified', progress: 100 });
  candidates(f, '## 推奨アクション\n1. second');
  f.channels.dm.push(f.message('止めて', 1));
  assert.equal((await f.call('pre')).verdict, 'stop');
  assert.equal((await f.call('status')).state.objectiveHistory.at(-1).status, 'stopped');
  await f.call('start', { objective: 'manual' });
  assert.equal((await f.call('status')).state.objectiveHistory.at(-1).objective, 'first');
});

test('one decision DM accepts yes/no only while pending and does not repeat', async (t) => {
  for (const [answer, verdict] of [['はい', 'run'], ['いいえ', 'stop']]) {
    const f = discord(t);
    await f.call('start', { objective: 'first' });
    await f.call('pause', { question: 'この変更を適用しますか？' });
    await f.call('pause', { question: 'この変更を適用しますか？' });
    await f.call('pre');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].split('\n').length, 3);
    f.channels.dm.push(f.message(answer, 1));
    const pre = await f.call('pre');
    assert.equal(pre.verdict, verdict);
    assert.equal(pre.decision.question, 'この変更を適用しますか？');
    assert.equal((await f.call('pre')).decision.answer, answer);
  }
});

test('classifier errors or uncertain answers never authorize work', async (t) => {
  for (const askImpl of [async () => { throw new Error('offline'); }, async () => 'Maybe']) {
    const f = discord(t, { askImpl });
    candidates(f, '## 推奨アクション\n1. テスト修正');
    assert.equal((await f.call('pre')).reason, 'not_started');
    assert.equal(fs.existsSync(f.paths.state), false);
    assert.deepEqual(f.sent, []);
  }
});
