import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./backup-claude-to-drive.ps1', import.meta.url), 'utf8');

function parseExcludeDirs(text) {
  const match = text.match(/\$excludeDirs = @\(([\s\S]*?)\)/);
  assert.ok(match, '$excludeDirs の配列定義が見つからない');
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

test('$excludeDirs は再生成可能なキャッシュとブラウザプロファイルの揮発ディレクトリを除外する', () => {
  const dirs = parseExcludeDirs(source);
  for (const name of [
    'cache', 'shell-snapshots', 'statsig', '__pycache__', 'ide', 'node_modules', '.git',
    'Network', 'Sessions', 'Sessions_Encrypted', 'GPUPersistentCache', 'GPUCache', 'Code Cache',
    'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache',
  ]) {
    assert.ok(dirs.includes(name), `${name} が $excludeDirs に無い`);
  }
  assert.equal(new Set(dirs).size, dirs.length, '$excludeDirs に重複がある');
});

test('DryRun の plan ログの excludedDirs= は $excludeDirs の実際の一覧と一致する', () => {
  const dirs = parseExcludeDirs(source);
  const plan = source.match(/plan robocopy=[^\r\n]*/);
  assert.ok(plan, 'plan robocopy のログ行が見つからない');
  const logged = plan[0].match(/excludedDirs=(.*?) (?=[A-Za-z]+=)/);
  assert.ok(logged, 'plan ログに excludedDirs= が無い');
  assert.deepEqual(logged[1].split(','), dirs);
});
