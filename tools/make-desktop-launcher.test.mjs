import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeLauncher, renderLauncher, resolveFolders } from './make-desktop-launcher.mjs';

test('Desktop resolution uses the redirected Known Folder and UTF-8 output', () => {
  const folders = { desktop: 'C:\\Users\\日本語 user\\OneDrive\\Desktop', localAppData: 'C:\\Users\\日本語 user\\AppData\\Local' };
  assert.deepEqual(resolveFolders((exe, args, options) => {
    assert.equal(exe, 'powershell.exe');
    assert.match(args.at(-1), /GetFolderPath\('Desktop'\)/);
    assert.match(args.at(-1), /OutputEncoding/);
    assert.equal(options.windowsHide, true);
    return JSON.stringify(folders);
  }), folders);
  assert.throws(() => resolveFolders(() => '{"desktop":""}'), /resolve/);
});

test('Japanese files: copy body outside tools, overwrite, JSON and remove without deleting source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, '日本語 user', 'OneDrive', 'Desktop');
  const localAppData = path.join(root, 'Local');
  const source = path.join(root, '入力.ps1');
  fs.writeFileSync(source, 'Write-Output "日本語"');
  const deps = { paths: path, resolve: () => ({ desktop, localAppData }) };
  const result = makeLauncher({ name: '登録 作業', commandFile: source, verifyCmd: 'Write-Output "確認"' }, deps);
  assert.equal(JSON.parse(JSON.stringify(result)).cmdPath, path.join(desktop, '登録 作業（ダブルクリック）.cmd'));
  const bytes = fs.readFileSync(result.cmdPath);
  assert.notEqual(bytes[0], 0xef);
  const cmd = bytes.toString('utf8');
  assert.match(cmd, /chcp 65001 >nul\r\n/);
  assert.match(cmd, /DisableDelayedExpansion/);
  assert.match(cmd, /-File ".*登録 作業.ps1"/);
  assert.match(cmd, /where pwsh.exe/);
  assert.match(cmd, /powershell.exe/);
  assert.match(cmd, /echo OK.*echo ERROR/);
  assert.match(cmd, /pause >nul/);
  assert.match(cmd, /exit \/b %launcher_result%/);
  const encoded = cmd.match(/-EncodedCommand (\S+)/)[1];
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /確認/);
  assert.equal(fs.readFileSync(result.psPath, 'utf8'), '\uFEFFWrite-Output "日本語"');
  fs.writeFileSync(source, 'exit 7');
  makeLauncher({ name: '登録 作業', commandFile: source }, deps);
  assert.equal(fs.readFileSync(result.psPath, 'utf8'), '\uFEFFexit 7');
  makeLauncher({ name: '登録 作業', remove: true }, deps);
  assert.equal(fs.existsSync(result.cmdPath), false);
  assert.equal(fs.existsSync(result.psPath), false);
  const referenced = makeLauncher({ name: '参照', psFile: source }, deps);
  assert.equal(referenced.psPath, source);
  makeLauncher({ name: '参照', remove: true }, deps);
  assert.equal(fs.existsSync(source), true);
});

test('reject invalid arguments before writing; escape percent and keep delayed expansion off', () => {
  for (const name of ['../x', 'x\\y', 'CON', 'x"', 'x\n', 'x.']) assert.throws(() => makeLauncher({ name, psFile: 'C:\\x.ps1' }));
  assert.throws(() => makeLauncher({ name: 'x' }), /exactly one/);
  assert.throws(() => makeLauncher({ name: 'x', psFile: 'relative.ps1' }), /absolute/);
  assert.match(renderLauncher('C:\\日本語 %USERPROFILE%!\\x.ps1'), /%%USERPROFILE%%!/);
});

test('Windows cmd executes Japanese paths, verification, and preserves failure exit status', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-日本語 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deps = { resolve: () => ({ desktop: path.join(root, 'OneDrive', 'Desktop'), localAppData: path.join(root, 'Local') }) };
  const source = path.join(root, '本文.ps1');
  for (const [body, verifyCmd, expected] of [['Write-Output "日本語"', 'Write-Output "VERIFIED"', 0], ['exit 7', 'exit 0', 7], ['exit 0', 'exit 9', 9]]) {
    fs.writeFileSync(source, body);
    const result = makeLauncher({ name: '登録 作業', commandFile: source, verifyCmd }, deps);
    const run = spawnSync('cmd.exe', ['/d', '/c', result.cmdPath], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, expected, run.stdout + run.stderr);
    assert.match(run.stdout, expected === 0 ? /OK/ : /ERROR/);
    if (!expected) { assert.match(run.stdout, /日本語/); assert.match(run.stdout, /VERIFIED/); }
  }
});
