import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { addItem, listItems } from './kim-inbox.mjs';
const exec = promisify(execFile);
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-lock-'));
  const dir = path.join(home, '.claude/kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  const body = path.join(home, 'body.txt'); fs.writeFileSync(body, 'テスト通知');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = (args = []) => exec(process.execPath, ['tools/kim-inbox.mjs', '--add', '--body-file', body, ...args], { env: { ...process.env, ORGIAST_HOME: home }, timeout: 15000 });
  return { home, dir, cli };
}
function lockFile(dir, key, pid, old) {
  const file = path.join(dir, `${key}.lock`); fs.writeFileSync(file, pid);
  if (old) { const date = new Date(Date.now() - 120000); fs.utimesSync(file, date, date); }
  return file;
}
for (const pid of ['', 'not-a-pid', '0', '1.5']) {
  test(`CLI: 古い不正PID ${JSON.stringify(pid)} を回収`, async t => {
    const { dir, cli } = setup(t);
    const file = lockFile(dir, 'info-aggregation', pid, true);
    assert.equal(JSON.parse((await cli()).stdout).status, 'open');
    assert.equal(fs.existsSync(file), false);
  });
}
test('CLI: 終了済みプロセスの古いロックを回収', async t => {
  const { dir, cli } = setup(t);
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
  assert.equal(child.status, 0);
  lockFile(dir, 'info-aggregation', String(child.pid), true);
  assert.equal(JSON.parse((await cli()).stdout).status, 'open');
});
for (const [name, pid, old] of [['新しい空PID', '', false], ['生存PID', String(process.pid), true]]) {
  test(`CLI: ${name} は奪わず約5秒待って失敗`, async t => {
    const { dir, cli } = setup(t);
    const file = lockFile(dir, 'info-aggregation', pid, old);
    const start = Date.now();
    await assert.rejects(cli(), error => error.code === 1 && /台帳が使用中/.test(error.stderr));
    assert.ok(Date.now() - start >= 4900);
    assert.equal(fs.readFileSync(file, 'utf8'), pid);
  });
}
test('実プロセス: 1秒を超えて待ち、5秒以内に解放されれば成功', async t => {
  const { home, dir } = setup(t);
  const file = lockFile(dir, 'info-aggregation', String(process.pid), false);
  const runner = path.join(home, 'ready.mjs');
  fs.writeFileSync(runner, `import { main } from ${JSON.stringify(new URL('./kim-inbox.mjs', import.meta.url).href)};
process.send('ready');
process.exitCode = await main(['--add', '--body-file', ${JSON.stringify(path.join(home, 'body.txt'))}]);
process.disconnect();`);
  const child = fork(runner, [], { silent: true, env: { ...process.env, ORGIAST_HOME: home } });
  t.after(() => child.kill());
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(Error('ready 前に終了'))); });
  const start = Date.now();
  const timer = setTimeout(() => fs.unlinkSync(file), 2000);
  t.after(() => clearTimeout(timer));
  assert.equal(await exited, 0, errors);
  assert.ok(Date.now() - start >= 1900);
  assert.equal(JSON.parse(output).status, 'open');
});
test('項目の空PIDも回収し、個別項目の待ちが他の通知を止めない', async t => {
  const { home, dir, cli } = setup(t);
  const item = await addItem(home, { text: 'テスト通知' });
  const file = lockFile(dir, item.id, '', true);
  await cli(); assert.equal(fs.existsSync(file), false);
  lockFile(dir, item.id, String(process.pid), true);
  const waiting = cli();
  // 子プロセスの項目ロック待ちの間にも別の info と ask を追加できる。
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(fs.existsSync(path.join(dir, 'info-aggregation.lock')), false);
  await addItem(home, { text: '独立した別件' });
  await cli(['--kind', 'ask']);
  fs.unlinkSync(file);
  await waiting;
  assert.equal(listItems(home).find(i => i.id === item.id).repeatCount, 3);
});
test('転送処理の実行時には集約ロックを解放している', async t => {
  const { home, dir } = setup(t);
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=test-remote');
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ 'test-remote': { account: 'test@example.test' } }));
  await addItem(home, { text: '転送本文', execImpl: async () => {
    assert.equal(fs.existsSync(path.join(dir, 'info-aggregation.lock')), false);
    return { stdout: '送信済み: mail-test\n' };
  } });
});
