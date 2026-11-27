import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLaneProbeLock, laneDoctorProbe, laneProbeWorkDir, releaseLaneProbeLock, resetLaneProbeWorkDir } from './lane-doctor.mjs';

test('laneProbeWorkDir: 既定は ~/gb-offload/lane-doctor-work の固定フォルダー（一時フォルダーではない）', () => {
  const home = path.join(path.sep, 'h', 'u');
  const dir = laneProbeWorkDir({ env: {}, homedir: home });
  assert.equal(dir, path.join(home, 'gb-offload', 'lane-doctor-work'));
  assert.ok(!dir.includes('lane-codex-write-'));
  assert.equal(laneProbeWorkDir({ env: {}, homedir: home }), dir);
});

test('laneProbeWorkDir: ORGIAST_LANE_PROBE_DIR で上書きできる', () => {
  assert.equal(laneProbeWorkDir({ env: { ORGIAST_LANE_PROBE_DIR: '/x/y' }, homedir: '/h' }), '/x/y');
});

test('resetLaneProbeWorkDir: フォルダーは残し中身だけ空にする', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-workdir-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'gb-offload', 'lane-doctor-work');
  resetLaneProbeWorkDir(dir);
  assert.ok(fs.statSync(dir).isDirectory());
  fs.writeFileSync(path.join(dir, 'WRITE_OK.txt'), 'WRITE_OK');
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  assert.equal(resetLaneProbeWorkDir(dir), dir);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('probe ロック: 保持中は取得できず、解放後は取得できる', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-lock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'work');
  const first = await acquireLaneProbeLock(dir, { timeoutMs: 0 });
  assert.ok(first);
  assert.equal(await acquireLaneProbeLock(dir, { timeoutMs: 0 }), null);
  releaseLaneProbeLock(first);
  const second = await acquireLaneProbeLock(dir, { timeoutMs: 0 });
  assert.ok(second);
  releaseLaneProbeLock(second);
});

test('probe ロック: 死んだ pid と期限切れを回収する', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-lock-stale-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, owner, pidAlive] of [
    ['dead', { pid: 999, startedAt: 100 }, () => false],
    ['expired', { pid: 1, startedAt: 100 }, () => true],
  ]) {
    const dir = path.join(root, name), lockDir = `${dir}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
    const lock = await acquireLaneProbeLock(dir, { timeoutMs: 0, now: () => 1000, staleMs: 500, pidAlive });
    assert.ok(lock, name);
    releaseLaneProbeLock(lock);
  }
});

test('probe ロック: workDir の外にあり reset で消えない', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-lock-reset-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'work'), lock = await acquireLaneProbeLock(dir, { timeoutMs: 0 });
  resetLaneProbeWorkDir(dir);
  assert.ok(fs.existsSync(`${dir}.lock`));
  releaseLaneProbeLock(lock);
});

test('busy の native probe は Codex レーン停止扱いにしない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-lock-busy-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const token = `x.${Buffer.from(JSON.stringify({ email: 'test@example.com' })).toString('base64url')}.x`;
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: token } }));
  const result = await laneDoctorProbe({ home, platform: 'win32', providers: ['codex'], listWsl: () => '',
    nativeWriteProbe: async () => ({ viaChain: false, code: 1, busy: true, text: 'probe busy: 別の書き込み点検が実行中' }),
    notify: async () => ({ delivered: 'test' }) });
  assert.equal(result.lanes.codex.alive, true);
  assert.equal(result.lanes.codex.reason, 'configured:unprobed');
});
