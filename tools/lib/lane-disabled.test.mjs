import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { disabledLanes, disableLanesTemporarily, readRestoredAt, restoredLanesFile, restoreExpiredDisabledLanes } from './lane-disabled.mjs';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-disabled-until-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

test('disabledLanes は until が過去の一時停止を無効として扱わない', () => {
  const home = makeHome();
  const now = Date.now();
  fs.writeFileSync(path.join(home, '.claude', 'lanes-disabled.json'), JSON.stringify({
    'cursor-agent': { reason: 'auth_missing', until: now - 60_000, at: new Date(now - 3_600_000).toISOString() },
    gemini: { reason: 'health', until: now + 60_000, at: new Date(now).toISOString() },
  }, null, 2) + '\n');
  const set = disabledLanes(home, now);
  assert.equal(set.has('cursor-agent'), false);
  assert.equal(set.has('gemini'), true);
  assert.equal(set.has('gemini-cli'), true);
});

test('disabledLanes は until の無い手動停止は残す', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.claude', 'lanes-disabled.json'), JSON.stringify({
    groq: { reason: 'manual' },
  }, null, 2) + '\n');
  assert.equal(disabledLanes(home).has('groq'), true);
});

test('disableLanesTemporarily は Cursor を修復・停止対象に含めない', () => {
  const home = makeHome();
  const now = Date.now();
  disableLanesTemporarily(home, [{ name: 'cursor-agent', reason: 'failure_rate', calls: 7, failures: 4 }], now);
  assert.equal(disabledLanes(home, now).has('cursor-agent'), false);
  assert.equal(disabledLanes(home, now + 6 * 60 * 60 * 1000 + 1).has('cursor-agent'), false);
});

test('probe で復帰したら lanes-restored.json に復帰時刻が入る', () => {
  const home = makeHome();
  const now = Date.now();
  fs.writeFileSync(path.join(home, '.claude', 'lanes-disabled.json'), JSON.stringify({
    groq: { reason: 'failure_rate', until: now - 60_000, at: new Date(now - 3_600_000).toISOString() },
  }, null, 2) + '\n');
  const health = { lanes: { groq: { alive: true, reason: 'probe_ok' } }, repairs: [] };
  assert.deepEqual(restoreExpiredDisabledLanes(health, home, now), ['groq']);
  // 復帰時刻（epoch ms）がレーン名（小文字）キーで記録されている
  assert.deepEqual(readRestoredAt(home), { groq: now });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'lanes-restored.json')), true);
  // 復帰前のレーンが無いときはファイルを作らない
  const home2 = makeHome();
  assert.deepEqual(readRestoredAt(home2), {});
  assert.equal(fs.existsSync(restoredLanesFile(home2)), false);
});
