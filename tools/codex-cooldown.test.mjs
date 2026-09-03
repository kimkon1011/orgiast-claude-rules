import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexCooldownRemaining, parseCodexResetUntil } from './codex-cooldown.mjs';

const now = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();

test('相対的な Codex 復帰時刻を解析する', () => {
  assert.equal(parseCodexResetUntil('try again in 4h 12m', now), now + (4 * 60 + 12) * 60_000);
  assert.equal(parseCodexResetUntil('try again in 35 minutes', now), now + 35 * 60_000);
  assert.equal(parseCodexResetUntil('try again in 2 hours', now), now + 2 * 60 * 60_000);
});

test('resets at のローカル時刻を解析する', () => {
  const expected = new Date(2026, 8, 3, 14, 30, 0, 0).getTime();
  assert.equal(parseCodexResetUntil('resets at 14:30', now), expected);
});

test('復帰時刻がなければ60分後を返す', () => {
  assert.equal(parseCodexResetUntil('usage limit', now), now + 60 * 60_000);
});

test('codexCooldownRemaining は未来だけ残り時間を返す', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cooldown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-cooldown.json');
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now + 12_345 } }));
  assert.equal(codexCooldownRemaining(now, file), 12_345);
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now - 1 } }));
  assert.equal(codexCooldownRemaining(now, file), 0);
  fs.writeFileSync(file, JSON.stringify({ groq: { until: now + 12_345 } }));
  assert.equal(codexCooldownRemaining(now, file), 0);
  fs.writeFileSync(file, '{broken');
  assert.equal(codexCooldownRemaining(now, file), 0);
});
