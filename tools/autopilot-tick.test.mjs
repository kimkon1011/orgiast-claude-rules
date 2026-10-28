import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { runAutopilot, sendNotice, autopilotPaths, parseControl, capReason, dateKey, acquireLock } from './autopilot-tick.mjs';
import { toastSummary } from './autopilot-local-notice.mjs';

const NOW = new Date('2026-09-21T01:00:00Z');
const snow = (offset) => String((BigInt(NOW.getTime() - 1420070400000 + offset) << 22n));
function fixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opts = { home, askJevImpl: async () => ({ ok: false, reason: 'test_offline' }), platform: 'linux', dir: path.join(home, 'state'), now: NOW, token: '', userId: '', hostname: 'test-pc', fetchImpl: async () => { throw new Error('unexpected network'); }, ...overrides };
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
    if (init.method === 'POST') { sent.push(JSON.parse(init.body).content); return { ok: true, status: 200, json: async () => ({ id: snow(sent.length), channel_id: channel }) }; }
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

test('JST rollover clears a daily cap and resumes it automatically', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test', 'max-iter-per-day': 1 });
  assert.equal((await f.call('post', { summary: 'work', progress: 10 })).watchdog.reason, 'daily_iter_cap');
  assert.equal((await f.call('resume')).status, 'paused'); // the same-day cap cannot be bypassed
  const tomorrow = { now: new Date('2026-09-21T15:00:00Z') };
  const pre = await f.call('pre', {}, tomorrow);
  assert.equal(pre.verdict, 'run');
  assert.equal(pre.budget.iterationsLeftToday, 1);
  assert.equal((await f.call('status', {}, tomorrow)).state.status, 'running');
  assert.equal((await f.call('status', {}, tomorrow)).state.totalIterations, 1);
  assert.equal(dateKey('2026-09-21T14:59:59Z'), '2026-09-21');
  assert.equal(dateKey('2026-09-21T15:00:00Z'), '2026-09-22');
});

test('a pending question keeps a daily-cap pause until the human answers', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test', 'max-iter-per-day': 1 });
  assert.equal((await f.call('post', { summary: 'work', progress: 10 })).watchdog.reason, 'daily_iter_cap');
  await f.call('pause', { question: 'このまま進めてよいですか？' });
  const tomorrow = { now: new Date('2026-09-21T15:00:00Z') };
  const pre = await f.call('pre', {}, tomorrow);
  assert.equal(pre.verdict, 'pause');
  assert.equal(pre.pendingQuestion, 'このまま進めてよいですか？');
  assert.equal((await f.call('status', {}, tomorrow)).state.pausedReason, 'daily_iter_cap');
  assert.equal((await f.call('resume', {}, tomorrow)).status, 'running');
  assert.equal((await f.call('status', {}, tomorrow)).state.pendingQuestion, null);
});

test('an unanswered timed question expires and stops blocking the pause', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test', 'max-iter-per-day': 1 });
  assert.equal((await f.call('post', { summary: 'work', progress: 10 })).watchdog.reason, 'daily_iter_cap');
  await f.call('pause', { question: 'このまま進めてよいですか？', 'question-deadline': '2026-09-21T02:00:00Z' });
  // Before the deadline (same day, so the cap still applies): the question survives.
  const early = await f.call('pre', {}, { now: new Date('2026-09-21T01:30:00Z') });
  assert.equal(early.verdict, 'pause');
  assert.equal(early.pendingQuestion, 'このまま進めてよいですか？');
  // After the deadline the question clears itself (nothing is executed) and the cap reset resumes.
  const later = { now: new Date('2026-09-22T01:00:00Z') };
  const pre = await f.call('pre', {}, later);
  assert.equal(pre.verdict, 'run');
  assert.equal(pre.pendingQuestion, null);
  const state = (await f.call('status', {}, later)).state;
  assert.equal(state.status, 'running');
  assert.equal(state.pendingQuestionExpiresAt, null);
  assert.equal(state.lastExpiredQuestion.question, 'このまま進めてよいですか？');
  assert.equal(state.lastExpiredQuestion.expiredAt, '2026-09-21T02:00:00.000Z');
});

test('a 3-strike runner error resumes by itself once the login is renewed', async (t) => {
  const f = fixture(t);
  const creds = path.join(f.opts.home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(creds), { recursive: true });
  fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
  fs.utimesSync(creds, new Date('2026-09-21T00:00:00Z'), new Date('2026-09-21T00:00:00Z'));
  await f.call('start', { objective: 'test' });
  for (let i = 0; i < 3; i += 1) await f.call('pause', { reason: 'runner_error', detail: 'OAuth session expired' });
  const paused = (await f.call('status')).state;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.consecutiveRunnerErrors, 3);
  assert.equal(paused.lastRunnerErrorAt, NOW.toISOString());
  // Same credentials that failed: stay paused instead of relaunching the child every tick.
  assert.equal((await f.call('pre')).verdict, 'pause');
  // The owner logs in again: the file is rewritten, so the pause lifts with no command.
  fs.utimesSync(creds, new Date('2026-09-21T05:00:00Z'), new Date('2026-09-21T05:00:00Z'));
  assert.equal((await f.call('pre', {}, { now: new Date('2026-09-21T05:05:00Z') })).verdict, 'run');
  const after = (await f.call('status', {}, { now: new Date('2026-09-21T05:05:00Z') })).state;
  assert.equal(after.status, 'running');
  assert.equal(after.consecutiveRunnerErrors, 0);
});

test('a renewed login does not wipe an unanswered question', async (t) => {
  const f = fixture(t);
  const creds = path.join(f.opts.home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(creds), { recursive: true });
  fs.writeFileSync(creds, '{}');
  fs.utimesSync(creds, new Date('2026-09-21T00:00:00Z'), new Date('2026-09-21T00:00:00Z'));
  await f.call('start', { objective: 'test' });
  for (let i = 0; i < 3; i += 1) await f.call('pause', { reason: 'runner_error', detail: 'OAuth session expired' });
  await f.call('pause', { reason: 'runner_error', question: 'このまま進めますか？' });
  fs.utimesSync(creds, new Date('2026-09-21T05:00:00Z'), new Date('2026-09-21T05:00:00Z'));
  const pre = await f.call('pre', {}, { now: new Date('2026-09-21T05:05:00Z') });
  assert.equal(pre.verdict, 'pause');
  assert.equal(pre.pendingQuestion, 'このまま進めますか？');
});

test('a dead login still resumes when the deepseek key can carry the child', async (t) => {
  const f = fixture(t);
  const creds = path.join(f.opts.home, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(creds), { recursive: true });
  fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
  fs.utimesSync(creds, new Date('2026-09-21T00:00:00Z'), new Date('2026-09-21T00:00:00Z'));
  fs.writeFileSync(path.join(f.opts.home, '.claude', 'deepseek.env'), 'DEEPSEEK_API_KEY="sk-test"\n');
  await f.call('start', { objective: 'test' });
  for (let i = 0; i < 3; i += 1) await f.call('pause', { reason: 'runner_error', detail: 'OAuth session expired' });
  // Right after the pause nothing relaunches: a broken key must not spawn the child every tick.
  assert.equal((await f.call('pre', {}, { now: new Date(NOW.getTime() + 5 * 60_000) })).verdict, 'pause');
  const later = { now: new Date(NOW.getTime() + 31 * 60_000) };
  assert.equal((await f.call('pre', {}, later)).verdict, 'run');
  const state = (await f.call('status', {}, later)).state;
  assert.equal(state.status, 'running');
  assert.equal(state.consecutiveRunnerErrors, 0);
});

test('without a deepseek key a dead login keeps the 3-strike pause', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  await f.call('start', { objective: 'test' });
  for (let i = 0; i < 3; i += 1) await f.call('pause', { reason: 'runner_error', detail: 'OAuth session expired' });
  assert.equal((await f.call('pre', {}, { now: new Date(NOW.getTime() + 60 * 60_000) })).verdict, 'pause');
});

test('the deepseek fallback does not wipe an unanswered question', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude', 'deepseek.env'), 'DEEPSEEK_API_KEY=sk-test\n');
  await f.call('start', { objective: 'test' });
  for (let i = 0; i < 3; i += 1) await f.call('pause', { reason: 'runner_error', detail: 'OAuth session expired' });
  await f.call('pause', { reason: 'runner_error', question: 'このまま進めますか？' });
  const pre = await f.call('pre', {}, { now: new Date(NOW.getTime() + 60 * 60_000) });
  assert.equal(pre.verdict, 'pause');
  assert.equal(pre.pendingQuestion, 'このまま進めますか？');
});

test('an invalid question deadline is ignored', async (t) => {
  const f = fixture(t);
  await f.call('start', { objective: 'test' });
  await f.call('pause', { question: '進めますか？', 'question-deadline': 'not-a-date' });
  assert.equal((await f.call('status')).state.pendingQuestionExpiresAt, null);
  assert.equal((await f.call('pre')).pendingQuestion, '進めますか？');
});

test('hours cap uses the range of today log timestamps and fires immediately on post', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test', 'max-hours-per-day': 1 });
  await f.call('post', { summary: 'first', progress: 10 });
  const result = await f.call('post', { summary: 'second', progress: 20 }, { now: new Date(NOW.getTime() + 3_600_000) });
  assert.equal(result.status, 'paused');
  assert.equal(result.watchdog.reason, 'daily_hours_cap');
  assert.match(f.sent[0], /⚠️ 止まりました: test/);
  assert.match(f.sent[0], /今日の作業時間の上限になりました。明日また続けます。/);
  assert.doesNotMatch(f.sent[0], /daily_hours_cap/);
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
  assert.equal(f.sent.filter((s) => s.includes('止まりました')).length, 1);
  assert.match(f.sent[0], /3回続けて進みませんでした。いったん止めています。/);
  assert.doesNotMatch(f.sent[0], /noop_streak/);
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

test('digest records the real delivery result and never re-sends the same slot', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'digest goal' });
  const noon = { now: new Date('2026-09-21T03:00:00Z') };
  const sent = await f.call('digest', {}, noon);
  assert.equal(sent.ok, true);
  assert.equal(sent.slot, '2026-09-21-12');
  assert.equal(sent.delivered, 'dm');
  assert.equal((await f.call('status', {}, noon)).state.lastDigestDelivered, 'dm');
  assert.equal((await f.call('digest', {}, noon)).skipped, 'not_due_or_already_sent');
  f.unavailable.add('dm');
  const evening = { now: new Date('2026-09-21T12:00:00Z') };
  const failed = await f.call('digest', {}, evening);
  assert.equal(failed.delivered, 'none');
  assert.equal((await f.call('status', {}, evening)).state.lastDigestDelivered, 'none');
  assert.equal(f.sent.length, 1); // 未達の分は送れた扱いにしない
});

test('done is durable, notifies once, and handoff contains the seven session-close headings', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test', done: 'pass tests' });
  assert.equal((await f.call('post', { summary: 'verified', progress: 100, evidence: 'テストが全部通った' })).status, 'done');
  assert.match(f.sent[0], /✅ 終わりました: test/);
  assert.match(f.sent[0], /確かめたこと: テストが全部通った/);
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
  await f.call('post', { summary: 'complete first', progress: 100, evidence: '完了を確認' });
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
  await f.call('post', { summary: 'verified', progress: 100, evidence: '完了を確認' });
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
  assert.deepEqual(f.sent, ['▶ 次はこれをやります: テスト修正\nやめてほしいときは「止めて」と返信してください。（test-pc）']);
  const state = (await f.call('status')).state;
  assert.equal(state.objectiveHistory.at(-1).objective, '前の目的');
  assert.equal(state.iterationsToday, 1);
  assert.equal(state.totalIterations, 1);
  assert.equal((await f.call('post', { summary: 'new work', progress: 10 })).noop, false);
});

test('refill skips every objective already closed in history, not just the most recent', async (t) => {
  const asked = [];
  const f = discord(t, { askImpl: async (candidate) => { asked.push(candidate.objective); return 'Yes'; } });
  await f.call('start', { objective: 'A' });
  await f.call('post', { summary: 'A done', progress: 100, evidence: '完了を確認' });
  f.channels.dm.push(f.message('目的変更: B', 1));
  await f.call('pre');
  await f.call('post', { summary: 'B done', progress: 100, evidence: '完了を確認' });
  const history = (await f.call('status')).state.objectiveHistory.map((e) => e.objective);
  assert.deepEqual(history, ['A', 'B']);
  f.sent.length = 0;
  candidates(f, '## 推奨アクション\n1. A\n2. B\n3. C\n');
  const pre = await f.call('pre');
  assert.equal(pre.verdict, 'run');
  assert.equal(pre.objective.objective, 'C');
  assert.deepEqual(asked, ['C']);
});

test('refill with only the current objective in history still picks the first eligible candidate', async (t) => {
  const asked = [];
  const f = discord(t, { askImpl: async (candidate) => { asked.push(candidate.objective); return 'Yes'; } });
  await f.call('start', { objective: 'current' });
  await f.call('post', { summary: 'current done', progress: 100, evidence: '完了を確認' });
  assert.deepEqual((await f.call('status')).state.objectiveHistory.map((e) => e.objective), ['current']);
  candidates(f, '## 推奨アクション\n1. A\n2. B\n');
  const pre = await f.call('pre');
  assert.equal(pre.verdict, 'run');
  assert.equal(pre.objective.objective, 'A');
  assert.deepEqual(asked, ['A']);
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
    if (done) { await f.call('start', { objective: 'previous' }); await f.call('post', { summary: 'verified', progress: 100, evidence: '完了を確認' }); }
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
    await f.call('post', { summary: 'verified', progress: 100, evidence: '完了を確認' }, extra);
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
  await f.call('post', { summary: 'verified', progress: 100, evidence: '完了を確認' });
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
    const pending = await f.call('pre');
    assert.equal(pending.verdict, 'run');
    assert.equal(pending.pendingQuestion, 'この変更を適用しますか？');
    assert.equal((await f.call('status')).state.status, 'running');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].split('\n').length, 2);
    assert.match(f.sent[0], /^❓ 決めてほしいこと: この変更を適用しますか？/);
    f.channels.dm.push(f.message(answer, 1));
    const pre = await f.call('pre');
    assert.equal(pre.verdict, verdict);
    assert.equal(pre.pendingQuestion, null);
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

test('progress 100 without evidence or unverified is rejected and does not change state', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test' });
  const before = fs.readFileSync(f.paths.state, 'utf8');
  assert.equal((await f.call('post', { summary: 'done', progress: 100 })).error, 'evidence_required');
  assert.equal(fs.readFileSync(f.paths.state, 'utf8'), before);
  assert.equal((await f.call('status')).state.status, 'running');
  assert.equal((await f.call('status')).state.totalIterations, 0);
  assert.deepEqual(f.sent, []);
});

test('progress 100 with unverified completes and registers a watch', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '返信を送る' });
  const post = await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  assert.equal(post.status, 'done');
  assert.equal(post.watch, 'w1');
  const state = (await f.call('status')).state;
  assert.equal(state.watches.length, 1);
  assert.deepEqual({ ...state.watches[0], since: undefined }, { id: 'w1', objective: '返信を送る', unverified: '相手に届いたか', evidence: '', since: undefined, lastCheckAt: null, checks: 0, ng: 0 });
  assert.match(f.sent[0], /🟡 だいたい終わりました: 返信を送る/);
  assert.match(f.sent[0], /まだ確かめられていないこと: 相手に届いたか/);
  assert.match(f.sent[0], /毎日たしかめて、結果をまた知らせます。/);
});

test('watch ok removes the watch and notifies once', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '返信を送る' });
  await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  f.sent.length = 0;
  const result = await f.call('watch', { id: 'w1', result: 'ok', note: '相手から返事が来た' });
  assert.equal(result.status, 'ok');
  assert.equal((await f.call('status')).state.watches.length, 0);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /✅ 確かめられました: 返信を送る/);
  assert.match(f.sent[0], /相手から返事が来た/);
});

test('watch ng three times fails the check, notifies once and records history', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '返信を送る' });
  await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  f.sent.length = 0;
  assert.equal((await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' })).status, 'ng');
  assert.equal((await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' })).status, 'ng');
  assert.deepEqual(f.sent, []);
  const third = await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' });
  assert.equal(third.status, 'failed_check');
  assert.equal((await f.call('status')).state.watches.length, 0);
  assert.equal((await f.call('status')).state.objectiveHistory.at(-1).status, 'failed_check');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /⚠️ うまくいっていません: 返信を送る/);
  assert.match(f.sent[0], /わかったこと: まだ届いていない/);
  assert.match(f.sent[0], /直すなら「直して」、やめるなら「止めて」と返信してください。/);
});

test('watch expires after seven days and notifies once', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '返信を送る' });
  await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  f.sent.length = 0;
  const later = { now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000) };
  const result = await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' }, later);
  assert.equal(result.status, 'failed_check');
  assert.equal((await f.call('status', {}, later)).state.watches.length, 0);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /⚠️ うまくいっていません: 返信を送る/);
});

test('watch validates input and reports unknown ids', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: 'test' });
  assert.equal((await f.call('watch', { id: '', result: 'ok', note: 'x' })).error, 'invalid_watch');
  assert.equal((await f.call('watch', { id: 'w1', result: 'maybe', note: 'x' })).error, 'invalid_watch');
  assert.equal((await f.call('watch', { id: 'w1', result: 'ok', note: '' })).error, 'invalid_watch');
  assert.equal((await f.call('watch', { id: 'w9', result: 'ok', note: 'x' })).error, 'watch_not_found');
});

test('watchesDue lists never-checked and stale watches only', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '返信を送る' });
  await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  const pre = await f.call('pre');
  assert.equal(pre.watchesDue.length, 1);
  assert.equal(pre.watchesDue[0].id, 'w1');
  const soon = { now: new Date(NOW.getTime() + 3600 * 1000) };
  assert.equal((await f.call('pre', {}, soon)).watchesDue.length, 0);
  const nextDay = { now: new Date(NOW.getTime() + 25 * 3600 * 1000) };
  assert.equal((await f.call('pre', {}, nextDay)).watchesDue.length, 1);
});

test('Discord notices never leak internal codes, commands or ids', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '[P1タスク] 返信を送る' });
  await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' });
  await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' });
  await f.call('watch', { id: 'w1', result: 'ng', note: 'まだ届いていない' });
  await f.call('start', { objective: 'second', 'max-noop': 1 });
  await f.call('post', { summary: 'blocked', progress: 0, noop: true });
  await f.call('post', { summary: 'blocked', progress: 0, noop: true });
  await f.call('pause', { question: 'この変更を適用しますか？' });
  assert.ok(f.sent.length >= 4);
  for (const text of f.sent) {
    assert.doesNotMatch(text, /_cap|runner_error|noop|P1|gh |FB-fb-|daily_iter|daily_hours|total_cap/);
    assert.doesNotMatch(text, /\[P1タスク\]/);
    assert.ok(text.split('\n').length <= 4, text);
  }
});

test('直して resumes like 続けて', () => {
  assert.equal(parseControl('直して').command, 'run');
  assert.equal(parseControl('直して！').command, 'run');
});


test('a watch never checked for seven days is closed by pre with one plain notice', async (t) => {
  const f = discord(t);
  await f.call('start', { objective: '[P1タスク] 返信を送る' });
  await f.call('post', { summary: 'sent', progress: 100, unverified: '相手に届いたか' });
  f.sent.length = 0;
  const later = { now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000) };
  const pre = await f.call('pre', {}, later);
  assert.deepEqual(pre.watchesDue, []);
  const state = (await f.call('status', {}, later)).state;
  assert.equal(state.watches.length, 0);
  assert.equal(state.objectiveHistory.at(-1).status, 'failed_check');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /⚠️ うまくいっていません: 返信を送る/);
  assert.match(f.sent[0], /7日間、確かめられませんでした/);
  assert.doesNotMatch(f.sent[0], /P1|w1|watch/);
  await f.call('pre', {}, later);
  assert.equal(f.sent.length, 1);
});

function mirrorConfig(f, command = ['node', 'mirror.mjs']) {
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude', 'autopilot-notify-mirror.json'), JSON.stringify({ command }));
}
function mirrorSpawn(calls, outcome = 0) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const call = { executable, args, options, input: null, killed: false };
    calls.push(call);
    child.kill = () => { call.killed = true; };
    child.stdin = new EventEmitter();
    child.stdin.end = input => {
      call.input = input;
      if (outcome !== 'timeout') queueMicrotask(() => {
        if (outcome === 'error') child.emit('error', new Error('spawn_failed'));
        else if (outcome === 'stdin') child.stdin.emit('error', new Error('broken_pipe'));
        else child.emit('close', outcome);
      });
    };
    return child;
  };
}
test('no mirror config never spawns a child', async t => {
  const f = fixture(t), calls = [], sent = [];
  const result = await sendNotice('本文', { ...f.opts, spawnImpl: mirrorSpawn(calls), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; } });
  assert.equal(result.delivered, 'dm');
  assert.equal(result.channels.file.status, 'written');
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, ['本文']);
});
test('configured mirror follows one DM and gets identical final body as one JSON line', async t => {
  const calls = [], f = discord(t, { spawnImpl: mirrorSpawn(calls) });
  mirrorConfig(f);
  await f.call('start', { objective: 'テスト' });
  await f.call('pause', { question: 'この変更を進めますか？' });
  assert.equal(f.sent.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'node');
  assert.deepEqual(calls[0].args, ['mirror.mjs']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].input, JSON.stringify({ kind: 'notify', message: f.sent[0] }) + '\n');
});
for (const outcome of [2, 'timeout', 'error', 'stdin']) {
  test(`mirror ${outcome} logs failure and preserves DM result without throwing`, async t => {
    const f = fixture(t), calls = [], dmResult = { delivered: 'dm' };
    mirrorConfig(f);
    const result = await sendNotice('本文', { ...f.opts, mirrorTimeoutMs: 10, spawnImpl: mirrorSpawn(calls, outcome), notifyImpl: async () => dmResult });
    assert.equal(result.delivered, dmResult.delivered);
    assert.equal(calls.length, 1);
    const log = JSON.parse(fs.readFileSync(path.join(f.paths.dir, 'run.log'), 'utf8'));
    assert.match(log.mirrorError, /mirror_exit:2|mirror_timeout|spawn_failed|broken_pipe/);
    if (outcome === 'timeout') assert.equal(calls[0].killed, true);
  });
}
test('DM exception still attempts mirror and returns none', async t => {
  const f = fixture(t), calls = [];
  mirrorConfig(f);
  const result = await sendNotice('本文', { ...f.opts, spawnImpl: mirrorSpawn(calls), notifyImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.delivered, 'none');
  assert.equal(result.channels.dm.reason, 'offline');
  assert.equal(calls.length, 1);
});
test('asking a question does not override manual, control, cap or runner-error pauses', async t => {
  for (const reason of ['manual_pause', 'control_pause', 'daily_iter_cap', 'runner_error']) {
    const f = fixture(t);
    await f.call('start', { objective: 'test' });
    await f.call('pause', { reason });
    await f.call('pause', { question: '進めますか？' });
    const state = (await f.call('status')).state;
    assert.equal(state.status, 'paused');
    assert.equal(state.pausedReason, reason);
  }
});

function ownerConfig(f, owner) {
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude/autopilot-owner.json'), JSON.stringify(owner));
}
test('missing nishi Discord ID skips DM; unknown and kim owners retain legacy result', async t => {
  const f = fixture(t), kim = '715210673642012733';
  let sent = 0;
  const ctx = { ...f.opts, userId: kim, notifyImpl: async () => { sent++; return { delivered: 'dm' }; } };
  assert.equal((await sendNotice('本文', ctx)).delivered, 'dm');
  ownerConfig(f, { email: 'nishi@orgiast.jp', discordUserId: null });
  const result = await sendNotice('本文', ctx);
  assert.equal(result.delivered, 'no-owner-dm');
  assert.equal(result.reason, 'owner_discord_id_missing');
  assert.deepEqual(result.channels.dm, { status: 'no-owner-dm', reason: 'owner_discord_id_missing' });
  assert.equal(sent, 1);
  ownerConfig(f, { email: 'kim@orgiast.jp', discordUserId: null });
  assert.equal((await sendNotice('本文', ctx)).delivered, 'dm');
  assert.equal(sent, 2);
});
test('owner without Discord ID keeps digest file and toast without calling notifier', async t => {
  const f = fixture(t);
  ownerConfig(f, { email: ' NISHI@orgiast.jp ' });
  fs.writeFileSync(path.join(f.opts.home, '.claude/orgiast-discord-user-id.txt'), '715210673642012733');
  let sent = 0, toasts = 0;
  await f.call('start', { objective: '進捗' });
  const result = await f.call('digest', {}, {
    now: new Date('2026-10-23T03:00:00Z'), platform: 'win32',
    notifyImpl: async () => { sent++; return { delivered: 'dm' }; },
    execFileImpl: async () => { toasts++; return { stdout: 'submitted' }; },
  });
  assert.equal(result.delivered, 'no-owner-dm');
  assert.equal(result.channels.dm.reason, 'owner_discord_id_missing');
  assert.equal(sent, 0);
  assert.equal(toasts, 1);
  assert.equal(result.channels.toast.status, 'submitted');
  assert.equal(result.channels.file.status, 'written');
  assert.equal(fs.readFileSync(result.channels.file.path, 'utf8'), result.text);
});
test('owner discordUserId overrides legacy file and injected recipient', async t => {
  const f = fixture(t), recipients = [];
  ownerConfig(f, { email: 'nishi@orgiast.jp', discordUserId: '123456789' });
  fs.writeFileSync(path.join(f.opts.home, '.claude/orgiast-discord-user-id.txt'), '715210673642012733');
  const ctx = { ...f.opts, userId: '715210673642012733', notifyImpl: async (_text, options) => { recipients.push(options.userId); return { delivered: 'dm' }; } };
  const direct = await sendNotice('本文', ctx);
  await f.call('start', { objective: '進捗' });
  const digest = await f.call('digest', {}, { ...ctx, now: new Date('2026-10-23T03:00:00Z') });
  assert.equal(direct.delivered, 'dm');
  assert.equal(digest.delivered, 'dm');
  assert.deepEqual(recipients, ['123456789', '123456789']);
});
test('toast passes Japanese via UTF-8 file, cleans temporary payload, and file retains full text', async t => {
  const f = fixture(t), calls = [];
  const body = '一行目<&>\n二行目\n三行目\n四行目';
  const result = await sendNotice(body, { ...f.opts, platform: 'win32', notifyImpl: async () => ({ delivered: 'dm' }), execFileImpl: async (executable, args, options) => {
    const payloadPath = args.at(-1);
    calls.push({ executable, args, options, payloadPath, payload: JSON.parse(fs.readFileSync(payloadPath, 'utf8')) });
    return { stdout: 'submitted' };
  } });
  assert.equal(result.channels.toast.status, 'submitted');
  assert.equal(result.channels.file.status, 'written');
  assert.equal(fs.readFileSync(result.channels.file.path, 'utf8'), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'powershell.exe');
  assert.ok(calls[0].args.includes('-File'));
  assert.equal(calls[0].args.some(arg => arg.includes('一行目')), false);
  assert.deepEqual(calls[0].payload, { title: 'Claude 進捗（test-pc）', body: '一行目<&>\n二行目\n三行目' });
  assert.equal(fs.existsSync(calls[0].payloadPath), false);
  assert.equal(calls[0].options.timeout, 20_000);
});
test('toast failure is returned, Linux skips it, and file failure does not stop DM', async t => {
  const f = fixture(t);
  const ctx = { ...f.opts, notifyImpl: async () => ({ delivered: 'dm' }), execFileImpl: async () => { throw new Error('powershell_failed'); } };
  const failed = await sendNotice('本文', { ...ctx, platform: 'win32' });
  assert.deepEqual(failed.channels.toast, { status: 'failed', error: 'powershell_failed' });
  const skipped = await sendNotice('本文', ctx);
  assert.deepEqual(skipped.channels.toast, { status: 'skipped', reason: 'non-win32' });
  fs.rmSync(path.join(f.opts.home, '.claude/autopilot'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude/autopilot'), 'blocked');
  const fileFailure = await sendNotice('本文', ctx);
  assert.equal(fileFailure.delivered, 'dm');
  assert.equal(fileFailure.channels.file.status, 'failed');
});
test('digest dry-run includes waiting section without delivery or state/ledger consumption', async t => {
  const f = fixture(t), sent = [];
  await f.call('start', { objective: '進捗' });
  const ledger = path.join(f.opts.home, '.claude/waiting-on-user.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify([{ id: 'token', title: 'トークン登録', since: '2026-10-10', nextStep: '登録する', check: { cmd: 'node check.mjs', doneWhenStdoutIncludes: 'complete' } }]));
  const before = fs.readFileSync(f.paths.state, 'utf8'), ledgerBefore = fs.readFileSync(ledger, 'utf8');
  const options = { now: new Date('2026-10-23T03:00:00Z'), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; }, checkImpl: async () => ({ stdout: 'pending' }) };
  const preview = await f.call('digest', { 'dry-run': true }, options);
  assert.match(preview.text, /user 作業待ち\n待ち 13 日: トークン登録 — 次の一手: 登録する/);
  assert.equal(fs.readFileSync(f.paths.state, 'utf8'), before);
  assert.equal(fs.readFileSync(ledger, 'utf8'), ledgerBefore);
  assert.deepEqual(sent, []);
  assert.equal(fs.existsSync(path.join(f.opts.home, '.claude/autopilot/latest-digest.md')), false);
  const completed = await f.call('digest', {}, { ...options, checkImpl: async () => ({ stdout: 'complete' }) });
  const next = await f.call('digest', {}, { ...options, now: new Date('2026-10-23T12:00:00Z') });
  assert.match(completed.text, /完了しました: トークン登録/);
  assert.doesNotMatch(next.text, /user 作業待ち|トークン登録/);
  assert.equal(sent.length, 2);
});
test('periodic DM preserves waiting action and days despite notify-kim handoff/failure rewriting', async t => {
  const f = discord(t);
  await f.call('start', { objective: '報告' });
  fs.writeFileSync(path.join(f.opts.home, '.claude/waiting-on-user.json'), JSON.stringify([{ id: 'a', title: '登録', since: '2026-10-10', nextStep: '接続して確認してください' }]));
  const result = await f.call('digest', {}, { now: new Date('2026-10-23T03:00:00Z') });
  assert.equal(f.sent[0], result.text);
  assert.match(f.sent[0], /待ち 13 日.*接続して確認してください/);
  assert.equal(fs.readFileSync(result.channels.file.path, 'utf8'), result.text);
});
test('corrupt waiting ledger never silences the digest and is recorded', async t => {
  const f = fixture(t), sent = [];
  await f.call('start', { objective: '報告' });
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude/waiting-on-user.json'), '{not json');
  const result = await f.call('digest', {}, { now: new Date('2026-10-23T03:00:00Z'), notifyImpl: async text => { sent.push(text); return { delivered: 'dm' }; } });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 'dm');
  assert.equal(sent.length, 1);
  assert.doesNotMatch(result.text, /user 作業待ち/);
  const log = fs.readFileSync(path.join(f.paths.dir, 'run.log'), 'utf8');
  assert.match(log, /waitingError/);
});
test('invalid owner config falls back to legacy delivery instead of stopping autopilot', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.opts.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.opts.home, '.claude/autopilot-owner.json'), '{broken');
  const result = await sendNotice('本文', { ...f.opts, userId: '715210673642012733', notifyImpl: async () => ({ delivered: 'dm' }) });
  assert.equal(result.delivered, 'dm');
  assert.equal(result.channels.file.status, 'written');
});
test('legacy notifier without return value is unknown; explicitly disabled DM remains disabled', async t => {
  const f = fixture(t), recipients = [];
  const result = await sendNotice('本文', { ...f.opts, userId: '', notifyImpl: async (_text, options) => { recipients.push(options.userId); } });
  assert.equal(result.delivered, 'unknown');
  assert.deepEqual(recipients, ['']);
  assert.equal(result.channels.file.status, 'written');
});

test('toast summary puts owner actions before the long objective line', () => {
  const text = `📢 定時進捗報告: ${'長い目的文'.repeat(60)}\n状態: 止まっています\n前回報告以降の周回: 0周\n判断待ち: 空室案内を送ってよいか\n\nuser 作業待ち\n待ち 13 日: ラハイナ Instagram トークン登録 — 次の一手: 貼る`;
  const summary = toastSummary(text).split('\n');
  assert.equal(summary.length, 3);
  assert.match(summary[0], /^判断待ち/);
  assert.match(summary[1], /^待ち 13 日/);
  assert.match(summary[2], /^状態:/);
  assert.ok(summary.every((line) => line.length <= 120));
});

test('toast summary falls back to the first three lines', () => {
  assert.equal(toastSummary('a\nb\nc\nd'), 'a\nb\nc');
});

test('Jev 失敗・不正応答・未検証 COMPLETE は既存の続行に戻る', async t => {
  for (const response of [{ ok: false, reason: 'timeout' }, { ok: true, answers: { action: { type: 'choice', choice: 'COMPLETE' } } }, { ok: true, answers: {} }, null]) {
    const f = fixture(t, { askJevImpl: async () => response });
    await f.call('start', { objective: 'test' });
    const result = await f.call('post', { summary: 'work', progress: 10 });
    assert.equal(result.status, 'running'); assert.equal(result.jevDecision, null);
  }
  const f = fixture(t, { askJevImpl: async () => { throw new Error('offline'); } });
  await f.call('start', { objective: 'test' });
  assert.equal((await f.call('post', { summary: 'work', progress: 10 })).status, 'running');
});
test('Jev の続行・やり直し・停止を保存して次の pre へ渡す', async t => {
  for (const action of ['CONTINUE', 'RETRY', 'ESCALATE']) {
    const f = fixture(t, { askJevImpl: async request => {
      assert.equal(request.timeoutMs, 3000); assert.equal(request.label, 'autopilot');
      assert.deepEqual(Object.keys(request.questions.action.criteria), ['CONTINUE', 'RETRY', 'ESCALATE', 'COMPLETE']);
      return { ok: true, answers: { action: { type: 'choice', choice: action } } };
    } });
    await f.call('start', { objective: 'test' });
    const result = await f.call('post', { summary: 'work', progress: 10 });
    assert.equal(result.status, action === 'ESCALATE' ? 'paused' : 'running');
    assert.equal((await f.call('pre')).jevDecision.action, action);
  }
});
test('決定論的な完了・テスト失敗・noop・上限では Jev を呼ばない', async t => {
  let calls = 0;
  const f = fixture(t, { askJevImpl: async () => { calls++; return { ok: false }; } });
  await f.call('start', { objective: 'test', 'max-iter-per-day': 3 });
  assert.equal((await f.call('post', { summary: 'tests failed', progress: 100, tests: 'failed', evidence: 'bad' })).error, 'tests_failed');
  assert.equal((await f.call('post', { summary: 'tests failed', progress: 10, tests: 'failed' })).status, 'running');
  assert.equal((await f.call('post', { summary: 'no diff', progress: 10, noop: true })).status, 'running');
  assert.equal((await f.call('post', { summary: 'work', progress: 20 })).watchdog.reason, 'daily_iter_cap');
  const done = fixture(t, { askJevImpl: async () => { calls++; return { ok: false }; } });
  await done.call('start', { objective: 'test' });
  assert.equal((await done.call('post', { summary: 'done', progress: 100, evidence: 'verified' })).status, 'done');
  assert.equal(calls, 0);
});
