import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  executionPlan, makeIndex, mergeEnvFile, missingDeclaredKeys, PRESERVE_LOCAL_KEYS,
  shouldRunKeys, keySyncIsStale, updateRepositoryFiles,
} from './onboarding-sync.mjs';
import { gitBlobSha } from './version-drift.mjs';

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
function runAsync(f, extraArgs = [], envOverrides = {}, forced = true) {
  const url = `data:text/markdown;base64,${source.toString('base64')}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...(forced ? ['--force'] : []), ...extraArgs, `--target=${f.target}`], {
      env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_ONBOARDING_URL: url, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_REPO: path.join(f.home, 'absent'), ...envOverrides },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('--keys-only runs only key provisioning', () => {
  assert.deepEqual(executionPlan(['--keys-only']), { syncRepository: false, provisionKeys: true, syncRules: false });
});

test('default execution plan retains repository, keys, and rules sync', () => {
  assert.deepEqual(executionPlan([]), { syncRepository: true, provisionKeys: true, syncRules: true });
});

test('key guard skips at 19 hours and runs at 21 hours', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  assert.equal(shouldRunKeys({ lastRunAt: '2026-09-05T17:00:00.000Z' }, now), false);
  assert.equal(shouldRunKeys({ lastRunAt: '2026-09-05T15:00:00.000Z' }, now), true);
});

test('key guard runs when state file has no prior success', () => {
  assert.equal(shouldRunKeys(null, new Date('2026-09-06T12:00:00.000Z')), true);
});

test('keyserve failure alert treats a success 48h ago or no success as stale', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  assert.equal(keySyncIsStale({ last: '2026-09-04T12:00:01.000Z' }, now), false);
  assert.equal(keySyncIsStale({ last: '2026-09-04T12:00:00.000Z' }, now), true);
  assert.equal(keySyncIsStale(null, now), true);
});

test('HTTP 500 is alerted even after a recent successful key sync', async (t) => {
  const f = setup(null);
  fs.writeFileSync(path.join(f.home, '.claude', '.keys-sync-state.json'), `${JSON.stringify({ last: new Date().toISOString(), lastRunAt: new Date().toISOString() })}\n`);
  const server = http.createServer((_request, response) => {
    response.writeHead(500).end('failed');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await runAsync(f, [], {
    ORGIAST_KEYSERVE_SECRET: 'test-only-secret',
    ORGIAST_KEYSERVE_URL: `http://127.0.0.1:${port}/keys`,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /keyserve .*HTTP status: 500/);
});

test('missing every keyserve secret is alerted instead of returning silently', async () => {
  const f = setup(null);
  const result = await runAsync(f);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /keyserve .*HTTP status: 不明/);
});

test('a throttled key sync is alerted when the last success is over 48h old', async () => {
  const f = setup(null);
  fs.writeFileSync(path.join(f.home, '.claude', '.keys-sync-state.json'), `${JSON.stringify({
    last: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
    lastRunAt: new Date().toISOString(),
  })}\n`);
  const result = await runAsync(f, [], {}, false);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /keyserve .*HTTP status: 不明/);
});

test('missingDeclaredKeys lists declared files absent locally', () => {
  const present = new Set(['cost-reporter.env']);
  assert.deepEqual(
    missingDeclaredKeys({ 'fleet-sheet.env': 'x', 'cost-reporter.env': 'y' }, (name) => present.has(name)),
    ['fleet-sheet.env'],
  );
});

test('missingDeclaredKeys is empty when every declared file exists', () => {
  assert.deepEqual(missingDeclaredKeys({ 'fleet-sheet.env': 'x' }, () => true), []);
});

test('--keys-only keyserve failure is silent and never stops the session', () => {
  const f = setup(null);
  const result = spawnSync(process.execPath, [script, '--keys-only', '--force'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORGIAST_HOME: f.home,
      ORGIAST_KEYSERVE_SECRET: 'test-only-secret',
      ORGIAST_KEYSERVE_URL: 'http://127.0.0.1:9/unreachable',
      ORGIAST_REPO: path.join(f.home, 'absent'),
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('PowerShell hook retains self-update and invokes keys-only sync', () => {
  const ps1 = fs.readFileSync(path.join(path.dirname(script), 'onboarding-sync.ps1'));
  assert.deepEqual([...ps1.subarray(0, 3)], [239, 187, 191]);
  const text = ps1.toString('utf8');
  assert.match(text, /Get-FileHash -LiteralPath \$selfUpdateSource -Algorithm SHA256/);
  assert.match(text, /Copy-Item -LiteralPath \$selfUpdateSource -Destination \$selfUpdateTarget -Force/);
  assert.match(text, /& node \$keysSync --keys-only/);
});

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

test('successful pull at main does not call zip fallback', async () => {
  const f = repositoryFixture();
  const git = (args) => args.includes('rev-list') ? '0\n' : '';
  const result = await updateRepositoryFiles(f.repo, { git, getZipRoot: f.getZipRoot, emit: (line) => f.output.push(line) });
  assert.equal(result.method, 'pull'); assert.equal(result.behind, 0); assert.equal(f.zipCalls(), 0);
});

test('successful pull 78 commits behind main falls back to zip', async () => {
  const f = repositoryFixture();
  const git = (args) => args.includes('rev-list') ? '78\n' : '';
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.equal(result.method, 'zip'); assert.equal(result.behind, 78); assert.equal(f.zipCalls(), 1);
  assert.match(f.output.join('\n'), /main へ未到達\(78コミット遅れ\)。zip で更新します/);
});

test('fetch failure after successful pull falls back to zip', async () => {
  const f = repositoryFixture();
  const git = (args) => { if (args.includes('fetch')) throw new Error('offline'); return ''; };
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.equal(result.method, 'zip'); assert.equal(result.behind, null); assert.equal(f.zipCalls(), 1);
  assert.match(f.output.join('\n'), /main 到達確認に失敗: offline/);
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
  assert.match(f.output.join('\n'), /人の変更を保護: 1件/);
  assert.match(f.output.join('\n'), /保護のため未更新 1件（tools\/changed\.mjs）/);
  assert.doesNotMatch(f.output.join('\n'), /保護のため未更新[^\n]*tools\/added\.mjs/);
  assert.match(f.output.join('\n'), /commit するまで配布が届きません/);
});

function historyGit(status, versions = {}, options = {}) {
  return (args) => {
    if (args.includes('pull')) throw new Error('dirty tree');
    if (args.includes('status')) return status;
    if (args.includes('rev-list')) {
      if (options.revListFails) throw new Error('origin/main unavailable');
      const rel = args.at(-1);
      return Object.hasOwn(versions, rel) ? 'commit-a\n' : '';
    }
    if (args.includes('rev-parse')) {
      const rel = args.at(-1).slice('commit-a:'.length);
      return `${gitBlobSha(Buffer.from(versions[rel]))}\n`;
    }
    return '';
  };
}

test('modified file matching a main history version is updated', async () => {
  const f = repositoryFixture();
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, historyGit(' M tools/changed.mjs\0', { 'tools/changed.mjs': 'old' })));
  assert.deepEqual(result.excluded, []);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'new');
  assert.match(f.output.join('\n'), /旧配布版と一致したため更新 1件/);
});

test('modified file absent from main history stays protected and is named', async () => {
  const f = repositoryFixture();
  fs.writeFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'human work');
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, historyGit(' M tools/changed.mjs\0')));
  assert.deepEqual(result.excluded, ['tools/changed.mjs']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'human work');
  assert.match(f.output.join('\n'), /保護のため未更新 1件（tools\/changed\.mjs）/);
});

test('untracked file skips history lookup and is always protected', async () => {
  const f = repositoryFixture();
  fs.writeFileSync(path.join(f.repo, 'tools', 'added.mjs'), 'old untracked');
  let historyCalls = 0;
  const base = historyGit('?? tools/added.mjs\0', { 'tools/added.mjs': 'old untracked' });
  const git = (args) => { if (args.includes('rev-list') || args.includes('rev-parse')) historyCalls++; return base(args); };
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.deepEqual(result.excluded, ['tools/added.mjs']);
  assert.equal(historyCalls, 0);
});

test('rev-list failure protects modified files without throwing', async () => {
  const f = repositoryFixture();
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, historyGit(' M tools/changed.mjs\0', {}, { revListFails: true })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.excluded, ['tools/changed.mjs']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'old');
});

test('CRLF-only difference from a main history version is treated as old distribution', async () => {
  const f = repositoryFixture();
  fs.writeFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'line 1\r\nline 2\r\n');
  const git = historyGit(' M tools/changed.mjs\0', { 'tools/changed.mjs': 'line 1\nline 2\n' });
  const result = await updateRepositoryFiles(f.repo, fallbackOptions(f, git));
  assert.deepEqual(result.excluded, []);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'changed.mjs'), 'utf8'), 'new');
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
  assert.match(f.output.at(-2), /人の変更を保護: 0件/);
  assert.match(f.output.at(-2), /前回の自分の出力なので更新: 2件/);
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

// Child-process fetch stub: exercises the real CLI and filesystem without network access.
function runEnrollFixture(t, { primary = '', enroll = 'opaque-enroll-token', legacy = 'legacy-test', status = 200,
  files = { 'keyserve.env': 'ORGIAST_KEYSERVE_SECRET=new-primary\n' }, body, network = false, writeFailure = false, unlinkFailure = false } = {}) {
  const f = setup(null);
  t.after(() => fs.rmSync(f.home, { recursive: true, force: true }));
  const claude = path.join(f.home, '.claude');
  for (const [name, key, value] of [['keyserve.env', 'ORGIAST_KEYSERVE_SECRET', primary], ['enroll.env', 'ORGIAST_ENROLL_TOKEN', enroll], ['cost-reporter.env', 'DISCORD_COST_WEBHOOK', legacy]]) {
    if (value) fs.writeFileSync(path.join(claude, name), `${key}=${value}\n`);
  }
  if (writeFailure) fs.mkdirSync(path.join(claude, 'keyserve.env'));
  const stub = path.join(f.home, 'mock.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs';
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (p) => { if (${unlinkFailure} && String(p).endsWith('enroll.env')) throw new Error('denied'); return unlink(p); };
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://keyserve.test/keys') throw new Error('unexpected network');
      fs.writeFileSync(${JSON.stringify(path.join(f.home, 'request.json'))}, JSON.stringify(options.headers));
      if (${network}) throw new Error('network failure: opaque-enroll-token');
      return new Response(JSON.stringify(${JSON.stringify(body ?? { files })}), { status: ${status} });
    };`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, script, '--keys-only', '--force'], {
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_KEYSERVE_URL: 'https://keyserve.test/keys' },
  });
  assert.equal(result.status, 0, result.stderr);
  const headers = JSON.parse(fs.readFileSync(path.join(f.home, 'request.json'), 'utf8'));
  const logs = fs.existsSync(path.join(claude, 'hooks', 'onboarding-sync.log')) ? fs.readFileSync(path.join(claude, 'hooks', 'onboarding-sync.log'), 'utf8') : '';
  assert.ok(!`${result.stdout}${result.stderr}${logs}`.includes('opaque-enroll-token'));
  return { f, claude, headers };
}

test('primary takes precedence over enroll without an enroll header', async (t) => {
  const { headers } = runEnrollFixture(t, { primary: 'primary-test' });
  assert.equal(headers['x-orgiast-enroll'], undefined);
  const { createHmac } = await import('node:crypto');
  assert.equal(headers['x-orgiast-auth'], createHmac('sha256', 'primary-test').update(headers['x-orgiast-ts']).digest('hex'));
});
test('enroll takes precedence over legacy and signs the timestamp with the opaque token', async (t) => {
  const { headers, claude } = runEnrollFixture(t);
  assert.equal(headers['x-orgiast-enroll'], 'opaque-enroll-token');
  const { createHmac } = await import('node:crypto');
  assert.equal(headers['x-orgiast-auth'], createHmac('sha256', 'opaque-enroll-token').update(headers['x-orgiast-ts']).digest('hex'));
  assert.equal(fs.existsSync(path.join(claude, 'enroll.env')), false);
  assert.match(fs.readFileSync(path.join(claude, 'keyserve.env'), 'utf8'), /new-primary/);
});
for (const [label, options] of Object.entries({
  unauthorized: { status: 401 }, expired: { status: 401, body: { error: 'enroll_token_expired' } },
  network: { network: true }, 'missing primary payload': { files: { 'kimi-api.env': 'KEY=test' } },
  'empty primary': { files: { 'keyserve.env': 'ORGIAST_KEYSERVE_SECRET=\n' } },
  'write failure': { writeFailure: true }, 'invalid response': { body: {} },
})) {
  test(`enroll is retained on ${label}`, (t) => {
    const { claude } = runEnrollFixture(t, options);
    assert.equal(fs.existsSync(path.join(claude, 'enroll.env')), true);
    if (label === 'expired') assert.equal(JSON.parse(fs.readFileSync(path.join(claude, '.enroll-result.json'))).kind, 'expired');
  });
}
test('enroll deletion failure never stops key synchronization', (t) => {
  const { claude } = runEnrollFixture(t, { unlinkFailure: true });
  assert.equal(fs.existsSync(path.join(claude, 'enroll.env')), true);
  assert.match(fs.readFileSync(path.join(claude, 'keyserve.env'), 'utf8'), /new-primary/);
});
test('legacy authentication remains unchanged when primary and enroll are absent', async (t) => {
  const { headers } = runEnrollFixture(t, { enroll: '' });
  assert.equal(headers['x-orgiast-enroll'], undefined);
  const { createHmac } = await import('node:crypto');
  assert.equal(headers['x-orgiast-auth'], createHmac('sha256', 'legacy-test').update(headers['x-orgiast-ts']).digest('hex'));
});

test('the next sync automatically uses the received primary without an enroll header', async (t) => {
  const { f } = runEnrollFixture(t);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(f.home, 'mock.mjs')).href, script, '--keys-only', '--force'], {
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_KEYSERVE_URL: 'https://keyserve.test/keys' },
  });
  assert.equal(result.status, 0);
  const headers = JSON.parse(fs.readFileSync(path.join(f.home, 'request.json'), 'utf8'));
  assert.equal(headers['x-orgiast-enroll'], undefined);
  const { createHmac } = await import('node:crypto');
  assert.equal(headers['x-orgiast-auth'], createHmac('sha256', 'new-primary').update(headers['x-orgiast-ts']).digest('hex'));
});
