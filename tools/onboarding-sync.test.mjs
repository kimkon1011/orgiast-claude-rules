import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeIndex, mergeEnvFile, PRESERVE_LOCAL_KEYS, updateRepositoryFiles } from './onboarding-sync.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onboarding-sync.mjs');
const source = Buffer.from('# 見出し\r\n最初の文。二番目。\r\n本文\r\n🔴 絶対ルール全文\r\n## 次\r\n説明だけ\r\n🛑 上限規定', 'utf8');
function setup(initial) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-sync-'));
  const target = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (initial !== null) fs.writeFileSync(target, initial);
  return { home, target };
}
function run(f, extraArgs = [], envOverrides = {}) {
  const url = `data:text/markdown;base64,${source.toString('base64')}`;
  return spawnSync(process.execPath, [script, '--force', ...extraArgs, `--target=${f.target}`], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_ONBOARDING_URL: url, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_REPO: path.join(f.home, 'absent'), ...envOverrides } });
}

test('preserves bytes outside existing markers', () => {
  const before = Buffer.from('個人\r\n<!-- BEGIN: オージャスト共通ルール (自動同期 2026-01-01) -->\r\n旧本文\r\n<!-- END: オージャスト共通ルール -->\r\n末尾\r\n');
  const f = setup(before); assert.equal(run(f).status, 0);
  const updated = fs.readFileSync(f.target);
  assert.ok(updated.subarray(0, Buffer.byteLength('個人\r\n')).equals(Buffer.from('個人\r\n')));
  assert.ok(updated.subarray(updated.length - Buffer.byteLength('\r\n末尾\r\n')).equals(Buffer.from('\r\n末尾\r\n')));
});
test('stores fetched onboarding byte-for-byte', () => {
  const f = setup(null); run(f);
  assert.ok(fs.readFileSync(path.join(f.home, '.claude', 'orgiast-onboarding.md')).equals(source));
});
test('removes the legacy rules path', () => {
  const f = setup(null);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f).status, 0); assert.equal(fs.existsSync(oldPath), false);
});
test('removes the legacy rules path even when synchronized content is unchanged', () => {
  const f = setup(null); assert.equal(run(f).status, 0);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f).status, 0); assert.equal(fs.existsSync(oldPath), false);
});
test('dry-run does not remove the legacy rules path', () => {
  const f = setup(null);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f, ['--dry-run']).status, 0); assert.equal(fs.existsSync(oldPath), true);
});
test('moves the legacy file instead of losing it when the fetch fails', () => {
  const f = setup(null);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  const newPath = path.join(f.home, '.claude', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f, [], { ORGIAST_ONBOARDING_URL: 'https://127.0.0.1:9/absent' }).status, 0);
  assert.equal(fs.existsSync(oldPath), false);
  assert.ok(fs.readFileSync(newPath).equals(source));
});
test('index lead points to the non-auto-loaded path', () => {
  const lead = makeIndex(source.toString('utf8')).split('\n')[0];
  assert.match(lead, /~\/.claude\/orgiast-onboarding\.md/);
  assert.doesNotMatch(lead, /~\/.claude\/rules\//);
  assert.match(lead, /自動ロードされない/);
  assert.match(lead, /Read ツール/);
});
test('index retains critical emoji lines', () => {
  const f = setup(null); run(f); const output = fs.readFileSync(f.target, 'utf8');
  assert.match(output, /🔴 絶対ルール全文/); assert.match(output, /🛑 上限規定/); assert.doesNotMatch(output, /二番目/);
});
test('two runs are idempotent', () => {
  const f = setup('外側\n'); run(f); const once = fs.readFileSync(f.target); run(f); const twice = fs.readFileSync(f.target);
  assert.ok(once.equals(twice));
});
test('CLAUDE.md without markers is preserved and receives one block', () => {
  const f = setup(Buffer.from('個人ルール\r\nそのまま', 'utf8')); run(f); const output = fs.readFileSync(f.target, 'utf8');
  assert.ok(output.startsWith('個人ルール\r\nそのまま')); assert.equal((output.match(/BEGIN: オージャスト共通ルール/g) || []).length, 1);
});

test('mergeEnvFile updates distributed keys and preserves local values and layout', () => {
  const existing = '# PC specific\r\nDISCORD_COST_WEBHOOK=dummy-old\r\nREPORTER_LABEL=local-pc\r\nLOCAL_ONLY=keep-me\r\n';
  const incoming = 'DISCORD_COST_WEBHOOK=dummy-new\nREPORTER_LABEL=central-label\nNEW_SHARED=dummy-value\n';
  assert.equal(
    mergeEnvFile(existing, incoming, PRESERVE_LOCAL_KEYS),
    '# PC specific\r\nDISCORD_COST_WEBHOOK=dummy-new\r\nREPORTER_LABEL=local-pc\r\nLOCAL_ONLY=keep-me\r\nNEW_SHARED=dummy-value\r\n',
  );
});

test('mergeEnvFile returns identical text when effective values do not change', () => {
  const existing = '# keep\nexport SHARED = "dummy-value"\nREPORTER_LABEL=local-pc\n';
  const incoming = 'SHARED=dummy-value\nREPORTER_LABEL=central-label\n';
  assert.equal(mergeEnvFile(existing, incoming), existing);
});

function repositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-repo-'));
  const repo = path.join(root, 'repo');
  const archive = path.join(root, 'archive');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(archive, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools', 'changed.mjs'), 'old');
  fs.writeFileSync(path.join(archive, 'tools', 'changed.mjs'), 'new');
  fs.writeFileSync(path.join(archive, 'tools', 'added.mjs'), 'added');
  const output = [];
  let zipCalls = 0;
  const getZipRoot = async () => { zipCalls++; return { root: archive }; };
  const fallbackStatePath = path.join(root, '.claude', 'onboarding-sync-fallback.json');
  return { repo, archive, output, getZipRoot, fallbackStatePath, zipCalls: () => zipCalls };
}

function fallbackOptions(f, git, emit = (line) => f.output.push(line)) {
  return { git, getZipRoot: f.getZipRoot, emit, fallbackStatePath: f.fallbackStatePath };
}

test('successful pull does not call zip fallback', async () => {
  const f = repositoryFixture();
  const result = await updateRepositoryFiles(f.repo, { git: () => '', getZipRoot: f.getZipRoot, emit: (line) => f.output.push(line) });
  assert.equal(result.method, 'pull'); assert.equal(f.zipCalls(), 0);
});

test('failed pull falls back to zip and updates tools', async () => {
  const f = repositoryFixture();
  const git = (args) => { if (args.includes('pull')) throw new Error('diverged'); return ''; };
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.equal(result.method, 'zip');
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'utf8'), 'added');
});

test('zip fallback preserves modified and untracked files and reports their names', async () => {
  const f = repositoryFixture();
  fs.writeFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'local work');
  fs.writeFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'local untracked');
  const git = (args) => {
    if (args.includes('pull')) throw new Error('dirty tree');
    return ' M tools/changed.mjs\0?? tools/added.mjs\0';
  };
  await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'local work');
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'utf8'), 'local untracked');
  assert.match(f.output.join('\n'), /人の変更を保護: 2件/);
});

test('status failure writes no files', async () => {
  const f = repositoryFixture();
  const git = (args) => { throw new Error(args.includes('status') ? 'git missing' : 'pull failed'); };
  const result = await updateRepositoryFiles(f.repo, { git, getZipRoot: f.getZipRoot, emit: (line) => f.output.push(line) });
  assert.equal(result.ok, false); assert.equal(f.zipCalls(), 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.repo, 'tools', 'added.mjs')), false);
});

test('complete failure emits the visible distribution warning on one line', async () => {
  const f = repositoryFixture();
  const git = (args) => { if (args.includes('pull')) throw new Error('pull failed'); return ''; };
  const result = await updateRepositoryFiles(f.repo, {
    git, getZipRoot: async () => { throw new Error('zip failed\nmore detail'); }, emit: (line) => f.output.push(line),
  });
  assert.equal(result.ok, false); assert.equal(f.output.length, 1);
  assert.match(f.output[0], /⚠/); assert.match(f.output[0], /配布が届いていません/); assert.doesNotMatch(f.output[0], /more detail/);
});

test('two zip fallback runs do not rewrite already-current files', async () => {
  const f = repositoryFixture();
  const git = (args) => { if (args.includes('pull')) throw new Error('diverged'); return ''; };
  await updateRepositoryFiles(f.repo, fallbackOptions(f, git, () => {}));
  const target = path.join(f.repo, 'tools', 'changed.mjs');
  const firstMtime = fs.statSync(target).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await updateRepositoryFiles(f.repo, fallbackOptions(f, git, () => {}));
  assert.equal(second.changed, false);
  assert.equal(fs.statSync(target).mtimeMs, firstMtime);
});

test('two fallback runs do not mistake previous zip output for human changes', async () => {
  const f = repositoryFixture();
  let run = 0;
  const git = (args) => {
    if (args.includes('pull')) throw new Error('diverged');
    return run++ === 0 ? '' : ' M tools/changed.mjs\0?? tools/added.mjs\0';
  };
  const first = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  fs.writeFileSync(path.join(f.archive, 'tools', 'changed.mjs'), 'newer');
  const second = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.equal(first.excluded.length, 0); assert.equal(second.excluded.length, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'newer');
  assert.match(f.output.at(-1), /人の変更を保護: 0件/);
  assert.match(f.output.at(-1), /前回の自分の出力なので更新: 2件/);
});

test('human edit after fallback remains protected on the next run', async () => {
  const f = repositoryFixture();
  const cleanGit = (args) => { if (args.includes('pull')) throw new Error('diverged'); return ''; };
  await updateRepositoryFiles(f.repo, fallbackOptions(f, cleanGit));
  fs.writeFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'human edit');
  fs.writeFileSync(path.join(f.archive, 'tools', 'changed.mjs'), 'newer');
  const dirtyGit = (args) => { if (args.includes('pull')) throw new Error('diverged'); return ' M tools/changed.mjs\0'; };
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, dirtyGit));
  assert.deepEqual(result.excluded, ['tools/changed.mjs']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'human edit');
});

test('untracked file absent from fallback state remains protected', async () => {
  const f = repositoryFixture();
  fs.writeFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'human untracked');
  const git = (args) => { if (args.includes('pull')) throw new Error('diverged'); return '?? tools/added.mjs\0'; };
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.deepEqual(result.excluded, ['tools/added.mjs']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'utf8'), 'human untracked');
});

test('corrupt fallback state protects every reported file', async () => {
  const f = repositoryFixture();
  fs.mkdirSync(path.dirname(f.fallbackStatePath), { recursive: true });
  fs.writeFileSync(f.fallbackStatePath, '{broken');
  fs.writeFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'keep added');
  const git = (args) => { if (args.includes('pull')) throw new Error('diverged'); return ' M tools/changed.mjs\0?? tools/added.mjs\0'; };
  await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'utf8'), 'keep added');
});

test('fallback state is refreshed with hashes of copied files', async () => {
  const f = repositoryFixture();
  const git = (args) => { if (args.includes('pull')) throw new Error('diverged'); return ''; };
  await updateRepositoryFiles(f.repo, { ...fallbackOptions(f, git), now: new Date('2026-08-30T00:00:00.000Z') });
  const first = JSON.parse(fs.readFileSync(f.fallbackStatePath, 'utf8'));
  assert.match(first.files['tools/changed.mjs'], /^[a-f0-9]{64}$/);
  assert.equal(first.updatedAt, '2026-08-30T00:00:00.000Z');
  fs.writeFileSync(path.join(f.archive, 'tools', 'changed.mjs'), 'newer');
  await updateRepositoryFiles(f.repo, { ...fallbackOptions(f, git), now: new Date('2026-08-31T00:00:00.000Z') });
  const second = JSON.parse(fs.readFileSync(f.fallbackStatePath, 'utf8'));
  assert.notEqual(second.files['tools/changed.mjs'], first.files['tools/changed.mjs']);
  assert.equal(second.updatedAt, '2026-08-31T00:00:00.000Z');
});
