import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const setup = path.join(toolsDir, 'setup.mjs');
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const run = (args) => spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8' });
const manifest = (items) => ({ version: 1, items });
const item = (id, type, spec, severity = 'required', extra = {}) => ({ id, type, severity, spec, description: id, ...extra });

test('empty HOME fails and file fixtures converge to success', () => {
  const home = temp('setup-home-');
  const mf = path.join(home, 'manifest.json');
  const items = [
    item('contains', 'file-contains', { path: 'a.txt', contains: 'needle' }),
    item('nonempty', 'file-nonempty', { path: 'b.txt' }),
    item('json', 'json-valid', { path: 'c.json', bom: false }),
  ];
  write(mf, JSON.stringify(manifest(items)));
  assert.equal(run(['--verify', '--home', home, '--manifest', mf]).status, 1);
  write(path.join(home, 'a.txt'), 'a needle b');
  write(path.join(home, 'b.txt'), 'x');
  write(path.join(home, 'c.json'), '{"ok":true}\n');
  assert.equal(run(['--verify', '--home', home, '--manifest', mf]).status, 0);
});

test('BOM-prefixed JSON is invalid', () => {
  const home = temp('setup-bom-');
  const mf = path.join(home, 'manifest.json');
  write(path.join(home, '.claude/settings.json'), '\uFEFF{}');
  write(mf, JSON.stringify(manifest([item('settings', 'json-valid', { path: '.claude/settings.json', bom: false })])));
  const result = run(['--home', home, '--manifest', mf]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[NG \] settings/m);
});

test('broken manifest fails without stack trace', () => {
  const home = temp('setup-broken-');
  const mf = path.join(home, 'broken.json');
  write(mf, '{broken');
  const result = run(['--home', home, '--manifest', mf]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[NG \] manifest:invalid/m);
  assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at\s|SyntaxError:/);
});

test('converge repairs, rechecks, and is idempotent', () => {
  const home = temp('setup-converge-');
  const target = path.join(home, 'fixed.txt');
  const helper = path.join(home, 'repair.mjs');
  const mf = path.join(home, 'manifest.json');
  write(helper, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(target)}, 'ready');\n`);
  write(mf, JSON.stringify(manifest([item('fixed', 'file-contains', { path: 'fixed.txt', contains: 'ready' }, 'required', { repair: [helper] })])));
  const first = run(['--converge', '--json', '--home', home, '--manifest', mf]);
  assert.equal(first.status, 0);
  assert.deepEqual(JSON.parse(first.stdout).items[0], { id: 'fixed', severity: 'required', status: 'OK', checked: true, repaired: true });
  const before = fs.statSync(target).mtimeMs;
  const second = run(['--converge', '--json', '--home', home, '--manifest', mf]);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).items[0].status, 'OK');
  assert.equal(fs.statSync(target).mtimeMs, before);
});

test('manifest schema rejects duplicate ids and unknown enums', () => {
  const home = temp('setup-schema-');
  for (const [name, items] of [
    ['duplicate', [item('same', 'file-nonempty', { path: 'a' }), item('same', 'file-nonempty', { path: 'b' })]],
    ['type', [item('bad-type', 'unknown', { path: 'a' })]],
    ['severity', [item('bad-severity', 'file-nonempty', { path: 'a' }, 'unknown')]],
  ]) {
    const mf = path.join(home, `${name}.json`);
    write(mf, JSON.stringify(manifest(items)));
    const result = run(['--home', home, '--manifest', mf]);
    assert.equal(result.status, 1, name);
    assert.match(result.stdout, /manifest invalid/, name);
  }
});

test('win32: command type resolves .cmd shims (npm-installed CLIs like codex)', { skip: process.platform !== 'win32' }, () => {
  const home = temp('setup-cmdshim-');
  const name = `orgiast-shim-${process.pid}`;
  const dir = path.join(home, 'bin');
  write(path.join(dir, `${name}.cmd`), '@echo 1.2.3\r\n');
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([item(`cmd:${name}`, 'command', { command: name, versionRegex: '\\d+\\.\\d+\\.\\d+' })])));
  const result = spawnSync(process.execPath, [setup, '--json', '--home', home, '--manifest', mf], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir};${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).items[0].status, 'OK');
});

test('project manifest has unique known item types and severities', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8'));
  const ids = parsed.items.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert(parsed.items.every((entry) => ['command', 'file-contains', 'file-nonempty', 'json-valid', 'scheduled-task'].includes(entry.type)));
  assert(parsed.items.every((entry) => ['required', 'optional', 'manual'].includes(entry.severity)));
});
