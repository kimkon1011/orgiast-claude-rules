import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBeacon } from './fleet-beacon.mjs';

test('optional 項目(mobile-standby)の NG もビーコンの failing に載る（fleet-status の「失敗:」欄）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
  const beacon = buildBeacon({ home, label: 'pc-1', identity: {}, pcMap: {}, results: [
    { item: { id: 'a', severity: 'required' }, status: 'OK' },
    { item: { id: 'mobile-standby', severity: 'optional' }, status: 'NG', reason: 'VSCode の痕跡あり but code.cmd 未検出' },
  ] });
  assert.deepEqual(beacon.failing, ['mobile-standby']);
  assert.equal(beacon.steps.find((s) => s.id === 'mobile-standby').status, 'fail');
  assert.match(beacon.steps.find((s) => s.id === 'mobile-standby').reason, /code\.cmd 未検出/);
});
