import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addWaiting, doneWaiting, listWaiting, waitingDigest, acknowledgeWaiting } from './waiting-on-user.mjs';
import { checkToken } from './instagram-check-token.mjs';
const now = new Date('2026-10-23T03:00:00Z');
const item = { id: 'token', title: 'トークン登録', since: '2026-10-10', nextStep: 'トークンを貼る', check: { cmd: 'node check-token.mjs', doneWhenStdoutIncludes: 'lahaina_ushimado' } };
function fixture(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-user-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return { home, now }; }
test('pending days and empty ledger section', async t => {
  const opts = fixture(t), calls = [];
  assert.equal((await waitingDigest({ ...opts, persist: false })).text, '');
  await addWaiting(item, opts);
  const result = await waitingDigest({ ...opts, checkImpl: async (cmd, options) => { calls.push({ cmd, options }); return { stdout: 'pending' }; } });
  assert.match(result.text, /待ち 13 日: トークン登録 — 次の一手: トークンを貼る/);
  assert.equal(calls[0].cmd, item.check.cmd);
  assert.equal(calls[0].options.timeout, 20_000);
});
test('completion persists as done; acknowledged completion appears only once', async t => {
  const opts = fixture(t);
  await addWaiting(item, opts);
  const result = await waitingDigest({ ...opts, checkImpl: async () => ({ stdout: 'lahaina_ushimado' }) });
  assert.match(result.text, /完了しました: トークン登録/);
  assert.equal(listWaiting(opts.home)[0].status, 'done');
  await acknowledgeWaiting(result.completedIds, opts);
  assert.equal((await waitingDigest(opts)).text, '');
  await doneWaiting(item.id, opts);
  assert.equal((await waitingDigest(opts)).text, '');
});
test('failed or timed out check is unconfirmed and does not complete', async t => {
  const opts = fixture(t);
  await addWaiting(item, opts);
  const result = await waitingDigest({ ...opts, checkImpl: async () => { throw new Error('timeout SECRET'); } });
  assert.match(result.text, /待ち 13 日.*（未確認）/);
  assert.doesNotMatch(result.text, /SECRET|完了しました/);
  assert.notEqual(listWaiting(opts.home)[0].status, 'done');
});
test('preview does not consume completion and manual done stays pending until acknowledged', async t => {
  const opts = fixture(t);
  await addWaiting(item, opts);
  const before = JSON.stringify(listWaiting(opts.home));
  const preview = await waitingDigest({ ...opts, persist: false, checkImpl: async () => ({ stdout: 'lahaina_ushimado' }) });
  assert.match(preview.text, /完了しました/);
  assert.equal(JSON.stringify(listWaiting(opts.home)), before);
  await doneWaiting('token', opts);
  assert.match((await waitingDigest(opts)).text, /完了しました/);
});
test('CLI add/list/done with tmp home and input validation', async t => {
  const opts = fixture(t);
  const cli = (...args) => spawnSync(process.execPath, ['tools/waiting-on-user.mjs', ...args, '--home', opts.home], { encoding: 'utf8' });
  const added = cli('add', '--id', 'manual', '--title', '手作業', '--since', '2026-10-10', '--next-step', '登録');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(cli('list').stdout).pending.length, 1);
  assert.equal(cli('done', '--id', 'manual').status, 0);
  assert.equal(JSON.parse(cli('list').stdout).done.length, 1);
  await assert.rejects(addWaiting({ ...item, since: '2026-02-30' }, opts), /invalid_since/);
  await addWaiting(item, opts);
  await assert.rejects(addWaiting(item, opts), /duplicate_waiting_id/);
  await assert.rejects(doneWaiting('missing', opts), /waiting_id_not_found/);
});
test('token checker uses bearer header and exact account; never returns token or API error body', async t => {
  const { home } = fixture(t), envFile = path.join(home, '.env'), calls = [];
  fs.writeFileSync(envFile, 'INSTAGRAM_ACCESS_TOKEN="SECRET_TOKEN"\n');
  const result = await checkToken({ envFile, fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ username: 'lahaina_ushimado' }) }; } });
  assert.equal(result.message, 'lahaina_ushimado');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer SECRET_TOKEN');
  assert.equal(calls[0].url, 'https://graph.instagram.com/v21.0/me?fields=username');
  const wrong = await checkToken({ envFile, fetchImpl: async () => ({ ok: true, json: async () => ({ username: 'other_lahaina_ushimado' }) }) });
  assert.equal(wrong.status, 'pending');
  const failed = await checkToken({ envFile, fetchImpl: async () => { throw new Error('SECRET_TOKEN'); } });
  assert.equal(failed.status, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_TOKEN/);
  const missing = await checkToken({ envFile: path.join(home, 'absent.env'), fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(missing, { status: 'pending', message: 'token_missing' });
});
