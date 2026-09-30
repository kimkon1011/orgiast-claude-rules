import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPr, runWatch, parseArgs, notificationText } from './stale-work-watch.mjs';
import { mergePr } from './pr-merge.mjs';

// Captured with the requested gh pr list command on 2026-09-30 (stdout).
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/stale-work-watch/pr-list.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-10-10T00:00:00Z');
const old = '2026-10-01T00:00:00Z';
const base = captured.find(pr => pr.state === 'OPEN' && pr.author.login === 'kimkon1011');
function pr(overrides = {}) { return { ...structuredClone(base), updatedAt: old, ...overrides }; }
function setup(t, { prs = [], refs = '', ghFail = false, mergeFail = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-work-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = { exec: [], merge: [], notify: [] };
  const deps = {
    exec(file, args, opts) {
      assert.equal(opts.windowsHide, true);
      calls.exec.push({ file, args, opts });
      if (file === 'git' && args[0] === 'for-each-ref') return refs;
      if (file === 'gh' && args.includes('list')) { if (ghFail) throw new Error('gh unavailable'); return JSON.stringify(prs); }
      if (file === 'gh' && args[0] === 'api') return 'kimkon1011\n';
      throw new Error(`Unexpected command: ${file} ${args}`);
    },
    merge(options) {
      calls.merge.push(options);
      if (mergeFail) throw new Error('conflict');
      return { state: 'MERGED', mergedAt: new Date(now).toISOString() };
    },
    async notify(text, options) { calls.notify.push({ text, options }); return { delivered: 'dm' }; },
  };
  const write = (relative, text) => {
    const file = path.join(home, '.claude', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(old), new Date(old));
    return file;
  };
  return { home, calls, deps, write, run: options => runWatch({ home, now, ...options }, deps) };
}
test('fresh items and exactly the threshold are excluded; zero stale sends nothing', async t => {
  const f = setup(t, { prs: [pr({ updatedAt: new Date(now - 2 * 86400000).toISOString() }), pr({ updatedAt: new Date(now - 3 * 86400000).toISOString() })] });
  const result = await f.run();
  assert.equal(result.items.length, 0);
  assert.equal(f.calls.notify.length, 0);
  assert.equal(f.calls.merge.length, 0);
  assert.match(fs.readFileSync(result.reportPath, 'utf8'), /停滞なし/);
});
test('captured all-pass CheckRun data is mergeable; only own PRs advance, keeping branches', async t => {
  const f = setup(t, { prs: [pr(), pr({ author: { login: 'someone-else' } })] });
  const result = await f.run();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].category, 'mergeable');
  assert.equal(result.items[0].action, 'merged');
  assert.equal(f.calls.merge.length, 1);
  assert.equal(f.calls.merge[0].keepBranch, true);
  assert.equal(f.calls.notify.length, 0);
});
test('closed-unmerged is notified, never merged or reopened', async t => {
  const f = setup(t, { prs: [pr({ number: 375, state: 'CLOSED', mergedAt: null })] });
  const result = await f.run();
  assert.equal(result.items[0].category, 'closed-unmerged');
  assert.equal(f.calls.merge.length, 0);
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0].text, /#375/);
  assert.equal(f.calls.notify[0].options.webhookFallback, false);
  assert(!f.calls.exec.some(c => c.args.includes('reopen')));
});
test('--dry collects and writes merge plans but never merges or notifies', async t => {
  const f = setup(t, { prs: [pr(), pr({ state: 'CLOSED' })] });
  const result = await f.run({ dry: true });
  assert.equal(result.items.find(i => i.category === 'mergeable').action, 'マージ予定');
  assert.equal(f.calls.merge.length, 0);
  assert.equal(f.calls.notify.length, 0);
  assert(fs.existsSync(result.reportPath));
});
test('gh failure skips PR source while branches, TODO, sessions continue', async t => {
  const f = setup(t, { ghFail: true, refs: `topic\t${old}\t\n` });
  f.write('next-session.md', '## 残TODO\n- pending\n- ~~done~~\n- [x] done\n## Other\n- outside');
  f.write('projects/example/session.jsonl', '{}\n');
  f.write('projects/example/_deleted-backup/deleted.jsonl', '{}\n');
  const result = await f.run();
  assert.deepEqual(result.items.map(i => i.category).sort(), ['branch-stale', 'session-stale', 'todo-stale']);
  assert.match(result.errors[0], /gh unavailable/);
  assert.equal(f.calls.notify.length, 1);
});
test('classification handles failed/pending/draft/missing/unknown/legacy checks conservatively', () => {
  const check = base.statusCheckRollup[0];
  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']) {
    assert.equal(classifyPr(pr({ statusCheckRollup: [{ ...check, conclusion }] })), 'ci-failed');
  }
  for (const checks of [[], null, [{ ...check, status: 'IN_PROGRESS', conclusion: null }], [{ ...check, conclusion: 'SKIPPED' }], [{ __typename: 'Unknown', state: 'SUCCESS' }], [{ __typename: 'StatusContext', state: 'PENDING' }]]) {
    assert.equal(classifyPr(pr({ statusCheckRollup: checks })), 'ci-pending');
  }
  assert.equal(classifyPr(pr({ statusCheckRollup: [{ __typename: 'StatusContext', state: 'SUCCESS' }] })), 'mergeable');
  assert.equal(classifyPr(pr({ isDraft: true })), 'draft-stale');
  assert.equal(classifyPr(pr({ state: 'MERGED', mergedAt: old })), null);
});
test('merge failure remains in one notification alongside other stale work', async t => {
  const f = setup(t, { prs: [pr(), pr({ number: 375, state: 'CLOSED' })], mergeFail: true });
  const result = await f.run();
  assert.equal(result.items[0].action, 'merge-failed');
  assert.equal(f.calls.notify.length, 1);
  assert.match(fs.readFileSync(result.reportPath, 'utf8'), /conflict/);
});
test('branch matching excludes merged branches and default/symbolic refs', async t => {
  const f = setup(t, { prs: [pr({ headRefName: 'done', state: 'MERGED', mergedAt: old })],
    refs: ['done', 'orphan', 'main', 'HEAD'].map(n => `${n}\t${old}\t${n === 'HEAD' ? 'refs/remotes/origin/main' : ''}`).join('\n') });
  const result = await f.run({ dry: true });
  assert.deepEqual(result.items.map(i => i.title), ['orphan']);
});
test('large inventory has counts, oldest five, and complete file path within Discord limit', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ category: 'todo-stale', ageDays: i, title: `task-${i} ${'x'.repeat(400)}` }));
  const text = notificationText(items, '/home/kim/.claude/stale-work.md');
  assert.match(text, /todo-stale: 100件/);
  assert.match(text, /task-99/);
  assert(!text.includes('task-94'));
  assert.match(text, /全文: .*stale-work.md$/);
  assert(text.length < 2000);
});
test('CLI validates threshold and flags', () => {
  assert.deepEqual(parseArgs(['--dry', '--json', '--stale-days', '5']), { dry: true, json: true, staleDays: 5 });
  for (const args of [['--stale-days'], ['--stale-days', '-1'], ['--stale-days', 'NaN'], ['--bad']]) assert.throws(() => parseArgs(args));
});
test('real merge helper is repository-bound and emits no branch deletion', async t => {
  const f = setup(t, { prs: [pr()] });
  const originalExec = f.deps.exec;
  const mutations = [];
  f.deps.merge = mergePr;
  f.deps.exec = (file, args, opts) => {
    assert.equal(opts.windowsHide, true);
    if (args.includes('list') || args[0] === 'api' || file === 'git') return originalExec(file, args, opts);
    assert.deepEqual(args.slice(0, 2), ['-R', 'kimkon1011/orgiast-claude-rules']);
    if (args.includes('checks')) return JSON.stringify([{ name: 'test', bucket: 'pass' }]);
    if (args.includes('merge')) { mutations.push(args); return ''; }
    if (args.at(-1) === 'state,mergedAt') return JSON.stringify({ state: 'MERGED', mergedAt: old });
    return JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'a'.repeat(40), statusCheckRollup: base.statusCheckRollup });
  };
  await f.run();
  assert.equal(mutations.length, 1);
  assert(!mutations[0].includes('--delete-branch'));
});
test('nightly finishing path invokes watch once; install and existing bootstrap share batch target', () => {
  const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
  const batch = read('./nightly-batch.ps1');
  const finish = batch.slice(batch.indexOf('function Finish-Nightly'), batch.indexOf('\ntry {'));
  assert.match(finish, /staleWorkReady -and -not \$script:staleWorkRan/);
  assert.match(finish, /stale-work-watch\.mjs/);
  assert.match(batch, /\$script:staleWorkReady = \$true/);
  for (const file of ['./install-orgiast.ps1', './register-stalled-session-nightly.ps1']) {
    assert.match(read(file), /nightly-batch\.ps1/);
    assert.match(read(file), /nightly-bootstrap/);
  }
  assert.match(read('./nightly-bootstrap.ps1'), /fetch origin main/);
});
test('unchanged TODO ages survive unrelated file updates; edits restart age', async t => {
  const f = setup(t);
  const file = f.write('next-session.md', '## 残TODO\n- keep this\n- change this\n');
  await f.run();
  fs.writeFileSync(file, '## 残TODO\n- keep this\n- changed text\n');
  fs.utimesSync(file, new Date(now), new Date(now));
  const result = await f.run();
  assert.deepEqual(result.items.map(i => i.title), ['- keep this']);
  assert.equal(result.items[0].ageDays, 9);
});
test('notification failure is recorded in the report instead of claiming delivery', async t => {
  const f = setup(t, { prs: [pr({ state: 'CLOSED' })] });
  f.deps.notify = async () => ({ delivered: 'none', reason: 'missing token' });
  const result = await f.run();
  assert.match(result.errors.at(-1), /missing token/);
  assert.match(fs.readFileSync(result.reportPath, 'utf8'), /missing token/);
});

test('subagent logs under real session directories never count as sessions', async t => {
  const f = setup(t);
  f.write('projects/-home-kim-repo/parent-session.jsonl', '{}\n');
  const agent = f.write('projects/-home-kim-repo/parent-session/subagents/agent-abc.jsonl', '{}\n');
  f.write('projects/-home-kim-repo/parent-session/subagents/nested/agent-def.jsonl', '{}\n');
  fs.utimesSync(agent, new Date('2000-01-01'), new Date('2000-01-01'));
  const result = await f.run();
  assert.deepEqual(result.items.map(i => i.title), [path.join('-home-kim-repo', 'parent-session.jsonl')]);
  assert.deepEqual(result.inventory['session-stale'], { count: 1, oldestDays: 9 });
});

function populateInventory(f, count = 25) {
  for (let i = 0; i < count; i++) {
    const file = f.write(`projects/-home-kim-repo/session-${i}.jsonl`, '{}\n');
    const modified = new Date(now - (i + 10) * 86400000);
    fs.utimesSync(file, modified, modified);
  }
}
const inventoryRefs = count => Array.from({ length: count }, (_, i) =>
  `inventory-branch-${i}\t${new Date(now - (i + 10) * 86400000).toISOString()}\t`).join('\n');

test('large inventory alone never calls notification', async t => {
  const f = setup(t, { refs: inventoryRefs(122) });
  populateInventory(f, 187);
  const result = await f.run();
  assert.equal(result.items.length, 309);
  assert.deepEqual(result.actionable, []);
  assert.deepEqual(result.inventory, {
    'session-stale': { count: 187, oldestDays: 196 },
    'branch-stale': { count: 122, oldestDays: 131 },
  });
  assert.equal(f.calls.notify.length, 0);
  assert.equal(result.notification, null);
});

test('DM includes actionable rows and only one inventory summary with configured threshold', async t => {
  const f = setup(t, { prs: [pr({ number: 375, state: 'CLOSED', mergedAt: null })], refs: inventoryRefs(25) });
  populateInventory(f);
  const result = await f.run({ staleDays: 5 });
  assert.equal(result.actionable.length, 1);
  assert.equal(f.calls.notify.length, 1);
  const text = f.calls.notify[0].text;
  assert.match(text, /closed-unmerged #375/);
  assert(!text.includes('inventory-branch-'));
  assert(!text.includes('session-'));
  assert.equal(text.split('\n').filter(line => /セッション|ブランチ/.test(line)).length, 1);
  assert.match(text, /セッション25件（最古34.0日）・ブランチ25件（最古34.0日）が5日超停滞（詳細はファイル）/);
  assert(text.length <= 2000);
});

test('file caps each inventory category at oldest 20 and reports omitted counts', async t => {
  const f = setup(t, {
    refs: inventoryRefs(27),
    prs: Array.from({ length: 23 }, (_, i) => pr({ number: 1000 + i, state: 'CLOSED', mergedAt: null })),
  });
  populateInventory(f);
  const result = await f.run({ dry: true });
  const report = fs.readFileSync(result.reportPath, 'utf8');
  for (const [category, omitted, oldest, youngest] of [
    ['session-stale', 5, 'session-24.jsonl', 'session-5.jsonl'],
    ['branch-stale', 7, 'inventory-branch-26', 'inventory-branch-7'],
  ]) {
    const section = report.split(`## ${category}\n`)[1].split('\n## ')[0];
    assert.equal(section.split('\n').filter(line => /^- \d/.test(line)).length, 20);
    assert.match(section, new RegExp(`他${omitted}件`));
    assert(section.indexOf(oldest) < section.indexOf(youngest));
    assert(!section.includes(category === 'session-stale' ? 'session-4.jsonl' : 'inventory-branch-6 /'));
  }
  assert.equal((report.match(/#10\d\d /g) || []).length, 23);
  assert.equal(result.items.length, 75);
});

test('successful auto-merge leaves inventory silent', async t => {
  const f = setup(t, { prs: [pr()], refs: inventoryRefs(25) });
  populateInventory(f);
  const result = await f.run();
  assert.equal(f.calls.merge.length, 1);
  assert.equal(result.actionable.length, 0);
  assert.equal(f.calls.notify.length, 0);
});

test('mixed actionable categories and inventory stay within Discord limit even with a long path', () => {
  const items = ['mergeable', 'ci-failed', 'ci-pending', 'closed-unmerged', 'draft-stale', 'todo-stale', 'session-stale', 'branch-stale']
    .flatMap(category => Array.from({ length: 100 }, (_, i) => ({ category, ageDays: 100 + i, title: '長いタイトル😀'.repeat(300) })));
  for (const reportPath of ['/home/kim/.claude/stale-work.md', `/${'long-path/'.repeat(300)}stale-work.md`]) {
    assert(notificationText(items, reportPath).length <= 2000);
  }
});
