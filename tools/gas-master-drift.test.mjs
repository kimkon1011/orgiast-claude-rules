import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOOTH_SCRIPT, spawnCommand } from './gas-master-sync.mjs';
import { checkGasMasterDrift } from './gas-master-drift.mjs';

function fixture(t, { different = false, pullFail = false, notifyFail = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-drift-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'Downloads', 'ブース制作アプリ');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, '.clasp.json'), JSON.stringify({ scriptId: BOOTH_SCRIPT, rootDir: 'src' }));
  const calls = [], messages = [];
  const opts = { home, now: new Date('2026-10-09T00:00:00Z'),
    pull(args, { cwd }) {
      calls.push(['clasp', ...args]);
      assert.notEqual(cwd, project);
      if (pullFail) return { status: 1 };
      fs.writeFileSync(path.join(cwd, 'Code.js'), different ? 'changed\n' : 'function x() { return 1; }\r\n');
      fs.writeFileSync(path.join(cwd, 'appsscript.json'), '{}');
      return { status: 0 };
    },
    spawn(cmd, args, options) {
      calls.push([cmd, ...args]);
      if (args[0] === 'clone') {
        const src = path.join(args.at(-1), 'src'); fs.mkdirSync(src, { recursive: true });
        fs.writeFileSync(path.join(src, 'Code.gs'), 'function x(){return 1;}\n');
        fs.writeFileSync(path.join(src, 'Code.test.js'), 'not deployed');
        fs.writeFileSync(path.join(src, 'appsscript.json'), '{}');
        return { status: 0 };
      }
      return spawnCommand(cmd, args, options);
    },
    async notify(text) { if (notifyFail) throw new Error('DM failed'); messages.push(text); },
  };
  return { opts, calls, messages, state: path.join(home, '.claude', '.gas-master-drift.json') };
}
test('weekly audit ignores whitespace, CRLF, server extension and tests', async t => {
  const f = fixture(t); assert.equal((await checkGasMasterDrift(f.opts)).status, 'ok'); assert.deepEqual(f.messages, []);
  const count = f.calls.length; assert.equal((await checkGasMasterDrift(f.opts)).status, 'skipped'); assert.equal(f.calls.length, count);
  assert.equal((await checkGasMasterDrift({ ...f.opts, now: new Date('2026-10-16T00:00:00Z') })).status, 'ok'); assert.ok(f.calls.length > count);
});
test('production/master difference sends one-line DM and is suppressed for seven days', async t => {
  const f = fixture(t, { different: true }); assert.equal((await checkGasMasterDrift(f.opts)).status, 'drift');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].includes('\n'), false);
  await checkGasMasterDrift(f.opts); assert.equal(f.messages.length, 1);
});
test('dry-run does not pull, spawn, notify or update weekly state', async t => {
  const f = fixture(t); assert.equal((await checkGasMasterDrift({ ...f.opts, dryRun: true })).status, 'dry-run'); assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.state), false);
});
for (const failure of ['pullFail', 'notifyFail']) test(`${failure} does not consume weekly check`, async t => {
  const f = fixture(t, { different: true, [failure]: true }); await assert.rejects(checkGasMasterDrift(f.opts)); assert.equal(fs.existsSync(f.state), false);
});
