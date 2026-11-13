import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eligible, verifyAction, processAction, appendWeekly, executeAction, safePath, buildPrompt, runCycle, atomicWrite, askOnce } from './tetsuko-growth-loop.mjs';
const now = new Date('2026-11-05T00:00:00Z');
const action = (extra = {}) => ({ id: 'A01', title: '事実集を作る', instructions: '事実を記載', executor: 'llm', routes: ['llm-ask:gemini', 'llm-ask:deepseek'], outputs: ['data/marketing/facts.md'], verify: { type: 'file_contains', path: 'data/marketing/facts.md', text: '用途' }, status: 'todo', ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-v4-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const messages = new Map();
  const inbox = async (_home, item) => { if (!messages.has(item.dedupeKey)) messages.set(item.dedupeKey, { ...item, id: `ki-${messages.size}` }); return messages.get(item.dedupeKey); };
  return { root, home: root, now, actions: [], inbox, messages, spawn: () => { throw new Error('unexpected_spawn'); } };
}
test('ordered selection excludes done/closed, requires done (not closed), and future deferred', () => {
  const list = [action({ status: 'done' }), action({ id: 'closed', status: 'closed' }), action({ id: 'B', requires: ['A01'] }), action({ id: 'C', requires: ['closed'] }), action({ id: 'D', requires: ['missing'] }), action({ id: 'E', status: 'deferred', retryAt: '2026-11-06' }), action({ id: 'F', status: 'waiting' })];
  assert.deepEqual(eligible(list, now).map(a => a.id), ['B', 'F']);
});
test('verification: exact 200 and text, browser UA, files, strict booleans, Gmail flag', async t => {
  const ctx = fixture(t), a = action();
  assert.equal(await verifyAction(a, ctx.root), false);
  atomicWrite(path.join(ctx.root, a.outputs[0]), '用途: 保管');
  assert.equal(await verifyAction(a, ctx.root), true);
  a.verify = { type: 'url_contains', url: 'https://example.com', text: '用途' };
  for (const [status, text, expected] of [[200, '用途', true], [201, '用途', false], [404, '用途', false], [200, 'other', false]]) {
    assert.equal(await verifyAction(a, ctx.root, async (_url, options) => { assert.match(options.headers['User-Agent'], /Mozilla/); return { status, text: async () => text }; }), expected);
  }
  assert.equal(await verifyAction(a, ctx.root, async () => { throw new Error('offline'); }), false);
  for (const type of ['manual_flag', 'gmail_query']) {
    a.verify = { type, ...(type === 'manual_flag' ? { flag: 'ok' } : { query: '通知' }) };
    const flag = type === 'manual_flag' ? 'ok' : 'verified_A01';
    atomicWrite(path.join(ctx.root, 'data/marketing/flags.json'), JSON.stringify({ [flag]: 'true' }));
    assert.equal(await verifyAction(a, ctx.root), false);
    atomicWrite(path.join(ctx.root, 'data/marketing/flags.json'), JSON.stringify({ [flag]: true }));
    assert.equal(await verifyAction(a, ctx.root), true);
  }
});
test('failures advance one route, exhausted asks once, waiting only verifies, completion requires verify', async t => {
  const ctx = fixture(t), a = action();
  let calls = 0; ctx.execute = () => { calls++; return { ok: false, reason: 'offline' }; };
  await processAction(a, ctx); assert.equal(a.routeIndex, 1); assert.equal(a.attempts, 1);
  await processAction(a, ctx); assert.equal(a.status, 'waiting'); assert.equal(a.routeIndex, 2);
  await processAction(a, ctx); assert.equal(calls, 2); assert.equal(ctx.messages.size, 1);
  assert.match([...ctx.messages.values()][0].text, /次に試す案/);
  atomicWrite(path.join(ctx.root, a.outputs[0]), '用途');
  await processAction(a, ctx); assert.equal(a.status, 'done'); assert.equal(calls, 2);
  assert.equal(a.history.length, 4);
});
test('inbox dedupe key survives missing askId after a crash', async t => {
  const ctx = fixture(t), a = action();
  await askOnce(a, '確認', ctx); delete a.askId;
  await askOnce(a, '確認', ctx); assert.equal(ctx.messages.size, 1);
});
test('exit 75 preserves attempts and route and parses retryAt', async t => {
  const ctx = fixture(t), a = action({ executor: 'codex', routes: ['codex-do', 'cheap-code'] });
  ctx.spawn = (_bin, args) => {
    for (const flag of ['--cwd', '--origin', '--timeout', '--no-fallback', '--prompt-file']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--timeout') + 1], '1800');
    return { status: 75, stdout: 'log\n{"retryAt":"2026-11-07T00:00:00Z"}\n' };
  };
  await processAction(a, ctx);
  assert.equal(a.status, 'deferred'); assert.equal(a.attempts, 0); assert.equal(a.routeIndex, 0);
  assert.equal(a.retryAt, '2026-11-07T00:00:00.000Z');
  assert.deepEqual(eligible([a], now), []);
});
test('LLM provider is explicit, fallback disabled, prohibited route never spawns', t => {
  const ctx = fixture(t), a = action(); let calls = 0;
  ctx.spawn = (_bin, args) => { calls++; assert.ok(args.includes('--no-fallback')); assert.ok(args.includes('gemini')); return { status: 0, stdout: '用途: 倉庫' }; };
  assert.equal(executeAction(a, ctx).ok, true);
  assert.equal(fs.readFileSync(path.join(ctx.root, a.outputs[0]), 'utf8'), '用途: 倉庫');
  a.routes = ['claude-gmail-drive-mcp']; assert.equal(executeAction(a, ctx).ok, false); assert.equal(calls, 1);
});
test('cheap-code uses its supported CLI; successful subprocess alone is not done', async t => {
  const ctx = fixture(t), a = action({ executor: 'codex', routes: ['cheap-code'] });
  ctx.spawn = (_bin, args) => { assert.match(args[0], /cheap-code/); assert.ok(args.includes('--cwd')); assert.ok(!args.includes('--timeout')); return { status: 0, stdout: '' }; };
  await processAction(a, ctx); assert.equal(a.status, 'waiting'); assert.equal(a.lastError, 'verification_failed');
});
test('external actions cannot execute even if queued as codex', async t => {
  const ctx = fixture(t), a = action({ executor: 'codex', instructions: 'SNS に投稿する' });
  ctx.execute = () => { assert.fail('must not execute'); };
  await processAction(a, ctx); assert.equal(a.status, 'waiting'); assert.equal(ctx.messages.size, 1);
});
test('weekly caps three, ignores similar titles, resets injected state, guards external sending', () => {
  const backlog = { actions: [action()] };
  const added = appendWeekly(backlog, [action({ title: '事実集を作る！' }), action({ title: 'SNS公開', instructions: '製品紹介を投稿する', status: 'done', askId: 'fake', id: 'fake' }), action({ title: 'アクセス解析改善' }), action({ title: '問い合わせフォーム改善' }), action({ title: '動画撮影' })], '2026-11-09');
  assert.equal(added.length, 3); assert.equal(added[0].executor, 'human-or-browser');
  assert.equal(added[0].status, 'todo'); assert.equal(added[0].askId, undefined); assert.notEqual(added[0].id, 'fake');
});
test('input bodies from explicit inputs/dependencies are included; output and path escapes excluded', t => {
  const ctx = fixture(t), a = action({ inputs: ['data/marketing/source.md'], instructions: '資料を読む' });
  atomicWrite(path.join(ctx.root, 'data/marketing/source.md'), '確認済みの用途');
  assert.match(buildPrompt(a, ctx.root, []), /確認済みの用途/);
  for (const p of ['../secret', '/tmp/file', '.git/config', 'data/.env', 'C:\\secret']) assert.throws(() => safePath(ctx.root, p));
  fs.symlinkSync(os.tmpdir(), path.join(ctx.root, 'link'));
  assert.throws(() => safePath(ctx.root, 'link/secret'));
});
test('dry-run is read only, first action A01, no subprocess/network/inbox', async t => {
  const ctx = fixture(t);
  atomicWrite(path.join(ctx.root, 'data/marketing/backlog.json'), JSON.stringify({ actions: [action()] }));
  const result = await runCycle({ ...ctx, dryRun: true, tetsukoDir: ctx.root });
  assert.equal(result.selected[0].id, 'A01'); assert.equal(ctx.messages.size, 0);
  assert.equal(fs.existsSync(path.join(ctx.home, '.claude')), false);
});

test('weekly runs only Monday Tokyo time, uses metrics, and runs once per day', async t => {
  const { weekly } = await import('./tetsuko-growth-loop.mjs');
  const ctx = fixture(t), backlog = { actions: [] };
  atomicWrite(path.join(ctx.root, 'data/marketing/weekly-metrics.md'), '受注: 計測済み');
  let calls = 0;
  ctx.spawn = (_bin, args) => {
    calls++; assert.ok(args.includes('--no-fallback'));
    const prompt = fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8');
    assert.match(prompt, /受注: 計測済み/);
    return { status: 0, stdout: JSON.stringify([action({ title: '顧客に案内', instructions: 'メールを送信する', executor: 'codex' })]) };
  };
  assert.deepEqual(await weekly(backlog, ctx), []); assert.equal(calls, 0);
  ctx.now = new Date('2026-11-08T15:00:00Z');
  const added = await weekly(backlog, ctx); assert.equal(added.length, 1); assert.equal(added[0].executor, 'human-or-browser');
  await weekly(backlog, ctx); assert.equal(calls, 1);
});
test('codex cannot self-approve flags or rewrite queue state', t => {
  const ctx = fixture(t), a = action({ executor: 'codex', routes: ['codex-do'] });
  const flags = path.join(ctx.root, 'data/marketing/flags.json');
  atomicWrite(flags, '{}');
  ctx.spawn = () => { atomicWrite(flags, '{"approved":true}'); return { status: 0, stdout: '' }; };
  assert.equal(executeAction(a, ctx).reason, 'executor_modified_control_files');
  assert.equal(fs.readFileSync(flags, 'utf8'), '{}');
});
test('multiple LLM outputs are validated together and written to declared paths', t => {
  const ctx = fixture(t), outputs = ['data/marketing/one.md', 'data/marketing/two.md'];
  const a = action({ outputs });
  ctx.spawn = () => ({ status: 0, stdout: JSON.stringify({ [outputs[0]]: '用途', [outputs[1]]: '事実' }) });
  assert.equal(executeAction(a, ctx).ok, true);
  for (const p of outputs) assert.ok(fs.existsSync(path.join(ctx.root, p)));
});
