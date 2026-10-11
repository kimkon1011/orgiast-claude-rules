import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// リポジトリ直下の実体（.git / node_modules を除く）。git に依存せず readdir で取る。
function topLevelEntries() {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    .map((entry) => entry.name);
}

function listFiles(dir, predicate) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
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
