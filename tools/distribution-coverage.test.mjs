import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 配布対象の単一定義 tools/distribution-manifest.json が、リポジトリの実体と
// 各スクリプト・ドキュメントの参照を覆っているかを検査する。
// ここが崩れると「配布先PCで動かないファイル」が静かに増える。

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(toolsDir);
const manifestPath = path.join(toolsDir, 'distribution-manifest.json');

const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// notDistributed は { name: { reason, runtimeRefOk?, docRefOk? } } 形式。
// キーは完全一致の名前か、'PROMPT-*.md' のような glob を取り得る。
const notDistributedEntries = (manifest) => Object.entries(manifest.notDistributed ?? {});

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesNotDistributed(manifest, name) {
  return notDistributedEntries(manifest).some(([pattern]) => globToRegExp(pattern).test(name));
}

// git が「未追跡かつ .gitignore 済み」と判定した最上位項目名を、ls-files の
// NUL 区切り出力から取り出す。'Microsoft/' のようなディレクトリは末尾の '/' を落として
// 先頭セグメントだけを名前として扱う（純関数にしてテストから直接呼べるようにする）。
function rootNamesFromIgnoredList(stdout) {
  return new Set(
    String(stdout)
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/, '').split('/')[0]),
  );
}

// $env:LOCALAPPDATA 未設定の PowerShell が repo 直下に掘る /Microsoft/ のような
// マシンローカルな環境ノイズは、リポジトリの一部ではないので分類対象から外す。
// 追跡済みの項目は返らない（--others は未追跡のみ）ため、本来の配布対象は影響を受けない。
function ignoredTopLevelNames(root = repoRoot) {
  try {
    // --others: 未追跡のみ / --ignored --exclude-standard: .gitignore で無視されたもの
    // --directory: 中身に降りず最上位名だけ（node_modules 等で列挙が膨らむのを防ぐ）
    const result = spawnSync(
      'git',
      ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.status !== 0 || !result.stdout) return new Set();
    return rootNamesFromIgnoredList(result.stdout);
  } catch {
    return new Set(); // git が無い環境ではフィルタせず従来どおり判定する
  }
}

// リポジトリ直下の実体（.git / node_modules / gitignore 済みの環境ノイズを除く）。
// 列挙は readdir のままにする: git 追跡外の“本物の”新規項目は今まで通り「未分類」として
// 拾いたいので、git ls-files による列挙には切り替えない。
function topLevelEntries() {
  const ignored = ignoredTopLevelNames();
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules' && !ignored.has(entry.name))
    .map((entry) => entry.name);
}

function listFiles(dir, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // テストファイルは別プロセスで並行実行される。drive-hub-mirror.test.mjs は
    // tools/drive_mirror_test_repo_* を作って消すため、走査中に消えたディレクトリは
    // 無かったものとして扱う（CI で ENOENT になる flake の防止）。
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(target, predicate);
    return entry.isFile() && predicate(entry.name) ? [target] : [];
  });
}

test('(a) manifest は JSON として読め dirs/files/notDistributed を持つ', () => {
  const manifest = readManifest();
  assert.equal(manifest.version, 1, 'version は 1');
  assert.ok(Array.isArray(manifest.dirs) && manifest.dirs.length > 0, 'dirs は非空配列');
  assert.ok(Array.isArray(manifest.files), 'files は配列');
  assert.ok(manifest.notDistributed && typeof manifest.notDistributed === 'object', 'notDistributed はオブジェクト');
  for (const [name, value] of notDistributedEntries(manifest)) {
    assert.ok(value && typeof value === 'object', `notDistributed.${name} はオブジェクト`);
    assert.equal(typeof value.reason, 'string', `notDistributed.${name}.reason は文字列`);
    for (const flag of ['runtimeRefOk', 'docRefOk']) {
      if (flag in value) assert.equal(typeof value[flag], 'boolean', `notDistributed.${name}.${flag} は真偽値`);
    }
  }
});

test('(b) リポジトリ直下の全項目が dirs/files/notDistributed のどれかに分類されている', () => {
  const manifest = readManifest();
  const dirs = new Set(manifest.dirs);
  const files = new Set(manifest.files);
  const unclassified = topLevelEntries().filter(
    (name) => !dirs.has(name) && !files.has(name) && !matchesNotDistributed(manifest, name),
  );
  assert.deepEqual(
    unclassified,
    [],
    `未分類のトップレベル項目: ${unclassified.join(', ')}\n` +
      'tools/distribution-manifest.json の dirs / files / notDistributed のどれかに入れてください',
  );
});

// tools/*.mjs と tools/*.ps1 が参照するトップレベルディレクトリを抽出する。
// 対象は「リポジトリ直下の実在ディレクトリ」への参照のみ。
function referencedTopLevelDirs() {
  const dirs = new Set(fs.readdirSync(repoRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  const found = new Map(); // dir -> [file:line]
  const record = (dir, file, line) => {
    if (!dirs.has(dir)) return;
    if (!found.has(dir)) found.set(dir, []);
    found.get(dir).push(`${path.relative(repoRoot, file)}:${line}`);
  };
  const patterns = [
    // '../<dir>/' 形式（tools から見た相対）
    /\.\.\/([A-Za-z0-9][A-Za-z0-9._-]*)\//g,
    // path.join(repo|repoRoot|REPO|root, '<dir>') 形式
    /path\.join\(\s*(?:repo|repoRoot|REPO|root|repoDir|repoPath)\s*,\s*['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]/g,
    // Join-Path $REPO '<dir>' 形式
    /Join-Path\s+\$(?:Repo|repo|REPO|Root|root)\s+['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]/g,
  ];
  for (const file of listFiles(toolsDir, (name) => name.endsWith('.mjs') || name.endsWith('.ps1'))) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) record(match[1], file, index + 1);
      }
    });
  }
  return found;
}

test('(c) tools が参照する実在トップレベルディレクトリは dirs に含まれる', () => {
  const manifest = readManifest();
  const dirs = new Set(manifest.dirs);
  const runtimeRefOk = new Set(
    notDistributedEntries(manifest)
      .filter(([, value]) => value.runtimeRefOk === true)
      .map(([name]) => name),
  );
  const missing = [];
  for (const [dir, refs] of referencedTopLevelDirs()) {
    if (dirs.has(dir) || runtimeRefOk.has(dir)) continue;
    missing.push(`${dir} (参照: ${refs.slice(0, 3).join(', ')})`);
  }
  assert.deepEqual(
    missing,
    [],
    `tools が参照しているのに dirs に無いディレクトリ:\n${missing.join('\n')}\n` +
      '配布対象なら dirs へ、実行時参照のみで配布不要なら notDistributed に runtimeRefOk:true で入れてください',
  );
});

// ONBOARDING.md / CLAUDE.md.template が参照するトップレベルディレクトリを抽出する。
function docReferencedTopLevelDirs() {
  const dirs = new Set(fs.readdirSync(repoRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  const found = new Map();
  const pattern = /(?:^|[\s(`'"[\]/])([A-Za-z0-9][A-Za-z0-9._-]*)\//g;
  for (const name of ['ONBOARDING.md', 'CLAUDE.md.template']) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const match of text.matchAll(pattern)) {
        const dir = match[1];
        if (!dirs.has(dir)) continue;
        if (!found.has(dir)) found.set(dir, []);
        found.get(dir).push(`${name}:${index + 1}`);
      }
    });
  }
  return found;
}

test('(d) ドキュメントが参照する実在トップレベルディレクトリは dirs に含まれる', () => {
  const manifest = readManifest();
  const dirs = new Set(manifest.dirs);
  const docRefOk = new Set(
    notDistributedEntries(manifest)
      .filter(([, value]) => value.docRefOk === true)
      .map(([name]) => name),
  );
  const missing = [];
  for (const [dir, refs] of docReferencedTopLevelDirs()) {
    if (dirs.has(dir) || docRefOk.has(dir)) continue;
    missing.push(`${dir} (参照: ${refs.slice(0, 3).join(', ')})`);
  }
  assert.deepEqual(
    missing,
    [],
    `ドキュメントが参照しているのに dirs に無いディレクトリ:\n${missing.join('\n')}\n` +
      '配布対象なら dirs へ、ドキュメント参照のみで配布不要なら notDistributed に docRefOk:true で入れてください',
  );
});

test('(e) 配布スクリプトは manifest を読み、直書き配列を主定義にしていない', () => {
  // 直書き配列は「manifest が壊れている時の既定値」としてのみ許す。
  // 主定義が manifest であることの条件:
  //   1. distribution-manifest.json を読んでいる
  //   2. 直書き配列は manifest 読み込みより前に現れる（＝初期値。後から manifest で上書きされる）
  //   3. manifest の値が $dirs / $files に代入されている（読むだけで使っていない、を弾く）
  const hardcoded = /@\(\s*'tools'\s*,\s*'rules-extracted'\s*,\s*'skills'/;
  const assignsFromManifest = /\$dirs\s*=\s*\$d\b[\s\S]{0,80}?\$files\s*=\s*\$f\b/;
  for (const name of ['install-orgiast.ps1', 'onboarding-sync.ps1']) {
    const file = path.join(toolsDir, name);
    const source = fs.readFileSync(file, 'utf8');
    const manifestRead = source.indexOf("Join-Path $root 'tools/distribution-manifest.json'");
    assert.ok(manifestRead >= 0, `${name} が distribution-manifest.json を読んでいない`);
    assert.ok(
      assignsFromManifest.test(source),
      `${name} が manifest の dirs/files を配布対象として採用していない（読むだけで使っていない）`,
    );
    const hardcodedMatch = hardcoded.exec(source);
    if (hardcodedMatch) {
      // 直書き配列が manifest 読み込みより後にあるなら、それが主定義になっている＝違反。
      assert.ok(
        hardcodedMatch.index < manifestRead,
        `${name} の直書き配列が manifest 読み込みより後にある（manifest が主定義になっていない）`,
      );
    }
  }
});

// ls-files -z の出力解析は純関数なので、実リポジトリの状態に依存せず検証できる。
test('(f) ls-files の NUL 区切り出力から最上位項目名を取り出す', () => {
  assert.deepEqual(
    [...rootNamesFromIgnoredList('Microsoft/\0.wt/\0codex-rule1.log\0')].sort(),
    ['Microsoft', '.wt', 'codex-rule1.log'].sort(),
  );
  assert.deepEqual([...rootNamesFromIgnoredList('nested/keep/inside/\0')], ['nested']);
  assert.deepEqual([...rootNamesFromIgnoredList('plain.txt\0')], ['plain.txt']);
  assert.deepEqual([...rootNamesFromIgnoredList('')], []);
});

// (b) が環境ノイズで偽赤にならないことの回帰テスト。
// 使い捨てリポジトリで「.gitignore 済みは除外・未追跡の新規項目は残る」を実測する。
test('(g) gitignore 済みの最上位項目は除外され、未追跡の新規項目は残る', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-cov-'));
  try {
    const init = spawnSync('git', ['-C', tmp, 'init', '-q'], { encoding: 'utf8' });
    assert.equal(init.status, 0, 'git init に失敗（git が無い環境ではこのテストを実行できない）');
    fs.mkdirSync(path.join(tmp, 'noise'));
    fs.mkdirSync(path.join(tmp, 'newdir'));
    fs.writeFileSync(path.join(tmp, '.gitignore'), '/noise/\n', 'utf8');

    const ignored = ignoredTopLevelNames(tmp);
    assert.ok(ignored.has('noise'), '.gitignore 済みの noise が除外対象に入っていない');
    assert.ok(!ignored.has('newdir'), '未追跡でも .gitignore されていない newdir を除外してはいけない');
    assert.ok(!ignored.has('.git'), '追跡対象外の .git は除外名に含めない（列挙側で別途除く）');
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // 一時ディレクトリの後始末失敗はテスト結果に影響しない
    }
  }
});
