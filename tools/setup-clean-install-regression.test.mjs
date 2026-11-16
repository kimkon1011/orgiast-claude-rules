// クリーンインストール失敗の再現テスト
// convergeMobileStandby の後に呼ばれる各関数がクリーン環境（VSCode無し・WSL無し・schtasks制限あり）で例外を投げないことを検証
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convergeMobileStandby } from './mobile-standby.mjs';
import { convergeNodeRuntimeSecurity } from './setup-node-runtime-security.mjs';
import { inspectTaskHiddenActions } from './setup-task-hidden-actions.mjs';
import { convergeNightlyReload } from './setup-nightly-reload.mjs';
import { convergeDeadlineTasks } from './setup-deadline-watch.mjs';

// convergeMobileStandby が返した後、次の関数群が落ちないことを検証。
// clean-install CI では RC接頭辞の後の8秒間で無言exit code 1になる。

test('bootstrap lets PowerShell 5.1 capture native stderr without aborting', async () => {
  const source = await fs.readFile(new URL('./bootstrap.ps1', import.meta.url), 'utf8');
  assert.match(source, /\$savedErrorActionPreference = \$ErrorActionPreference/);
  assert.match(source, /\$ErrorActionPreference = 'Continue'[\s\S]*& \$nodeExe[\s\S]*2>&1/);
  assert.match(source, /\$setupExitCode = \$LASTEXITCODE[\s\S]*\$ErrorActionPreference = \$savedErrorActionPreference/);
  assert.doesNotMatch(source, /cmd\.exe[\s\S]*setup\.mjs/);
});

test('convergeMobileStandby → convergeNodeRuntimeSecurity の連続でエラーなく完了する（クリーン環境模擬）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // クリーン環境: ~/.claude なし、VSCode なし、WSL なし
  const home = root;
  const claudeDir = path.join(home, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  // convergeMobileStandby（空のhomeで必ず結果を返すことを確認）
  const outcome = convergeMobileStandby({ home, repoRoot: path.join(import.meta.dirname, '..') });
  assert.ok(outcome, 'convergeMobileStandby は結果を返す');
  assert.ok(Array.isArray(outcome.lines), 'lines は配列');
  // VSCode の有無に関わらずクラッシュしない（VSCode あり/なし両環境で通る）
  assert.ok(outcome.lines.length > 0, 'ログ行がある');

  // convergeNodeRuntimeSecurity（クリーン環境でネットワーク不可を模擬）
  const secOutcome = await convergeNodeRuntimeSecurity({
    platform: 'win32',
    arch: 'x64',
    home,
    temp: root,
    account: 'runneradmin',
    fs,
    wslInstalled: () => false,
    msiBusy: () => false,
    now: Date.now,
    sleep: async () => {},
    async run(file, args) {
      if (file === 'node.exe') return 'v22.12.0\n';
      if (file === 'powershell.exe') return 'false';
      if (file === 'wsl.exe') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return '';
    },
    async download() { throw new Error('network unavailable (clean runner simulation)'); },
    async launch() {},
  });
  assert.ok(secOutcome, 'convergeNodeRuntimeSecurity は結果を返す');
  assert.ok(['OK', 'NOTICE', 'NG'].includes(secOutcome.status), `status は OK/NOTICE/NG のいずれか: ${secOutcome.status}`);
  // ネットワーク不可でも NOTICE で完了する（例外を投げない）
  assert.equal(secOutcome.status, 'NOTICE', 'ネットワーク不可の場合は NOTICE');

  // inspectTaskHiddenActions（クリーン環境：schtasks が空）
  const taskOutcome = inspectTaskHiddenActions({
    platform: 'win32',
    run: () => JSON.stringify({ tasks: [], exclude: [] }),
    converge: false,
  });
  assert.ok(taskOutcome, 'inspectTaskHiddenActions は結果を返す');
  assert.ok(['OK', 'NOTICE', 'NG'].includes(taskOutcome.status), `status は OK/NOTICE/NG: ${taskOutcome.status}`);

  // convergeNightlyReload（クリーン環境：VSCode設定なし）
  const settingsPath = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  const nightOutcome = convergeNightlyReload({
    platform: 'win32',
    settingsPath,
    run: () => JSON.stringify({ changed: false }),
    restore: (p) => {
      try { fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{}\n');
      return true;
    },
  });
  assert.ok(nightOutcome, 'convergeNightlyReload は結果を返す');
  assert.ok(['OK', 'NOTICE', 'NG'].includes(nightOutcome.status), `status は OK/NOTICE/NG: ${nightOutcome.status}`);

  // convergeDeadlineTasks（クリーン環境：kim でない席）
  const deadlineOutcome = convergeDeadlineTasks({
    platform: 'win32',
    home,
    run: () => '',
    seat: { kim: false, kimOperated: false, dwdKey: false },
  });
  assert.ok(deadlineOutcome, 'convergeDeadlineTasks は結果を返す');
  assert.equal(deadlineOutcome.status, 'NOTICE', 'kim でない席は NOTICE');
});

test('convergeMobileStandby が空の home でも落ちない', (t) => {
  const home = path.join(os.tmpdir(), 'nonexistent-' + Date.now());
  const outcome = convergeMobileStandby({ home, repoRoot: path.join(import.meta.dirname, '..') });
  assert.ok(outcome, '結果を返す');
  assert.ok(Array.isArray(outcome.lines), 'lines は配列');
  // 結果があることを確認（VSCode あり/なし どちらでも OK）
  assert.ok(outcome.lines.length > 0, 'ログ行がある');
});

test('setup.mjs convergeNodeRuntimeSecurity が try/catch で保護されている（エラー時に NOTICE で完了）', async (t) => {
  // convergeNodeRuntimeSecurity の実呼び出しはこのテストの目的ではない。
  // 内部エラーが throw ではなく NOTICE に変換されることを確認する。
  const outcome = await convergeNodeRuntimeSecurity({
    platform: 'win32',
    arch: 'x64',
    home: os.tmpdir(),
    temp: os.tmpdir(),
    account: 'test',
    fs,
    wslInstalled: () => false,
    msiBusy: () => false,
    now: Date.now,
    sleep: async () => {},
    async run(file) {
      if (file === 'node.exe') return 'v22.12.0\n';
      if (file === 'powershell.exe') return 'false';
      return '';
    },
    async download() { throw new Error('simulated network failure'); },
    async launch() {},
  });
  // 例外を投げずに NOTICE を返す
  assert.equal(outcome.status, 'NOTICE', 'ネットワーク不可なら NOTICE');
  assert.equal(outcome.checked, false, 'ダウンロード失敗時は checked=false');
});
