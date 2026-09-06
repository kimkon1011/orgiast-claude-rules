import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideAction, decideTreeAction, extractHookTreeRoots, runSelfheal, sha256 } from './hook-tree-selfheal.mjs';

test('working === main は uptodate', () => {
  assert.equal(decideAction({ working: 'same', head: 'old', main: 'same', lastWrittenSha: null }).action, 'uptodate');
});

test('clean で main が違えば updated', () => {
  assert.equal(decideAction({ working: 'old', head: 'old', main: 'new', lastWrittenSha: null }).action, 'updated');
});

test('前回 selfheal の SHA と一致すれば updated', () => {
  assert.equal(decideAction({ working: 'written', head: 'old', main: 'new', lastWrittenSha: sha256('written') }).action, 'updated');
});

test('dirty で前回 SHA と不一致なら skipped', () => {
  assert.equal(decideAction({ working: 'mine', head: 'old', main: 'new', lastWrittenSha: sha256('other') }).action, 'skipped');
});

test('origin/main に無ければ skipped', () => {
  assert.equal(decideAction({ working: 'mine', head: 'mine', main: null, lastWrittenSha: null }).action, 'skipped');
});

test('未追跡の新規作業は skipped', () => {
  assert.equal(decideAction({ working: 'mine', head: null, main: 'upstream', lastWrittenSha: null }).action, 'skipped');
});

test('selfheal が書いた内容は2回目もさらに新しい main へ updated', () => {
  const first = decideAction({ working: 'v1', head: 'v1', main: 'v2', lastWrittenSha: null });
  assert.equal(first.action, 'updated');
  const second = decideAction({ working: 'v2', head: 'v1', main: 'v3', lastWrittenSha: sha256('v2') });
  assert.equal(second.action, 'updated');
});

for (const [name, input, action] of [
  ['clean・detached・差分あり', { dirty: false, detached: true, headSha: 'a', mainSha: 'b' }, 'tree-advanced'],
  ['clean・detached・同一', { dirty: false, detached: true, headSha: 'a', mainSha: 'a' }, 'uptodate'],
  ['dirty・detached', { dirty: true, detached: true, headSha: 'a', mainSha: 'b' }, 'per-file'],
  ['clean・ブランチ', { dirty: false, detached: false, headSha: 'a', mainSha: 'b' }, 'per-file'],
  ['dirty・ブランチ', { dirty: true, detached: false, headSha: 'a', mainSha: 'b' }, 'per-file'],
]) test(`ツリー判定: ${name} → ${action}`, () => assert.equal(decideTreeAction(input).action, action));

test('hook コマンドからリポ名に依存せず2ツリーを抽出する', () => {
  const settings = { hooks: { Stop: [{ hooks: [
    { command: 'node "C:\\Users\\uers\\orgiast-main\\tools\\stop-gate.mjs"' },
    { command: 'node "C:\\Users\\uers\\orgiast-claude-rules\\tools\\report-length-gate.mjs"' },
  ] }] } };
  const roots = extractHookTreeRoots(settings);
  assert.equal(roots.length, 2);
  assert.ok(roots.some((root) => root.endsWith('/orgiast-main') || root.endsWith('\\orgiast-main')));
  assert.ok(roots.some((root) => root.endsWith('/orgiast-claude-rules') || root.endsWith('\\orgiast-claude-rules')));
});

test('tools を含まない .claude hooks は対象外', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ command: 'powershell C:\\Users\\uers\\.claude\\hooks\\foo.ps1' }] }] } };
  assert.deepEqual(extractHookTreeRoots(settings), []);
});

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function fixture({ includeOther = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-selfheal-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  git(root, ['init', '--bare', origin]);
  git(root, ['init', '-b', 'main', seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(seed, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'tools', 'sample.mjs'), 'export const value = "old";\n');
  if (includeOther) fs.writeFileSync(path.join(seed, 'tools', 'other.mjs'), 'export const other = "old";\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'old']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', origin, repo]);
  git(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(seed, 'tools', 'sample.mjs'), 'export const value = "new";\n');
  if (includeOther) fs.writeFileSync(path.join(seed, 'tools', 'other.mjs'), 'export const other = "new";\n');
  git(seed, ['commit', '-am', 'new']);
  git(seed, ['push']);
  git(repo, ['fetch', 'origin']);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const hooks = [{ command: `node "${repo}/tools/sample.mjs"` }];
  if (includeOther) hooks.push({ command: `node "${repo}/tools/other.mjs"` });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Notification: [{ hooks }] } }));
  return { root, repo, home, ledger: path.join(home, '.claude', 'hook-selfheal-ledger.jsonl') };
}

test('統合: clean な旧版を origin/main へ更新し updated を記録する', () => {
  const f = fixture();
  try {
    runSelfheal({ repo: f.repo, home: f.home, fetch: false });
    assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'utf8'), 'export const value = "new";\n');
    const records = fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, 'updated');
    assert.equal(records[0].tree, fs.realpathSync(f.repo));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('統合: clean・detached・遅れたツリーを前進し tree-advanced を記録する', () => {
  const f = fixture();
  try {
    git(f.repo, ['checkout', '--detach', 'HEAD']);
    const from = git(f.repo, ['rev-parse', 'HEAD']).trim();
    const to = git(f.repo, ['rev-parse', 'origin/main']).trim();
    runSelfheal({ repo: f.repo, home: f.home, fetch: false });
    assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), to);
    assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'utf8'), 'export const value = "new";\n');
    const records = fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.deepEqual({ action: records[0].action, from: records[0].from, to: records[0].to }, { action: 'tree-advanced', from, to });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('統合: dirty な作業ファイルを変えず skipped を記録する', () => {
  const f = fixture({ includeOther: true });
  try {
    fs.writeFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'export const value = "mine";\n');
    runSelfheal({ repo: f.repo, home: f.home, fetch: false });
    assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'utf8'), 'export const value = "mine";\n');
    const records = fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records.find((record) => record.file === 'tools/sample.mjs').action, 'skipped');
    assert.equal(records.find((record) => record.file === 'tools/other.mjs').action, 'updated');
    assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'other.mjs'), 'utf8'), 'export const other = "new";\n');
    assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), git(f.repo, ['rev-parse', 'HEAD~0']).trim());
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
