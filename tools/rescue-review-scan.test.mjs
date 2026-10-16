import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRescueBranches } from './rescue-review-scan.mjs';

// import.meta.url からスクリプトのディレクトリを求める。
// 手組みの file:// 剥がしは POSIX で先頭スラッシュまで削れて path.resolve が cwd 相対になり、
// パスが二重化して MODULE_NOT_FOUND になる(Windows では C:/ が残るため再現しない)。
function dirOf(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

// 回帰ガード: 求めたスクリプトパスは絶対パスで実在し、cwd を変えても変わらない。
// 旧実装は POSIX で cwd を前置して二重化した(Linux CI でのみ再現)。
test('dirOf の解決結果は絶対パスで実在し cwd に依存しない', t => {
  const before = dirOf(import.meta.url);
  assert.ok(path.isAbsolute(before), `not absolute: ${before}`);
  assert.ok(fs.existsSync(path.join(before, 'rescue-review-scan.mjs')));
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(os.tmpdir());
  assert.equal(dirOf(import.meta.url), before);
});

// 実 git を叩く既定実装と同じシグネチャ (dir, args) の関数。
function realGit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fixture(t, { featureBranch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-review-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
  git('add', '.');
  git('commit', '-m', 'base');

  // rescue/u1: a.txt を x に変更
  git('checkout', '-b', 'rescue/u1', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-m', 'u1 change');
  git('checkout', 'main');

  // rescue/u2: u1 と同一変更(内容が同じなのでパッチが一致し duplicate になる)
  git('checkout', '-b', 'rescue/u2', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-m', 'u2 same change');
  git('checkout', 'main');

  // rescue/cov: main と同一位置(変更コミット無し)
  git('branch', 'rescue/cov', 'main');

  // rescue/u3: b.txt を新規追加
  git('checkout', '-b', 'rescue/u3', 'main');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new');
  git('add', '.');
  git('commit', '-m', 'u3 add b');
  git('checkout', 'main');

  // feat/f1: u3 と同一変更(別名の枝に保全されている = covered-by-branch の材料)
  if (featureBranch) {
    git('checkout', '-b', 'feat/f1', 'main');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new');
    git('add', '.');
    git('commit', '-m', 'f1 same as u3');
    git('checkout', 'main');
  }

  return { root, repo, git };
}

const byBranch = list => Object.fromEntries(list.map(b => [b.branch, b]));

test('unique / duplicate / covered を分類し、元の変更だけを unique に残す', t => {
  const f = fixture(t);
  const m = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }));

  assert.equal(m['rescue/u1'].status, 'unique');
  assert.equal(m['rescue/u2'].status, 'duplicate');
  assert.equal(m['rescue/u2'].duplicateOf, 'rescue/u1');
  assert.equal(m['rescue/cov'].status, 'covered');
  assert.equal(m['rescue/u3'].status, 'unique');

  // 変更行数の集計
  assert.equal(m['rescue/u1'].files, 1);
  assert.equal(m['rescue/u1'].added, 1);
  assert.equal(m['rescue/u1'].deleted, 1);
  assert.equal(m['rescue/u3'].files, 1);
  assert.equal(m['rescue/u3'].added, 1);
  assert.equal(m['rescue/u3'].deleted, 0);

  // fingerprint は 16進64文字で、同一変更は一致する
  assert.match(m['rescue/u1'].fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(m['rescue/u1'].fingerprint, m['rescue/u2'].fingerprint);
});

test('戻り値はブランチ名昇順', t => {
  const f = fixture(t);
  const names = scanRescueBranches({ repo: f.repo, main: 'main' }).map(b => b.branch);
  assert.deepEqual(names, ['rescue/cov', 'rescue/u1', 'rescue/u2', 'rescue/u3']);
  assert.deepEqual(names, [...names].sort());
});

test('git 失敗は該当枝だけ status=error にし、例外を外に出さない', t => {
  const f = fixture(t);
  const stub = (dir, args) => {
    if (args.includes('main...rescue/u2')) throw new Error('boom: synthetic git failure');
    return realGit(dir, args);
  };
  let result;
  assert.doesNotThrow(() => {
    result = scanRescueBranches({ repo: f.repo, main: 'main', git: stub });
  });
  const m = byBranch(result);
  assert.equal(m['rescue/u2'].status, 'error');
  assert.match(m['rescue/u2'].error, /boom/);
  assert.equal(m['rescue/u1'].status, 'unique');
  assert.equal(m['rescue/u3'].status, 'unique');
});

test('CLI --json は summary を正しく出す', t => {
  const f = fixture(t);
  const script = path.join(dirOf(import.meta.url), 'rescue-review-scan.mjs');
  const out = execFileSync(process.execPath, [script, '--repo', f.repo, '--main', 'main', '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.summary.unique, 2);
  assert.equal(parsed.summary.duplicate, 1);
  assert.equal(parsed.summary.covered, 1);
  assert.equal(parsed.summary.coveredByBranch, 0);
  assert.equal(parsed.summary.error, 0);
  assert.equal(parsed.summary.total, 4);
  assert.equal(parsed.branches.length, 4);
});

test('CLI 既定出力はサマリ行を先頭に出す', t => {
  const f = fixture(t);
  const script = path.join(dirOf(import.meta.url), 'rescue-review-scan.mjs');
  const out = execFileSync(process.execPath, [script, '--repo', f.repo, '--main', 'main'], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'unique: 2 / duplicate: 1 / covered: 1 / covered-by-branch: 0 / error: 0');
  assert.equal(lines.length, 5);
});

test('別名の枝(feat/*)に同一変更があれば covered-by-branch に落とし unique を減らす', t => {
  const f = fixture(t, { featureBranch: true });
  const m = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }));

  assert.equal(m['rescue/u3'].status, 'covered-by-branch');
  assert.equal(m['rescue/u3'].coveredBy, 'feat/f1');
  // 別名の枝に保全済みなので unique は u1 だけになる
  assert.equal(m['rescue/u1'].status, 'unique');
  assert.equal(m['rescue/u2'].status, 'duplicate');
  assert.equal(m['rescue/cov'].status, 'covered');
});

test('compareRefs を空にすると照合せず unique に戻る', t => {
  const f = fixture(t, { featureBranch: true });
  const m = byBranch(scanRescueBranches({ repo: f.repo, main: 'main', compareRefs: [] }));
  assert.equal(m['rescue/u3'].status, 'unique');
});

test('照合先の git 失敗は握りつぶし、rescue 側の分類を壊さない', t => {
  const f = fixture(t, { featureBranch: true });
  const stub = (dir, args) => {
    if (args.length === 2 && args[0] === 'diff' && args[1] === 'main...feat/f1') {
      throw new Error('boom: synthetic compare-ref failure');
    }
    return realGit(dir, args);
  };
  const m = byBranch(scanRescueBranches({ repo: f.repo, main: 'main', git: stub }));
  assert.equal(m['rescue/u1'].status, 'unique');
  assert.equal(m['rescue/u2'].status, 'duplicate');
  assert.equal(m['rescue/cov'].status, 'covered');
  // 照合側が失敗した枝は covered-by-branch にならず unique のまま残る
  assert.equal(m['rescue/u3'].status, 'unique');
});

test('CLI --no-compare-refs は照合を切り、サマリに covered-by-branch を出す', t => {
  const f = fixture(t, { featureBranch: true });
  const script = path.join(dirOf(import.meta.url), 'rescue-review-scan.mjs');
  const withRefs = JSON.parse(execFileSync(process.execPath, [script, '--repo', f.repo, '--main', 'main', '--json'], { encoding: 'utf8' }));
  assert.equal(withRefs.summary.coveredByBranch, 1);
  assert.equal(withRefs.summary.unique, 1);
  const without = execFileSync(process.execPath, [script, '--repo', f.repo, '--main', 'main', '--no-compare-refs'], { encoding: 'utf8' });
  assert.equal(without.trim().split('\n')[0], 'unique: 2 / duplicate: 1 / covered: 1 / covered-by-branch: 0 / error: 0');
});
