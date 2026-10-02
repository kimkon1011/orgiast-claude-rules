import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diff, parseArgs, resolveClasp, runOverlay } from './gas-overlay-push.mjs';

function fixture(t, overrides = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-test-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const config = { scriptId: 'test-script', rootDir: 'src', scriptExtensions: ['.gs'], htmlExtensions: ['.html'] };
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, '.clasp.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(project, '.claspignore'), '**/ignored/**\n');
  fs.writeFileSync(path.join(project, 'src', 'chosen.gs'), 'new\n');
  fs.writeFileSync(path.join(project, 'src', 'other.gs'), 'stale local\n');
  let remote = { 'chosen.gs': 'old\n', 'other.gs': 'live production\n', 'appsscript.json': '{"timeZone":"Asia/Tokyo"}\n' };
  const calls = [], dirs = new Set();
  let pulls = 0, out = '', err = '';
  const runner = (args, { cwd }) => {
    calls.push(args);
    dirs.add(cwd);
    assert.notEqual(cwd, project);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.clasp.json'), 'utf8')), config);
    assert.equal(fs.readFileSync(path.join(cwd, '.claspignore'), 'utf8'), '**/ignored/**\n');
    if (args[0] === 'pull') {
      pulls++;
      const data = pulls === 2 && overrides.readBack ? overrides.readBack : remote;
      for (const [file, content] of Object.entries(data)) fs.writeFileSync(path.join(cwd, 'src', file), content);
    } else if (args[0] === 'push') {
      assert.deepEqual(args, ['push', '-f']);
      assert.equal(fs.readFileSync(path.join(cwd, 'src', 'other.gs'), 'utf8'), 'live production\n');
      assert.equal(fs.readFileSync(path.join(cwd, 'src', 'appsscript.json'), 'utf8'), remote['appsscript.json']);
      remote = Object.fromEntries(fs.readdirSync(path.join(cwd, 'src')).map(file => [file, fs.readFileSync(path.join(cwd, 'src', file), 'utf8')]));
    }
    if (overrides.fail === args[0]) return { status: 1, stderr: 'mock failure\n' };
    return { status: 0, stdout: args[0] === 'deployments' ? overrides.deployments ?? '- head @HEAD\n- deploy-one @1 - production\n' : '' };
  };
  return {
    project, calls,
    run(options = {}) {
      const code = runOverlay({ project, files: ['chosen.gs'], ...options }, {
        runner, stdout: s => { out += s; }, stderr: s => { err += s; },
      });
      for (const dir of dirs) assert.equal(fs.existsSync(dir), false, 'temporary workspace removed');
      return { code, result: JSON.parse(out.trim().split('\n').at(-1)), out, err };
    },
  };
}

test('only selected files overlay the pulled production snapshot; separate read-back workspace', t => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.result, { ok: true, pushed: ['chosen.gs'], unchanged: [], readBack: 'ok', deployed: null });
  assert.deepEqual(f.calls, [['pull'], ['push', '-f'], ['pull']]);
  assert.match(r.out, /chosen.gs: \+1 \/ -1/);
  assert.match(r.out, /-old\n\+new/);
  assert.equal(fs.readFileSync(path.join(f.project, 'src', 'other.gs'), 'utf8'), 'stale local\n');
});

test('unchanged content skips push and deployment, including CRLF differences', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, 'src', 'chosen.gs'), 'old\r\n');
  const r = f.run({ deploy: 'deploy-one' });
  assert.equal(r.code, 0);
  assert.deepEqual(f.calls, [['pull']]);
  assert.deepEqual(r.result.unchanged, ['chosen.gs']);
  assert.equal(r.result.readBack, 'skipped');
  assert.match(r.out, /変更なし/);
});

test('dry-run shows differences without push or deployment', t => {
  const f = fixture(t);
  const r = f.run({ dryRun: true, deployWebapp: true });
  assert.equal(r.code, 0);
  assert.deepEqual(f.calls, [['pull']]);
  assert.deepEqual(r.result.pushed, []);
  assert.equal(r.result.readBack, 'skipped');
  assert.match(r.out, /\+new/);
});

test('mixed selection reports unchanged files and pushes a new empty file', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, 'src', 'other.gs'), 'live production\n');
  fs.writeFileSync(path.join(f.project, 'src', 'empty.gs'), '');
  const r = f.run({ files: ['chosen.gs', 'other.gs', 'empty.gs'] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.result.pushed, ['chosen.gs', 'empty.gs']);
  assert.deepEqual(r.result.unchanged, ['other.gs']);
  assert.equal(r.result.readBack, 'ok');
});

test('read-back also verifies selected files that were initially unchanged', t => {
  const f = fixture(t, { readBack: { 'chosen.gs': 'new\n', 'other.gs': 'unexpected\n' } });
  fs.writeFileSync(path.join(f.project, 'src', 'other.gs'), 'live production\n');
  const r = f.run({ files: ['chosen.gs', 'other.gs'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /read-back 不一致: other.gs/);
});

test('read-back mismatch returns exit code 1 and prevents deployment', t => {
  const f = fixture(t, { readBack: { 'chosen.gs': 'wrong\n' } });
  const r = f.run({ deploy: 'deploy-one' });
  assert.equal(r.code, 1);
  assert.equal(r.result.readBack, 'failed');
  assert.match(r.out, /-wrong\n\+new/);
  assert.equal(f.calls.some(c => c[0] === 'deploy'), false);
});

test('missing read-back file fails even for empty local content', t => {
  const f = fixture(t, { readBack: {} });
  fs.writeFileSync(path.join(f.project, 'src', 'chosen.gs'), '');
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(r.err, /read-back 不一致/);
});

test('read-back accepts CRLF and explicit deployment preserves argument boundaries', t => {
  const f = fixture(t, { readBack: { 'chosen.gs': 'new\r\n' } });
  const description = 'release "quotes" & $(literal)';
  const r = f.run({ deploy: 'deploy-one', description });
  assert.equal(r.code, 0);
  assert.equal(r.result.deployed, 'deploy-one');
  assert.deepEqual(f.calls.at(-1), ['deploy', '-i', 'deploy-one', '-d', description]);
});

test('deploy-webapp ignores HEAD and updates sole versioned deployment after verification', t => {
  const f = fixture(t);
  const r = f.run({ deployWebapp: true });
  assert.equal(r.code, 0);
  assert.equal(r.result.deployed, 'deploy-one');
  assert.deepEqual(f.calls.map(c => c[0]), ['pull', 'push', 'pull', 'deployments', 'deploy']);
});

test('deploy-webapp reports every candidate and rejects multiple deployments', t => {
  const f = fixture(t, { deployments: '- head @HEAD\n- first @1 - one\n- second @2 - two\n' });
  const r = f.run({ deployWebapp: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /first, second/);
  assert.match(r.err, /--deploy/);
  assert.equal(f.calls.some(c => c[0] === 'deploy'), false);
});

test('deploy-webapp fails when there is no versioned deployment', t => {
  const f = fixture(t, { deployments: '- head @HEAD\n' });
  assert.equal(f.run({ deployWebapp: true }).code, 1);
});

for (const command of ['pull', 'push', 'deploy']) {
  test(`${command} failure returns 1 and cleans temporary directories`, t => {
    const f = fixture(t, { fail: command });
    const r = f.run({ deploy: 'deploy-one' });
    assert.equal(r.code, 1);
    assert.equal(r.result.ok, false);
    assert.match(r.err, new RegExp(`clasp ${command} 失敗`));
    assert.equal(f.calls.at(-1)[0], command);
  });
}

test('missing selected file fails before any clasp call', t => {
  const f = fixture(t);
  assert.equal(f.run({ files: ['missing.gs'] }).code, 1);
  assert.deepEqual(f.calls, []);
});

for (const file of ['../outside.gs', '/absolute.gs', 'C:\\outside.gs', '.clasp.json', '']) {
  test(`unsafe file path is rejected: ${JSON.stringify(file)}`, t => {
    const f = fixture(t);
    assert.equal(f.run({ files: [file] }).code, 1);
    assert.deepEqual(f.calls, []);
  });
}

test('rootDir outside temporary workspace is rejected before pull', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '.clasp.json'), JSON.stringify({ scriptId: 'test', rootDir: '../outside' }));
  assert.equal(f.run().code, 1);
  assert.deepEqual(f.calls, []);
});

test('argument parsing requires values, rejects conflicts and splits file list', () => {
  assert.deepEqual(parseArgs(['--project', 'gas', '--files', 'a.gs, b.gs,a.gs', '--dry-run']), { project: 'gas', files: ['a.gs', 'b.gs'], dryRun: true });
  assert.throws(() => parseArgs(['--project']), /値が必要/);
  assert.throws(() => parseArgs(['--project', 'gas', '--files', 'a.gs', '--deploy', 'id', '--deploy-webapp']), /併用/);
  assert.throws(() => parseArgs(['--unknown']), /不明/);
});

test('LCS counts additions/deletions, preserves newline changes and caps diff output at 80 lines', () => {
  const r = diff('a\nb\nc\n', 'a\nx\nc\nd\n', 'test.gs');
  assert.equal(r.added, 2);
  assert.equal(r.removed, 1);
  assert.equal(diff('a', 'a\n', 'test.gs').added, 1);
  assert.match(diff('a', 'a\n', 'test.gs').text, /No newline/);
  assert.equal(diff('', 'new\n'.repeat(100), 'test.gs').text.split('\n').length, 80);
});

test('Windows npm clasp.cmd resolves to a Node script without shell execution', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-shim-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'node_modules', '@google', 'clasp', 'build', 'src', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  fs.writeFileSync(path.join(dir, 'clasp.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\node_modules\\@google\\clasp\\build\\src\\index.js" %*\n');
  assert.deepEqual(resolveClasp('win32', { PATH: dir }), { command: process.execPath, prefix: [entry] });
});
