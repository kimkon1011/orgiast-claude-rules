import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 型「無人ジョブが UAC 必須インストールを起動し確認画面を溜める」の機械ゲート
// （2026-11-09〜11 作業用014: ClaudeDailyDriveBackup が毎晩 winget install Google.GoogleDrive を
//  起動し、非昇格のため UAC 昇格プロンプトが誰も押されないまま溜まった）。
//
// 方針:
// - tools 配下の ps1 でマシン全体インストーラ（winget install / msiexec / -Verb RunAs）を
//   起動し得るものは、対話専用（INTERACTIVE_ALLOWLIST）か、起動前に管理者権限チェック
//   （IsInRole / WindowsPrincipal）を通すこと。
// - ユーザースコープ（--scope user）のインストールは UAC 不要のため許可。
// - 無人の定時ジョブから実行される backup-claude-to-drive.ps1 はさらに
//   非昇格スキップ（reason=needs-elevation）と 7 日スロットルを必須とする。

const toolsDir = import.meta.dirname;
const read = (name) => fs.readFileSync(path.join(toolsDir, name), 'utf8');

const BANNED_INSTALL_RE = /winget\s+install|msiexec(?:\.exe)?|\bRunAs\b/i;
const ELEVATED_GUARD_RE = /IsInRole\(?\s*\[?Security|WindowsPrincipal/;

// 人がコンソールで操作することが前提のスクリプト（UAC が出てもその場に人がいる）。
// 方針の対象外だが、この一覧は「人の操作で起動される」事実を明示するために維持する。
// 追加するときはコメントに「誰が・いつ」の対話契機を書くこと。
const INTERACTIVE_ALLOWLIST = new Map([
  ['bootstrap.ps1', '導入専用の対話ワンショット（人がコンソールで実行）'],
  ['install-orgiast.ps1', '対話セットアップ（人が実行）'],
  ['restore-claude-from-drive.ps1', '復元時に人が実行する対話手順'],
  ['fleet-fix-now.ps1', '担当者がコンソールに貼って実行する修復ツール'],
  ['selftest-install.ps1', '実機回帰確認用（インストール実行なし）'],
  ['keyserve-enroll-installer.test.ps1', 'テスト（インストール実行なし）'],
]);

const ps1Files = fs.readdirSync(toolsDir).filter((name) => name.toLowerCase().endsWith('.ps1'));
const withBannedInstall = ps1Files.filter((name) => BANNED_INSTALL_RE.test(read(name)));

test('machine-wide install in tools/*.ps1 requires elevation guard unless declared interactive', () => {
  for (const name of withBannedInstall) {
    if (INTERACTIVE_ALLOWLIST.has(name)) continue;
    assert.match(read(name), ELEVATED_GUARD_RE,
      `${name}: マシン全体インストール（winget/msiexec/RunAs）は管理者権限チェック必須`
      + '（対話専用なら INTERACTIVE_ALLOWLIST に理由付きで追加）');
  }
});

test('every installer-bearing ps1 is accounted for (allowlist or elevation guard)', () => {
  for (const name of withBannedInstall) {
    const covered = INTERACTIVE_ALLOWLIST.has(name) || ELEVATED_GUARD_RE.test(read(name));
    assert.ok(covered, `${name}: インストール起動があるのに allowlist にも昇格ガードにも載っていない`);
  }
});

test('backup-claude-to-drive.ps1: unattended backup never launches winget without elevation', () => {
  const source = read('backup-claude-to-drive.ps1');
  assert.match(source, ELEVATED_GUARD_RE);
  // 非昇格スキップが winget 起動より前にある（本文の順序で固定）。
  assert.ok(source.indexOf('winget.Source') > source.indexOf('reason=needs-elevation'),
    '非昇格スキップ（reason=needs-elevation）より前に winget 起動がある');
  assert.match(source, /reason=needs-elevation/, '非昇格スキップ（reason=needs-elevation）が無い');
  assert.match(source, /lastDriveInstallAttemptUtc/, '試行の 7 日スロットル記録が無い');
  assert.match(source, /reason=throttled-7d/, '7 日スロットル分岐が無い');
});

test('register-claude-backup-task.ps1: pwsh の winget/MSI は非昇格の無人実行では起動しない', () => {
  const source = read('register-claude-backup-task.ps1');
  assert.match(source, ELEVATED_GUARD_RE);
  assert.match(source, /-not \(Get-IsElevated\)/, '非昇格スキップ分岐が無い');
  assert.ok(source.indexOf('Start-Process -FilePath $winget.Source') > source.indexOf('-not (Get-IsElevated)'),
    'winget 起動が昇格ガードより前にある');
  assert.match(source, /UAC を出さない/, '非昇格スキップの理由文言が無い');
});

test('setup-node-runtime-security.mjs (SessionStart hook 経由) does not auto-RunAs unattended', () => {
  const source = read('setup-node-runtime-security.mjs');
  assert.match(source, ELEVATED_GUARD_RE, 'admin 判定が消えている');
  assert.match(source, /isInteractiveConsole/, '対話コンソール判定（isInteractiveConsole）が無い');
  assert.match(source, /非昇格の無人実行のため自動更新をスキップ/, '無人実行時のスキップ分岐が無い');
});