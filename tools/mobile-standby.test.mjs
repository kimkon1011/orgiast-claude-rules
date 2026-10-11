import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pool from './lib/mobile-state.cjs';
import { convergeMobileConfig, removeMobileTabsZero, convergeMobileExtension, convergeMobileStandby } from './mobile-standby.mjs';

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const cfg = (home) => path.join(home, '.claude', 'mobile-sessions.json');

test('既定の待機数は 3（fallback なし）', () => {
  assert.equal(pool.readConfig(temp('ms-default-'), {}), 3);
  assert.equal(pool.targetCount(), 3);
});

test('mobile-sessions.json: 無ければ作成、3 未満は引き上げ（他キー保持）、3 以上は不変・冪等', () => {
  const home = temp('ms-cfg-');
  assert.equal(convergeMobileConfig(home).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(home), 'utf8')), { count: 3 });
  assert.equal(convergeMobileConfig(home).changed, false);
  fs.writeFileSync(cfg(home), JSON.stringify({ count: 1, refreshMinutes: 30 }));
  assert.equal(convergeMobileConfig(home).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(home), 'utf8')), { count: 3, refreshMinutes: 30 });
  fs.writeFileSync(cfg(home), JSON.stringify({ count: 5 }));
  assert.equal(convergeMobileConfig(home).changed, false);
  assert.equal(JSON.parse(fs.readFileSync(cfg(home), 'utf8')).count, 5);
});

test('壊れた mobile-sessions.json は上書きしない', () => {
  const home = temp('ms-broken-');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(cfg(home), '{broken');
  assert.equal(convergeMobileConfig(home).changed, false);
  assert.equal(fs.readFileSync(cfg(home), 'utf8'), '{broken');
});

test('VSCode settings の mobileTabs=0 を除去（JSON / JSONC 末尾カンマ）', () => {
  const dir = temp('ms-set-');
  const a = path.join(dir, 'a.json');
  fs.writeFileSync(a, JSON.stringify({ 'editor.x': 1, 'orgiast.nextSession.mobileTabs': 0 }, null, 4));
  assert.equal(removeMobileTabsZero(a).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { 'editor.x': 1 });
  assert.equal(removeMobileTabsZero(a).changed, false);
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(b, '{\n  // memo\n  "editor.x": 1,\n  "orgiast.nextSession.mobileTabs": 0\n}\n');
  assert.equal(removeMobileTabsZero(b).changed, true);
  assert.equal(fs.readFileSync(b, 'utf8').includes('mobileTabs'), false);
  assert.doesNotMatch(fs.readFileSync(b, 'utf8'), /1,\s*\}/);
  const c = path.join(dir, 'c.json');
  fs.writeFileSync(c, '{"orgiast.nextSession.mobileTabs": 2}');
  assert.equal(removeMobileTabsZero(c).changed, false);
  assert.equal(removeMobileTabsZero(path.join(dir, 'none.json')).changed, false);
});

function extFixture({ installed = '' } = {}) {
  const home = temp('ms-ext-');
  const repoRoot = temp('ms-repo-');
  const pkg = path.join(repoRoot, 'packages', 'vscode-next-session');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'orgiast-next-session-0.3.6.vsix'), 'a');
  fs.writeFileSync(path.join(pkg, 'orgiast-next-session-0.3.7.vsix'), 'b');
  if (installed) fs.mkdirSync(path.join(home, '.vscode', 'extensions', `orgiast.next-session-${installed}`), { recursive: true });
  const calls = [];
  const runCodeCli = (args) => { calls.push(args); return { code: 0, stdout: installed ? `orgiast.next-session@${installed}\n` : '', stderr: '' }; };
  const exists = (p) => p === 'X:\code.cmd';
  return { home, repoRoot, calls, runCodeCli, env: { VSCODE_CLI_PATH: 'X:\code.cmd' }, exists };
}

test('拡張: VSCode が無ければスキップ', () => {
  const f = extFixture();
  const r = convergeMobileExtension({ ...f, exists: () => false });
  assert.equal(r.status, 'skip');
  assert.equal(f.calls.length, 0);
});

test('拡張: 未導入なら最新 VSIX を --force 導入', () => {
  const f = extFixture();
  const r = convergeMobileExtension(f);
  assert.equal(r.status, 'installed');
  assert.equal(f.calls.at(-1)[0], '--install-extension');
  assert.match(f.calls.at(-1)[1], /orgiast-next-session-0\.3\.7\.vsix$/);
  assert.equal(f.calls.at(-1)[2], '--force');
});

test('拡張: 古ければ更新、最新なら CLI を呼ばない', () => {
  const old = extFixture({ installed: '0.3.6' });
  assert.equal(convergeMobileExtension(old).status, 'installed');
  const cur = extFixture({ installed: '0.3.7' });
  assert.equal(convergeMobileExtension(cur).status, 'ok');
  assert.equal(cur.calls.length, 0);
});

test('拡張: 同梱 VSIX が無ければ ng', () => {
  const f = extFixture();
  fs.rmSync(path.join(f.repoRoot, 'packages'), { recursive: true });
  assert.equal(convergeMobileExtension(f).status, 'ng');
});

test('convergeMobileStandby は 3 ステップを通し冪等', () => {
  const f = extFixture();
  const settingsPath = path.join(f.home, 'settings.json');
  fs.writeFileSync(settingsPath, '{"orgiast.nextSession.mobileTabs":0}');
  const first = convergeMobileStandby({ ...f, settingsPath });
  assert.equal(first.ok, true);
  assert.equal(first.config.changed, true);
  assert.equal(first.settings.changed, true);
  assert.equal(first.extension.status, 'installed');
  fs.mkdirSync(path.join(f.home, '.vscode', 'extensions', 'orgiast.next-session-0.3.7'), { recursive: true });
  const second = convergeMobileStandby({ ...f, settingsPath });
  assert.equal(second.config.changed, false);
  assert.equal(second.settings.changed, false);
  assert.equal(second.extension.status, 'ok');
});

test('同梱 VSIX の最新版と package.json の版が一致する', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'packages', 'vscode-next-session');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  assert.ok(fs.existsSync(path.join(dir, `orgiast-next-session-${version}.vsix`)));
});
