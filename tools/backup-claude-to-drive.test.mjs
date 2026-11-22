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

// ---- rclone 経路の修正 検証テスト（backup-claude-to-drive.ps1） ----

/**
 * Parse-RcloneLine のアルゴリズムを JS で再現。
 * rclone ls の1行（例: "      2352990628 claude-019-2026-11-20.zip"）を
 * パースして { name, size } を返す。空行は null。
 */
function parseRcloneLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/, 2);
  if (parts.length < 2) return null;
  return { name: parts[1].trim(), size: Number(parts[0]) };
}

/**
 * Test-RcloneBackup のサイズ照合アルゴリズムを JS で再現。
 * rclone ls 出力（複数行）と期待サイズから検証結果を返す。
 */
function simulateRcloneVerify(lines, zipName, expectedSize) {
  for (const line of lines) {
    const parsed = parseRcloneLine(line);
    if (!parsed) continue;
    if (parsed.name !== zipName) continue;
    if (expectedSize > 0 && parsed.size !== expectedSize) return false;
    return true;
  }
  return false;
}

test('Send-ToRclone の rclone コマンドは copyto を使い $ZipName を宛先に含む', () => {
  const funcStart = source.indexOf('function Send-ToRclone {');
  assert.ok(funcStart >= 0, 'Send-ToRclone 関数定義が見つからない');
  // 次の "function " までが関数本体。なければ末尾まで。
  const funcEnd = source.indexOf('\nfunction ', funcStart + 1);
  const body = source.slice(funcStart, funcEnd >= 0 ? funcEnd : undefined);

  assert.ok(body.includes('copyto'), 'rclone コマンドが copy ではなく copyto を使っている');
  assert.ok(body.includes('$ZipName'), 'copyto の宛先に $ZipName が含まれている');
  assert.match(body, /& node \$copyHelper \$rcloneExe \$ZipPath/);
  assert.match(body, /lib\\rclone-copy\.mjs/);
});

test('Parse-RcloneLine: 先頭空白のサイズ右寄せ行を正しくパースする', () => {
  const parsed = parseRcloneLine('      2352990628 claude-019-2026-11-20.zip');
  assert.ok(parsed, 'パース結果が null でない');
  assert.equal(parsed.name, 'claude-019-2026-11-20.zip');
  assert.equal(parsed.size, 2352990628);
});

test('Parse-RcloneLine: 小さいサイズの行もパースできる', () => {
  const parsed = parseRcloneLine('          1234 claude-test-small.zip');
  assert.ok(parsed);
  assert.equal(parsed.name, 'claude-test-small.zip');
  assert.equal(parsed.size, 1234);
});

test('Parse-RcloneLine: サイズ0の行をパースできる', () => {
  const parsed = parseRcloneLine('             0 claude-empty-test.zip');
  assert.ok(parsed);
  assert.equal(parsed.name, 'claude-empty-test.zip');
  assert.equal(parsed.size, 0);
});

test('Parse-RcloneLine: 空行と空白のみの行は null を返す', () => {
  assert.equal(parseRcloneLine(''), null);
  assert.equal(parseRcloneLine('   '), null);
  assert.equal(parseRcloneLine('\t '), null);
});

test('Test-RcloneBackup: 名前一致・サイズ不一致で false を返す（size-mismatch）', () => {
  const lines = [
    '      2352990628 claude-019-2026-11-20.zip',
    '           42422 some-other-backup.zip',
  ];
  assert.equal(simulateRcloneVerify(lines, 'claude-019-2026-11-20.zip', 999), false,
    'サイズ不一致でも false になる');
  assert.equal(simulateRcloneVerify(lines, 'claude-019-2026-11-20.zip', 2352990628), true,
    'サイズ一致で true');
});

test('Test-RcloneBackup: ExpectedSize=0 のときは名前の有無だけで判定する（後方互換）', () => {
  const lines = [
    '      2352990628 claude-019-2026-11-20.zip',
  ];
  assert.equal(simulateRcloneVerify(lines, 'claude-019-2026-11-20.zip', 0), true,
    'ExpectedSize=0 ならサイズ不問で true');
  assert.equal(simulateRcloneVerify(lines, 'nonexistent.zip', 0), false,
    '名前が無ければ false');
});

test('Test-RcloneBackup: 先頭空白ありの rclone ls 出力行から name と size を取り出す Parse-RcloneLine が .ps1 に定義されている', () => {
  // ソースコードに Parse-RcloneLine 関数が定義されていることを確認
  assert.ok(source.includes('function Parse-RcloneLine'), '.ps1 に Parse-RcloneLine 関数が定義されている');
  assert.ok(source.includes('$trimmed = $Line.Trim()'), 'Parse-RcloneLine が Trim() を使っている');
  assert.ok(source.includes("-split '\\s+', 2"), 'Parse-RcloneLine が空白分割している');
  // Test-RcloneBackup が Parse-RcloneLine を呼んでいる
  assert.ok(source.includes('Parse-RcloneLine('), 'Test-RcloneBackup が Parse-RcloneLine を呼んでいる');
});

// ---- local-fallback 検証テスト ---- //

test('local-fallback: $localFallback 変数が定義されている', () => {
  assert.ok(source.includes('$localFallback'), '$localFallback が見つからない');
});

test('local-fallback: 既定の退避先は D:\\claude-backups', () => {
  const match = source.match(/\$localBackupDir = if \(\$env:CLAUDE_BACKUP_LOCAL_DIR\) \{ \$env:CLAUDE_BACKUP_LOCAL_DIR \} else \{ '([^']+)' \}/);
  assert.ok(match, 'CLAUDE_BACKUP_LOCAL_DIR のフォールバックパターンが見つからない');
  assert.equal(match[1], 'D:\\claude-backups');
});

test('local-fallback: local-fallback=ok のログ行がある', () => {
  assert.ok(source.includes('local-fallback=ok'), 'local-fallback=ok のログ行が見つからない');
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
