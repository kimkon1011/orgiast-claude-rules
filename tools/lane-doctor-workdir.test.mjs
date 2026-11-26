import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneProbeWorkDir, resetLaneProbeWorkDir } from './lane-doctor.mjs';

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
