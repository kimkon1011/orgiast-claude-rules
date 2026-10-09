import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOOTH_SCRIPT, syncGasMaster } from './gas-master-sync.mjs';
import { runOverlay } from './gas-overlay-push.mjs';

function fixture(t, { ff = true, pushFail = false, claspFail = false, mismatch = false, staged = true } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-sync-test-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, '.clasp.json'), JSON.stringify({ scriptId: BOOTH_SCRIPT, rootDir: 'src' }));
  fs.writeFileSync(path.join(project, 'src', 'Code.js'), 'new\n');
  const calls = []; let pulls = 0, output = '', errors = '';
  const spawn = (cmd, args, { cwd }) => {
    calls.push([cmd, ...args]);
    assert.notEqual(cwd, project, 'only read-only origin/HEAD lookup uses project');
    if (args[0] === 'clone') {
      const src = path.join(args.at(-1), 'src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'Code.js'), 'old');
      fs.writeFileSync(path.join(src, 'Deleted.js'), 'deleted');
      fs.writeFileSync(path.join(src, 'Code.test.js'), 'test stays');
    }
    if (args[0] === 'diff') {
      assert.equal(fs.existsSync(path.join(cwd, 'src', 'Deleted.js')), false);
      assert.equal(fs.readFileSync(path.join(cwd, 'src', 'Code.test.js'), 'utf8'), 'test stays');
      assert.equal(fs.readFileSync(path.join(cwd, 'src', 'ProductionOnly.js'), 'utf8'), 'live');
      return { status: 0, stdout: staged ? 'src/Code.js\nsrc/ProductionOnly.js\n' : '' };
    }
    if (args[0] === 'merge-base') return { status: ff ? 0 : 1 };
    if (args[0] === 'push' && pushFail) return { status: 1, stderr: 'network failure' };
    return { status: 0, stdout: cmd === 'gh' ? 'https://github.com/kimkon1011/booth-production-app/pull/123' : '' };
  };
  const injected = (cmd, args, opts) => {
    if (opts.cwd === project) {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: args[0] === 'remote' ? 'https://github.com/kimkon1011/booth-production-app.git' : 'abc123' };
    }
    return spawn(cmd, args, opts);
  };
  const runner = (args, { cwd }) => {
    if (args[0] === 'push') return { status: claspFail ? 1 : 0 };
    pulls++;
    for (const [name, text] of Object.entries({ 'Code.js': pulls === 1 ? 'old' : 'new\n', 'appsscript.json': '{}', 'ProductionOnly.js': mismatch && pulls === 2 ? 'race' : 'live' })) fs.writeFileSync(path.join(cwd, 'src', name), text);
    return { status: 0 };
  };
  return { project, calls, run(dryRun = false) {
    const code = runOverlay({ project, files: ['Code.js'], dryRun }, { runner,
      syncMaster: (opts, io) => syncGasMaster(opts, { ...io, spawn: injected }),
      stdout: s => { output += s; }, stderr: s => { errors += s; },
    });
    return { code, result: JSON.parse(output.trim().split('\n').at(-1)), output, errors };
  } };
}
test('clasp success → isolated snapshot commit and two Git pushes; production-only files preserved', t => {
  const f = fixture(t); const r = f.run();
  assert.equal(r.code, 0); assert.equal(r.result.gitSync.status, 'pushed');
  assert.deepEqual(f.calls.filter(c => c[1] === 'push'), [['git', 'push', 'origin', 'HEAD'], ['git', 'push', 'origin', 'HEAD:master']]);
  assert.ok(f.calls.some(c => c[1] === 'commit'));
  assert.equal(fs.readFileSync(path.join(f.project, 'src', 'Code.js'), 'utf8'), 'new\n');
});
test('clasp failure → no git calls', t => {
  const f = fixture(t, { claspFail: true }); assert.equal(f.run().code, 1); assert.deepEqual(f.calls, []);
});
test('non-fast-forward → PR URL and stderr; no master push', t => {
  const f = fixture(t, { ff: false }); const r = f.run();
  assert.equal(r.result.gitSync.status, 'pr'); assert.match(r.output, /\/pull\/123/); assert.match(r.errors, /master が先行。PR で統合/);
  assert.equal(f.calls.filter(c => c[1] === 'push').length, 1);
  assert.ok(f.calls.some(c => c[0] === 'gh' && c.includes('master')));
});
test('dry-run → no git mutation or spawning', t => {
  const f = fixture(t); const r = f.run(true); assert.equal(r.code, 0); assert.equal(r.result.gitSync.status, 'dry-run'); assert.deepEqual(f.calls, []);
});
test('GitHub failure preserves clasp success and reports failed sync', t => {
  const f = fixture(t, { pushFail: true }); const r = f.run(); assert.equal(r.code, 0); assert.equal(r.result.readBack, 'ok'); assert.equal(r.result.gitSync.status, 'failed');
});
test('unselected production file changed during read-back → no git calls', t => {
  const f = fixture(t, { mismatch: true }); const r = f.run(); assert.equal(r.result.gitSync.status, 'failed'); assert.deepEqual(f.calls, []);
});
test('no staged difference skips commit but still pushes twice', t => {
  const f = fixture(t, { staged: false }); f.run(); assert.equal(f.calls.some(c => c[1] === 'commit'), false); assert.equal(f.calls.filter(c => c[1] === 'push').length, 2);
});
