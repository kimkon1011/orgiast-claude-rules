import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexCooldownRemaining, codexHardBlockBypass, parseCodexResetUntil, writeCodexCooldown } from './codex-cooldown.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test('parseCodexResetUntil は複合・分・時間の相対時間を解釈する', () => {
  const now = new Date('2026-09-03T10:00:00+09:00').getTime();
  assert.equal(parseCodexResetUntil('try again in 4h 12m', now), now + 4 * HOUR + 12 * MINUTE);
  assert.equal(parseCodexResetUntil('try again in 35 minutes', now), now + 35 * MINUTE);
  assert.equal(parseCodexResetUntil('try again in 2 hours', now), now + 2 * HOUR);
  assert.equal(parseCodexResetUntil('quota exceeded; 4h12m remaining', now), now + 4 * HOUR + 12 * MINUTE);
});

test('parseCodexResetUntil は resets at HH:MM をローカル時刻として解釈する', () => {
  const now = new Date(2026, 8, 3, 10, 0, 0).getTime();
  assert.equal(parseCodexResetUntil('resets at 14:30', now), new Date(2026, 8, 3, 14, 30, 0).getTime());
  const late = new Date(2026, 8, 3, 15, 0, 0).getTime();
  assert.equal(parseCodexResetUntil('resets at 14:30', late), new Date(2026, 8, 4, 14, 30, 0).getTime());
});

test('parseCodexResetUntil は日付付き resets と ISO8601 を解釈する', () => {
  const now = new Date(2026, 8, 3, 10, 0, 0).getTime();
  assert.equal(parseCodexResetUntil('resets 2026-09-07 11:27', now), new Date(2026, 8, 7, 11, 27, 0).getTime());
  assert.equal(parseCodexResetUntil('available 2026-09-07T11:27:00+09:00', now), Date.parse('2026-09-07T11:27:00+09:00'));
});

test('parseCodexResetUntil は英語月名付きの絶対日時を解釈する', () => {
  const now = Date.parse('2026-09-03T20:00:00+09:00');
  assert.equal(parseCodexResetUntil("ERROR: You've hit your usage limit. try again at Sep 7th, 2026 11:27 AM", now), new Date(2026, 8, 7, 11, 27).getTime());
  assert.equal(parseCodexResetUntil('try again at September 7, 2026 11:27 PM', now), new Date(2026, 8, 7, 23, 27).getTime());
  assert.equal(parseCodexResetUntil('resets at Sep 7 2026 11:27', now), new Date(2026, 8, 7, 11, 27).getTime());
  assert.equal(parseCodexResetUntil('try again at Sep 7th, 2026 11:27 AM (UTC)', now), Date.UTC(2026, 8, 7, 11, 27));
});

test('parseCodexResetUntil は12 AM/PMと年省略時の直近の未来を解釈する', () => {
  const now = new Date(2026, 8, 8, 20, 0).getTime();
  assert.equal(parseCodexResetUntil('try again at Sep 9th 12:05 AM', now), new Date(2026, 8, 9, 0, 5).getTime());
  assert.equal(parseCodexResetUntil('try again at Sep 9th 12:05 PM', now), new Date(2026, 8, 9, 12, 5).getTime());
  assert.equal(parseCodexResetUntil('try again at Sep 7th 11:27 AM', now), new Date(2027, 8, 7, 11, 27).getTime());
});

test('parseCodexResetUntil は年明示の過去日時なら now を返す', () => {
  const now = new Date(2026, 8, 8, 20, 0).getTime();
  assert.equal(parseCodexResetUntil('try again at Sep 7th, 2026 11:27 AM', now), now);
});

test('parseCodexResetUntil は該当なしなら60分後を返す', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseCodexResetUntil('usage limit', now), now + HOUR);
});

test('codexCooldownRemaining は未来だけ残り時間を返し、不正状態は0にする', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cooldown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-cooldown.json');
  const now = 1_700_000_000_000;

  fs.writeFileSync(file, JSON.stringify({ codex: { until: now + MINUTE } }));
  assert.equal(codexCooldownRemaining(now, file), MINUTE);
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now - 1 } }));
  assert.equal(codexCooldownRemaining(now, file), 0);
  fs.writeFileSync(file, JSON.stringify({ groq: { until: now + MINUTE } }));
  assert.equal(codexCooldownRemaining(now, file), 0);
  assert.equal(codexCooldownRemaining(now, path.join(dir, 'missing.json')), 0);
  fs.writeFileSync(file, '{broken');
  assert.equal(codexCooldownRemaining(now, file), 0);
});

test('writeCodexCooldown は他プロバイダを保持する', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cooldown-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-cooldown.json');
  const groq = { until: 123, reason: 'http_429', at: 100 };
  fs.writeFileSync(file, JSON.stringify({ groq }));
  const until = Date.now() + HOUR;
  writeCodexCooldown(until, file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(state.groq, groq);
  assert.equal(state.codex.until, until);
  assert.equal(state.codex.reason, 'usage_limit');
  assert.ok(Number.isFinite(state.codex.at));
});

test('writeCodexCooldown の reason は省略時に後方互換で、明示時は保存する', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cooldown-reason-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-cooldown.json');
  writeCodexCooldown(Date.now() + HOUR, file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).codex.reason, 'usage_limit');
  writeCodexCooldown(Date.now() + HOUR, file, 'usage_limit_no_fallback');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).codex.reason, 'usage_limit_no_fallback');
});

test('codexHardBlockBypass は有効なクールダウンとフォールバック不能が揃った時だけ解除する', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hard-block-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-cooldown.json');
  const now = 1_700_000_000_000;
  assert.deepEqual(codexHardBlockBypass(now, file, { hasGemini: true }), { bypass: false, until: 0, reason: '' });
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now + HOUR, reason: 'usage_limit' } }));
  assert.equal(codexHardBlockBypass(now, file, { hasGemini: true }).bypass, false);
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now + HOUR, reason: 'usage_limit_no_fallback' } }));
  assert.equal(codexHardBlockBypass(now, file, { hasGemini: true }).bypass, true);
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now + HOUR, reason: 'usage_limit' } }));
  assert.equal(codexHardBlockBypass(now, file, { hasGemini: false }).bypass, true);
});
