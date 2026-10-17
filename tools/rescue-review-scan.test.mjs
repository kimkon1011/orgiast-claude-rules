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

function fixture(t, { featureBranch = false, squashedMerge = false, cherryPickedFirst = false, ignoredArtifact = false } = {}) {
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

  if (ignoredArtifact) {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.stall-sweeper/\n');
    git('add', '.gitignore');
    git('commit', '-m', 'ignore runtime artifacts');
    git('checkout', '-b', 'rescue/ignored', 'main');
    fs.mkdirSync(path.join(repo, '.stall-sweeper'));
    fs.writeFileSync(path.join(repo, '.stall-sweeper', 'probe.evidence.md'), 'runtime evidence\n');
    git('add', '-f', '.stall-sweeper/probe.evidence.md');
    git('commit', '-m', 'rescue ignored artifact');
    git('checkout', 'main');
  }

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

  if (squashedMerge) {
    git('checkout', '-b', 'rescue/squashed', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'squashed');
    git('add', '.');
    git('commit', '-m', 'squashed change');
    git('checkout', 'main');
    git('merge', '--squash', 'rescue/squashed');
    git('commit', '-m', 'squash merged');
  }
  if (cherryPickedFirst) {
    git('checkout', '-b', 'rescue/partial', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'p1');
    git('add', '.');
    git('commit', '-m', 'partial first');
    const first = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'c.txt'), 'p2');
    git('add', '.');
    git('commit', '-m', 'partial second');
    git('checkout', 'main');
    git('cherry-pick', first);
  }

  return { root, repo, git };
}

const byBranch = list => Object.fromEntries(list.map(b => [b.branch, b]));

test('枝を切った後に squash-merge された枝は covered(already-upstream) になる', t => {
  const { repo } = fixture(t, { squashedMerge: true });
  assert.notEqual(realGit(repo, ['diff', 'main...rescue/squashed']), '');
  const m = byBranch(scanRescueBranches({ repo, main: 'main' }));
  assert.equal(m['rescue/squashed'].status, 'covered');
  assert.equal(m['rescue/squashed'].reason, 'already-upstream');
  assert.equal(m['rescue/cov'].reason, 'no-commits');
  assert.equal(m['rescue/u1'].status, 'unique');
  assert.equal(m['rescue/u2'].status, 'duplicate');
  assert.equal(m['rescue/u3'].status, 'unique');
  assert.equal(m['rescue/cov'].status, 'covered');
  assert.equal(m['rescue/squashed'].files, 1);
  assert.match(m['rescue/squashed'].fingerprint, /^[0-9a-f]{64}$/);
});

test('一部だけ取り込み済みの枝は unique のままになる', t => {
  const { repo } = fixture(t, { cherryPickedFirst: true });
  assert.match(realGit(repo, ['cherry', 'main', 'rescue/partial']), /^\+ /m);
  const m = byBranch(scanRescueBranches({ repo, main: 'main' }));
  assert.equal(m['rescue/partial'].status, 'unique');
});

test('cherry の失敗や空出力は既存の分類にフォールバックする', t => {
  const { repo } = fixture(t);
  for (const fail of [true, false]) {
    const git = (dir, args) => {
      if (args[0] === 'cherry') {
        if (fail) throw new Error('cherry failed');
        return '';
      }
      return realGit(dir, args);
    };
    const m = byBranch(scanRescueBranches({ repo, main: 'main', git }));
    assert.equal(m['rescue/u1'].status, 'unique');
    assert.equal(m['rescue/u2'].status, 'duplicate');
    assert.equal(m['rescue/u3'].status, 'unique');
    assert.equal(m['rescue/cov'].status, 'covered');
    assert.equal(Object.hasOwn(m['rescue/u1'], 'reason'), false);
  }
});

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
  assert.equal(lines[0], 'unique: 2 / duplicate: 1 / covered: 1 / covered-by-branch: 0 / covered-in-main: 0 / error: 0 / ignored-only: 0');
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
  assert.equal(without.trim().split('\n')[0], 'unique: 2 / duplicate: 1 / covered: 1 / covered-by-branch: 0 / covered-in-main: 0 / error: 0 / ignored-only: 0');
});

test('gitignore 済みの実行時成果物だけの枝は ignored-only になる', t => {
  const f = fixture(t, { ignoredArtifact: true });
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }))['rescue/ignored'];
  assert.equal(b.status, 'ignored-only');
  assert.deepEqual(b.ignoredFiles, ['.stall-sweeper/probe.evidence.md']);
});

test('ignoreCheck=false なら ignored-only 判定を切って unique に戻る', t => {
  const f = fixture(t, { ignoredArtifact: true });
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main', ignoreCheck: false }))['rescue/ignored'];
  assert.equal(b.status, 'unique');
});

test('実行時成果物と通常ファイルが混在する枝は unique のまま', t => {
  const f = fixture(t, { ignoredArtifact: true });
  f.git('checkout', '-b', 'rescue/mixed', 'main');
  fs.mkdirSync(path.join(f.repo, '.stall-sweeper'));
  fs.writeFileSync(path.join(f.repo, '.stall-sweeper', 'x.md'), 'runtime\n');
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'normal\n');
  f.git('add', 'b.txt');
  f.git('add', '-f', '.stall-sweeper/x.md');
  f.git('commit', '-m', 'mixed rescue');
  f.git('checkout', 'main');
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }))['rescue/mixed'];
  assert.equal(b.status, 'unique');
});

test('CLI は ignored-only を JSON と既定サマリに出す', t => {
  const f = fixture(t, { ignoredArtifact: true });
  const script = path.join(dirOf(import.meta.url), 'rescue-review-scan.mjs');
  const args = [script, '--repo', f.repo, '--main', 'main'];
  const json = JSON.parse(execFileSync(process.execPath, [...args, '--json'], { encoding: 'utf8' }));
  assert.equal(json.summary.ignoredOnly, 1);
  const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(out.trim().split('\n')[0], /ignored-only: 1/);
});

// 同じ共通祖先から rescue のドラフトと main の改訂版を別々に作る。
function supersededFixture(t, { novel = false, retainDeleted = false, missingFile = false } = {}) {
  const f = fixture(t);
  const write = text => fs.writeFileSync(path.join(f.repo, 'mode.js'), text);
  const commit = message => { f.git('add', '.'); f.git('commit', '-m', message); };
  write('legacyMode();\n');
  commit('legacy mode');
  f.git('checkout', '-b', 'rescue/draft');
  const shared = ['function nativeSandboxMode() {', 'const mode = "native";', 'record(mode);', 'return mode;', '}'];
  write(shared.join('\n') + '\n');
  commit('draft mode');
  f.git('checkout', 'main');
  if (missingFile) f.git('rm', 'mode.js');
  else write((retainDeleted ? 'legacyMode();\n' : '') + (novel ? 'unrelatedFeature();\n' : shared.join('\n') + '\nrecordLaneMode();\n'));
  commit('revised main mode');
  return f;
}

test('main が同じ箇所を改訂済みなら covered-in-main に分類する', t => {
  const f = supersededFixture(t);
  assert.notEqual(f.git('diff', 'main...rescue/draft'), '');
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }))['rescue/draft'];
  assert.equal(b.status, 'covered-in-main');
  assert.equal(b.coveredInMain.addedRatio, 1);
  assert.equal(b.coveredInMain.deletedStillInMainRatio, 0);
  const script = path.join(dirOf(import.meta.url), 'rescue-review-scan.mjs');
  const args = [script, '--repo', f.repo, '--main', 'main'];
  const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(out, /covered-in-main: 1/);
  assert.ok(out.includes('covered-in-main\trescue/draft\t1\t5+/1-\t(added 5/5 in main, deleted 0/1 still in main)'));
  const json = JSON.parse(execFileSync(process.execPath, [...args, '--json'], { encoding: 'utf8' }));
  assert.equal(json.summary.coveredInMain, 1);
});

test('追加行が main に存在しない新規機能は unique のまま', t => {
  const f = supersededFixture(t, { novel: true });
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }))['rescue/draft'];
  assert.equal(b.status, 'unique');
  assert.equal(b.coveredInMain, undefined);
});

test('追加行が main にあっても削除行が残存すれば unique のまま', t => {
  const f = supersededFixture(t, { retainDeleted: true });
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }))['rescue/draft'];
  assert.equal(b.status, 'unique');
});

test('変更ファイルが main に存在しなければ unique に残す', t => {
  const f = supersededFixture(t, { missingFile: true });
  const b = byBranch(scanRescueBranches({ repo: f.repo, main: 'main' }))['rescue/draft'];
  assert.equal(b.status, 'unique');
});
