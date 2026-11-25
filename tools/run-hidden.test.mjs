import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./run-hidden.vbs', import.meta.url));
const windows = process.platform === 'win32';

async function setDirectoryCreationTime(directory, date) {
  const escaped = directory.replaceAll("'", "''");
  await exec('powershell.exe', ['-NoProfile', '-Command',
    `[IO.Directory]::SetCreationTime('${escaped}', [DateTime]::Parse('${date.toISOString()}'))`]);
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden runner '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logs = path.join(home, '.claude', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const script = path.join(home, 'watch.mjs');
  fs.writeFileSync(script, `
    console.log('started:' + process.argv[2]);
    console.error('stderr:' + process.argv[2]);
    setTimeout(() => { process.exitCode = Number(process.argv[3] || 0); }, 300);
  `);
  const run = async (id, code = 0) => {
    try {
      await exec(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'),
        ['//nologo', runner, process.execPath, script, id, String(code)],
        { cwd: home, env: { ...process.env, USERPROFILE: home }, windowsHide: true, timeout: 15000 });
      return 0;
    } catch (error) { if (Number.isInteger(error.code)) return error.code; throw error; }
  };
  const lines = () => fs.readdirSync(logs).filter(n => n.endsWith('.log'))
    .flatMap(n => fs.readFileSync(path.join(logs, n), 'utf8').split(/\r?\n/));
  return { logs, run, lines };
}

test('simultaneous wrappers each run once and retain stdout/stderr', { skip: !windows }, async t => {
  const { logs, run, lines } = fixture(t);
  const ids = ['one', 'two', 'three', 'four'];
  assert.deepEqual(await Promise.all(ids.map(id => run(id))), [0, 0, 0, 0]);
  const output = lines();
  for (const id of ids) {
    assert.equal(output.filter(l => l === `started:${id}`).length, 1);
    assert.equal(output.filter(l => l === `stderr:${id}`).length, 1);
  }
  assert.equal(fs.existsSync(path.join(logs, 'watch.log.runner-lock')), false);
});

test('an existing primary reservation uses distinct fallbacks without removing its lock', { skip: !windows }, async t => {
  const { logs, run, lines } = fixture(t);
  const lock = path.join(logs, 'watch.log.runner-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(logs, 'watch.log'), 'previous output\n');
  const ids = ['one', 'two', 'three', 'four'];
  assert.deepEqual(await Promise.all(ids.map(id => run(id))), [0, 0, 0, 0]);
  assert.equal(fs.readdirSync(logs).filter(n => n.startsWith('watch.locked-')).length, 4);
  assert.equal(fs.readFileSync(path.join(logs, 'watch.log'), 'utf8'), 'previous output\n');
  assert.equal(fs.existsSync(lock), true);
  const output = lines();
  for (const id of ids) assert.equal(output.filter(l => l === `started:${id}`).length, 1);
});

test('a stale primary reservation is recovered and writes to the primary log', { skip: !windows }, async t => {
  const { logs, run } = fixture(t);
  const lock = path.join(logs, 'watch.log.runner-lock');
  fs.mkdirSync(lock);
  await setDirectoryCreationTime(lock, new Date(Date.now() - 3 * 60 * 60 * 1000));
  assert.equal(await run('stale'), 0);
  const primary = fs.readFileSync(path.join(logs, 'watch.log'), 'utf8');
  assert.match(primary, /run-hidden: stale primary lock recovered:/);
  assert.match(primary, /started:stale/);
  assert.equal(fs.readdirSync(logs).some(n => n.startsWith('watch.locked-')), false);
  assert.equal(fs.existsSync(lock), false);
});

test('a fresh primary reservation uses a fallback log', { skip: !windows }, async t => {
  const { logs, run } = fixture(t);
  const lock = path.join(logs, 'watch.log.runner-lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(logs, 'watch.log'), 'previous output\n');
  assert.equal(await run('fresh'), 0);
  assert.equal(fs.readFileSync(path.join(logs, 'watch.log'), 'utf8'), 'previous output\n');
  const fallback = fs.readdirSync(logs).find(n => n.startsWith('watch.locked-'));
  assert.ok(fallback);
  assert.match(fs.readFileSync(path.join(logs, fallback), 'utf8'), /started:fresh/);
  assert.equal(fs.existsSync(lock), true);
});

test('child failure is returned without replay and releases the reservation', { skip: !windows }, async t => {
  const { logs, run, lines } = fixture(t);
  assert.equal(await run('failure', 7), 7);
  assert.equal(lines().filter(l => l === 'started:failure').length, 1);
  assert.equal(fs.existsSync(path.join(logs, 'watch.log.runner-lock')), false);
});
