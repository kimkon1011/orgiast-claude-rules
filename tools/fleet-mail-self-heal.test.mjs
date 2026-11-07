import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailySelfHeal } from './fleet-mail.mjs';

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('dailySelfHeal は Windows で1日1回だけ熱監視の登録を確認する', t => {
  const dir = tmp(t); const calls = [];
  const spawnSyncImpl = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: 'installed' }; };
  const now = () => Date.parse('2026-10-10T12:00:00Z');
  const first = dailySelfHeal({ dir, now, platform: 'win32', spawnSyncImpl });
  assert.equal(first.thermalGuard, 'installed');
  assert.match(calls[0].args.at(-1), /OrgiastThermalGuard[\s\S]*-Install/);
  assert.deepEqual(dailySelfHeal({ dir, now, platform: 'win32', spawnSyncImpl }), { skipped: 'today' });
  assert.equal(calls.length, 1);
});
test('dailySelfHeal は Windows 以外では何もしない', t => {
  assert.deepEqual(dailySelfHeal({ dir: tmp(t), platform: 'linux', spawnSyncImpl: () => { throw new Error('no'); } }), { skipped: 'platform' });
});
