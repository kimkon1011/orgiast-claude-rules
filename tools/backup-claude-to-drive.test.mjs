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

test('local-fallback: $localFallback 変数が定義されている', () => {
  assert.ok(source.includes('$localFallback'), '$localFallback が見つからない');
});

test('local-fallback: 既定の退避先は D:\\claude-backups', () => {
  const match = source.match(/\$localBackupDir = if \(\$env:CLAUDE_BACKUP_LOCAL_DIR\) \{ \$env:CLAUDE_BACKUP_LOCAL_DIR \} else \{ '([^']+)' \}/);
  assert.ok(match, 'CLAUDE_BACKUP_LOCAL_DIR のフォールバックパターンが見つからない');
  assert.equal(match[1], 'D:\\claude-backups');
});

test('local-fallback: local-fallback=ok のログ行がある', () => {
  assert.ok(source.includes("local-fallback=ok"), 'local-fallback=ok のログ行が見つからない');
});

test('local-fallback: ローテーション（Remove-Item）を新規追加していない（Drive/rclone パスのみ）', () => {
  // retention 削除は既存の Drive パスと rclone パスのみ — local fallback ブロックに Remove-Item が無いことを確認する
  const localFallbackBlock = source.match(/if \(\$localFallback\) \{([\s\S]*?)\} elseif \(\$useRclone\)/);
  assert.ok(localFallbackBlock, 'local-fallback ブロックが見つからない');
  const block = localFallbackBlock[1];
  // ディレクトリ作成 (New-Item) と zip コピー (Copy-Item) は許容するが Remove-Item は禁止
  assert.ok(!block.includes('Remove-Item'), 'local-fallback 内に Remove-Item が見つかる（ローテーション禁止）');
});

test('local-fallback: 不存ドライブなら従来どおり失敗（Stop-DriveNotAvailable にフォールスルー）する', () => {
  const match = source.match(/localFallback = \$false[\s\S]*?Stop-DriveNotAvailable/);
  assert.ok(match, 'ドライブ不在時の Stop-DriveNotAvailable へのフォールスルーが見つからない');
});
