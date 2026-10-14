import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, pollIsFresh, STALE_POLL_MS, convergeFleetMail, MIGRATION_MARKER } from './register-fleet-mail.mjs';
const repo = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-register-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=test');
  const marker = path.join(dir, '.fleet-mail-last-poll.json'); fs.writeFileSync(marker, '{}');
  const now = fs.statSync(marker).mtimeMs, calls = [], output = [];
  const deps = { home, now: () => now, platform: 'win32', ensure: true, quiet: true, stdout: text => output.push(text), spawnImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: args.includes('-Command') ? 'ok' : '' }; } };
  return { home, dir, marker, now, calls, output, deps };
}
test('ensure keeps successful tasks with a recent poll and quiet emits nothing', t => {
  const f = fixture(t); assert.equal(main(f.deps), 0); assert.equal(f.calls.length, 1); assert.match(f.calls[0].args.at(-1), /LastTaskResult -ne 0/); assert.deepEqual(f.output, []);
});
test('ensure repairs failed result even if poll is fresh then immediately polls once', t => {
  const f = fixture(t); const spawn = f.deps.spawnImpl; f.deps.spawnImpl = (...args) => { const result = spawn(...args); if (args[1].includes('-Command')) result.stdout = 'failed'; return result; };
  main(f.deps); assert.equal(f.calls.length, 3); assert.match(f.calls[1].args.at(-1), /register-fleet-mail.ps1$/); assert.deepEqual(f.calls[2].args.slice(1), ['--poll']); assert.equal(f.calls[2].opts.env.ORGIAST_HOME, f.home);
});
test('ensure repairs old or missing poll regardless of LastRunTime', t => {
  const f = fixture(t); main({ ...f.deps, now: () => f.now + STALE_POLL_MS + 1 }); assert.equal(f.calls.length, 3);
  fs.unlinkSync(f.marker); f.calls.length = 0; main(f.deps); assert.equal(f.calls.length, 3);
});
test('freshness boundary is exactly ten minutes', t => {
  const f = fixture(t); assert.equal(pollIsFresh(f.home, () => f.now + STALE_POLL_MS), true); assert.equal(pollIsFresh(f.home, () => f.now + STALE_POLL_MS + 1), false);
});
test('repair failure prevents immediate poll and reports failure', t => {
  const f = fixture(t); fs.unlinkSync(f.marker); const spawn = f.deps.spawnImpl;
  f.deps.spawnImpl = (...args) => { const result = spawn(...args); if (args[1].includes('-File')) result.status = 1; return result; };
  assert.throws(() => main(f.deps)); assert.equal(f.calls.length, 2);
});
test('converge registers hooks against current repo and sweeps only once', t => {
  const f = fixture(t); convergeFleetMail(f.deps); convergeFleetMail(f.deps);
  assert.deepEqual(f.calls.map(c => c.args.slice(1)), [['--hooks-only'], ['--sweep'], ['--hooks-only']]);
  assert.equal(path.resolve(f.calls[0].opts.env.ORGIAST_REPO), repo); assert.ok(fs.readFileSync(path.join(f.dir, MIGRATION_MARKER), 'utf8').trim());
});
test('failed initial sweep does not mark migration complete', t => {
  const f = fixture(t); assert.throws(() => convergeFleetMail({ ...f.deps, spawnImpl: (_cmd, args) => ({ status: args.includes('--sweep') ? 1 : 0 }) })); assert.equal(fs.existsSync(path.join(f.dir, MIGRATION_MARKER)), false);
});
test('manifest enforces both synchronous hooks and migration on task step', () => {
  const { items } = JSON.parse(fs.readFileSync(path.join(repo, 'tools/setup-manifest.json')));
  const hooks = items.filter(i => i.spec.hookScript === 'fleet-inbox-context.mjs');
  assert.deepEqual(hooks.map(i => i.spec.hookEvent).sort(), ['SessionStart', 'UserPromptSubmit']);
  for (const h of hooks) { assert.equal(h.spec.async, false); assert.equal(h.spec.timeout, 5); assert.equal(h.spec.hookArgs, ''); }
  const step = items.find(i => i.id === 'task:fleet-mail'); assert.ok(step.repair.includes('--converge')); assert.equal(step.spec.migrationMarker, `.claude/${MIGRATION_MARKER}`);
});
