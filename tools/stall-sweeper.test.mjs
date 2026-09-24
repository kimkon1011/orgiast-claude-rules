import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectUncommitted, detectOpenPr, detectStaleBranch, detectOpenTodo, detectFailedJob, detectStalledSession,
  detectUnverifiedDelegation, consecutiveFailures, escalate, parseArgs, advanceUncommitted, advanceDelegated,
  inspectRepo, command, acquireLock, releaseLock } from './stall-sweeper.mjs';
const now = Date.parse('2026-09-22T00:00:00Z'), day = 86400000;
const ago = n => new Date(now - n * day).toISOString();
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stall-sweeper-test-'));

test('未コミット: 2日の境界、新しい変更混在、削除日時不明', () => {
  const repos = [ { repo: '/a', changes: [{ mtimeMs: now - 2 * day }] }, { repo: '/b', changes: [{ mtimeMs: now }] },
    { repo: '/c', changes: [{ mtimeMs: now - 3 * day }, { mtimeMs: now }] }, { repo: '/d', changes: [{ mtimeMs: null }] } ];
  const found = detectUncommitted(repos, now);
  assert.equal(found.length, 2); assert.equal(found[0].safe, true); assert.equal(found[1].safe, false);
});
test('PR: 全CI成功・非draft・競合なし・1日経過のみ。チェック空も除外', () => {
  const p = { url: 'https://github.com/o/r/pull/1', number: 1, title: '修正', updatedAt: ago(2), mergeable: 'MERGEABLE', isDraft: false,
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  assert.equal(detectOpenPr([p], now)[0].humanRequired, true);
  for (const delta of [{ isDraft: true }, { mergeable: 'UNKNOWN' }, { mergeable: 'CONFLICTING' }, { updatedAt: ago(0.5) },
    { statusCheckRollup: [] }, { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }])
    assert.equal(detectOpenPr([{ ...p, ...delta }], now).length, 0);
});
test('古いブランチ: mainとマージ済みは除外', () => {
  const b = { repo: '/r', name: 'work', date: ago(7), merged: false };
  assert.equal(detectStaleBranch([b, { ...b, merged: true }, { ...b, name: 'main' }, { ...b, date: ago(6) }], now).length, 1);
});
test('TODO: チェックボックスと既存handoff番号付きTODO、完了除外', () => {
  const f = { file: '/next-session.md', mtimeMs: now - 4 * day, text: '- [ ] 未完作業\n- [x] 完了作業\n## 残TODO\n1. 別の作業\n' };
  assert.equal(detectOpenTodo([f], now).length, 2);
  assert.equal(detectOpenTodo([{ ...f, mtimeMs: now }], now).length, 0);
  assert.equal(detectOpenTodo([{ ...f, text: '- [ ] 2026-09-21 新しい作業' }], now).length, 0);
});
test('ジョブ: 最新実行のみ、後続成功・実行中・未実行は失敗扱いしない', () => {
  const r = { taskName: 'OrgiastX', t: ago(3), status: 1 };
  assert.equal(detectFailedJob([r], now).length, 1);
  assert.equal(detectFailedJob([r, { ...r, t: ago(1), status: 0 }], now).length, 0);
  assert.equal(detectFailedJob([{ ...r, running: true }, { ...r, taskName: 'OrgiastY', status: 267011 }], now).length, 0);
});
test('会話: 最後のassistantの実行予告のみ', () => {
  const s = { sessionId: 's1', file: '/log', mtime: ago(3), lastRole: 'assistant', lastAssistantText: 'これから修正します。' };
  assert.equal(detectStalledSession([s], now).length, 1);
  for (const delta of [{ lastRole: 'user' }, { lastAssistantText: 'これから修正します。\n修正完了しました。' }, { mtime: ago(2) }])
    assert.equal(detectStalledSession([{ ...s, ...delta }], now).length, 0);
});
test('委譲: exit=0かつ対応コミットなしのみ。未確認は分ける', () => {
  const l = { file: '/codex.log', t: ago(2), exit: 0, commitVerified: false };
  assert.equal(detectUnverifiedDelegation([l, { ...l, exit: 1 }, { ...l, commitVerified: true }, { ...l, commitVerified: null }], now).length, 1);
});
test('連続失敗: 3回で停止、成功でリセット、通知や途中記録は数えない', () => {
  const c = { kind: 'failed_job', id: 'a', humanRequired: false };
  const fail = { ...c, result: '失敗' }, success = { ...c, result: '成功' };
  assert.equal(escalate(c, [fail, fail]).humanRequired, false);
  assert.equal(escalate(c, [fail, { ...fail, id: 'other' }, fail, { ...c, result: '途中' }, fail]).humanRequired, true);
  assert.equal(consecutiveFailures([fail, fail, fail, success, fail], c), 1);
});
test('CLI: dryが既定、件数検証、モード競合拒否', () => {
  assert.equal(parseArgs([]).apply, false); assert.equal(parseArgs([]).max, 5);
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  for (const n of ['0', '-1', 'NaN', '1.5']) assert.throws(() => parseArgs(['--max', n]));
});
test('排他: 同時実行を拒否、終了後に次世代を取得、削除不要', () => {
  const dir = temp(), fd = acquireLock(dir);
  assert.throws(() => acquireLock(dir)); releaseLock(fd);
  const second = acquireLock(dir); releaseLock(second);
  assert.equal(fs.readdirSync(path.join(dir, 'stall-sweeper-locks')).length, 2);
});
function fixture() {
  const base = temp(), repo = path.join(base, 'repo'), remote = path.join(base, 'remote.git');
  command('git', ['init', '--bare', remote]); command('git', ['init', '-b', 'main', repo]);
  const g = (...a) => command('git', ['-C', repo, ...a]).trim();
  g('config', 'user.name', 'Sweeper Test'); g('config', 'user.email', 'sweeper-test@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'before\n'); g('add', '-A'); g('commit', '-m', '初期化');
  g('remote', 'add', 'origin', remote); g('push', '-u', 'origin', 'main');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'after\n');
  const old = new Date(Date.now() - 3 * day); fs.utimesSync(path.join(repo, 'file.txt'), old, old);
  return { repo, g, candidate: detectUncommitted([inspectRepo(repo)])[0] };
}
test('実git: 専用ブランチに1コミット・main不変・force/merge/deleteなし', async () => {
  const { repo, g, candidate } = fixture(), before = g('rev-parse', 'main'), commands = [], log = [];
  const run = (exe, args, opts) => { commands.push([exe, ...args]); if (exe === 'gh') return args[1] === 'list' ? '[]' : 'https://github.com/test/test/pull/1'; return command(exe, args, opts); };
  const result = await advanceUncommitted(candidate, { run, log: r => log.push(r), plan: () => [[process.execPath, ['-e', 'process.exit(0)']]] });
  assert.equal(g('rev-list', '--count', 'main..HEAD'), '1'); assert.equal(g('rev-parse', 'main'), before);
  assert.equal(g('log', '-1', '--format=%H'), result.commit); assert.equal(log[0].action, 'コミット保存');
  assert.ok(commands.some(c => c.includes('create'))); assert.ok(!commands.flat().some(a => ['--force', 'merge', '--delete'].includes(a)));
  assert.equal(inspectRepo(repo).changes.length, 0);
  console.log(`実git検証（隔離fixture）: ${repo} / git log -1: ${g('log', '-1', '--format=%h %s')} / mainとの差: 1コミット`);
});
test('テスト失敗: コミット・push・PRなし', async () => {
  const { g, candidate } = fixture(), before = g('rev-parse', 'HEAD');
  await assert.rejects(advanceUncommitted(candidate, { plan: () => [[process.execPath, ['-e', 'process.exit(1)']]] }));
  assert.equal(g('rev-parse', 'HEAD'), before);
});
test('他セッションによる更新: ステージ前に停止', async () => {
  const { repo, g, candidate } = fixture(), before = g('branch', '--show-current');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'concurrent');
  await assert.rejects(advanceUncommitted(candidate)); assert.equal(g('branch', '--show-current'), before);
});
test('テストでファイル更新: コミットを停止', async () => {
  const { g, candidate } = fixture(), before = g('rev-parse', 'HEAD');
  await assert.rejects(advanceUncommitted(candidate, { plan: () => [[process.execPath, ['-e', "require('fs').writeFileSync('file.txt','changed')"]]] }));
  assert.equal(g('rev-parse', 'HEAD'), before);
});
test('委譲exit=0でも完了証拠なしなら失敗', async () => {
  const outputDir = temp();
  await assert.rejects(advanceDelegated({ id: 'x', cwd: outputDir }, { outputDir, run: () => '' }));
});

test('文字列の成功statusを失敗にしない', () => {
  for (const status of ['ok', 'success', 'fallback', 'cooldown', '0', null]) assert.equal(detectFailedJob([{ taskName: 'a', t: ago(4), status }], now).length, 0);
  for (const status of ['error', 'http_429', 'no-cheap-executor']) assert.equal(detectFailedJob([{ taskName: 'a', t: ago(4), status }], now).length, 1);
});
test('日々再生成されるTODOは初回観測を保持する', () => {
  const f = { file: '/next-actions.md', mtimeMs: now, text: '## 推奨アクション\n1. 作業を直す\n' };
  const observed = detectOpenTodo([f], now, {}, 0);
  assert.equal(observed.length, 1);
  assert.equal(detectOpenTodo([f], now, { [observed[0].id]: now - 4 * day }).length, 1);
});
test('委譲ログのテスト出力中のexit=0は実行成功の証拠にしない', async () => {
  const { parseDelegationLog } = await import('./stall-sweeper.mjs');
  assert.equal(parseDelegationLog('codex\nPASS テスト(exit=0)\n').exit, null);
  assert.equal(parseDelegationLog('codex\nexit=0\nexit=1\n').exit, 1);
  assert.equal(parseDelegationLog('workdir: /tmp/repo\n[codex-do] exit=0\n').cwd, '/tmp/repo');
  assert.equal(parseDelegationLog('{"provider":"codex","cwd":"/tmp/repo","status":0}').exit, 0);
});
test('コミット後にpush失敗しても、保存済みコミットからPR作成を再開する', async () => {
  const { candidate, g } = fixture(), rows = [];
  await assert.rejects(advanceUncommitted(candidate, { plan: () => [], log: r => rows.push(r), run: (exe, args, opts) => {
    if (args.includes('push')) throw new Error('通信失敗'); return command(exe, args, opts);
  } }));
  assert.equal(rows.length, 1);
  const result = await advanceUncommitted({ ...candidate, pending: rows[0] }, { run: (exe, args, opts) => {
    if (exe === 'gh') return args[1] === 'list' ? '[]' : 'https://github.com/test/test/pull/2'; return command(exe, args, opts);
  } });
  assert.equal(g('rev-list', '--count', 'main..HEAD'), '1'); assert.equal(result.commit, rows[0].commit);
});
test('人間の同意が必要なTODOは委譲せずhumanへ', () => {
  const f = { file: '/next-session.md', mtimeMs: now - 4 * day, text: '- [ ] OAuth初回同意を行う' };
  assert.equal(detectOpenTodo([f], now)[0].humanRequired, true);
});
test('テスト失敗の起票は同じ項目で重複作成しない', async () => {
  const { fileTestFailure } = await import('./stall-sweeper.mjs');
  const c = { id: '/repo', cwd: '/repo' }, calls = [];
  let existing = [];
  const run = (_exe, args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(existing);
    existing = [{ title: args[args.indexOf('--title') + 1], url: 'https://github.com/test/repo/issues/1' }];
    return existing[0].url;
  };
  assert.equal(fileTestFailure(c, new Error('テストが失敗'), run), existing[0].url);
  assert.equal(fileTestFailure(c, new Error('テストが失敗'), run), existing[0].url);
  assert.equal(calls.filter(c => c[1] === 'create').length, 1);
});
