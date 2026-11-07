import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexRateLimits, readCodexWindows, readClaudeWindows, decideSweep, shouldStopTick } from './quota-windows.mjs';
const now = Date.UTC(2026, 9, 21), minute = 60_000;
const raw = { used_percent: 6, window_minutes: 10080, resets_at: 1793100581 };
const log = limits => JSON.stringify({ type: 'event_msg', payload: { rate_limits: limits } });
const w = (provider, window, usedPercent = 60, inMinutes = 60) => ({ provider, window, usedPercent, resetsAt: now + inMinutes * minute });
const claude = (a = 60, b = 30, t = 60, u = 500) => [w('claude', '5h', a, t), w('claude', '7d', b, u)];
test('parse primary/secondary with epoch seconds, latest record including null', () => {
  const both = parseCodexRateLimits(log({ primary: raw, secondary: { ...raw, window_minutes: 300 } }));
  assert.deepEqual(both.primary, { usedPercent: raw.used_percent, windowMinutes: raw.window_minutes, resetsAt: raw.resets_at * 1000 });
  assert.equal(both.secondary.windowMinutes, 300);
  assert.equal(both.exhausted, false);
  assert.deepEqual(parseCodexRateLimits(`${log({ primary: raw })}\n${log({ primary: null, secondary: null })}`), { primary: null, secondary: null, exhausted: true });
  assert.equal(parseCodexRateLimits(`${log({ primary: raw })}\n${log({ primary: { ...raw, used_percent: 40 }, secondary: null })}`).primary.usedPercent, 40);
  assert.equal(parseCodexRateLimits('').exhausted, false);
});
test('latest file across Windows and WSL roots; freshness and missing dirs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-windows-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'win'), wslHome = path.join(root, 'wsl');
  assert.deepEqual([...readCodexWindows({ home, wslHome, now })], []);
  for (const [h, age, used] of [[home, 10, 70], [wslHome, 1, 20]]) {
    const dir = path.join(h, '.codex/sessions/2026/10/21'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout.jsonl'); fs.writeFileSync(file, log({ primary: { ...raw, used_percent: used }, secondary: null }));
    fs.utimesSync(file, (now - age * 60 * minute) / 1000, (now - age * 60 * minute) / 1000);
  }
  const windows = readCodexWindows({ home, wslHome, now });
  assert.equal(windows[0].usedPercent, 20); assert.equal(windows[0].stale, false);
  assert.equal(readCodexWindows({ home, wslHome, now: now + 7 * 60 * minute })[0].stale, true);
});
test('Claude API mapping and unavailable reason use isolated credentials', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-api-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.match((await readClaudeWindows({ home })).reason, /credentials/);
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }));
  const windows = await readClaudeWindows({ home, fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 60, resets_at: new Date(now + minute).toISOString() }, seven_day: { utilization: 70, resets_at: new Date(now + 2 * minute).toISOString() } }) }) });
  assert.deepEqual(windows.map(x => x.window), ['5h', '7d']); assert.equal(windows[0].resetsAt, now + minute);
});
test('Claude 429 は直近10分の成功読み取りを stale で返し、期限切れ・非一時障害では返さない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cache-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }));
  const ok = { ok: true, json: async () => ({ five_hour: { utilization: 40, resets_at: new Date(now + 60 * minute).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(now + 500 * minute).toISOString() } }) };
  const http = status => async () => ({ ok: false, status });
  assert.equal((await readClaudeWindows({ home, fetchImpl: http(429), now: () => now })).length, 0, 'キャッシュ無しは従来どおり失敗');
  assert.equal((await readClaudeWindows({ home, fetchImpl: async () => ok, now: () => now })).length, 2);
  const cached = await readClaudeWindows({ home, fetchImpl: http(429), now: () => now + 5 * minute });
  assert.deepEqual(cached.map(x => [x.window, x.usedPercent, x.stale]), [['5h', 40, true], ['7d', 20, true]]);
  assert.equal(cached.reason, null); assert.match(cached.fromCache, /429/);
  assert.equal((await readClaudeWindows({ home, fetchImpl: http(429), now: () => now + 11 * minute })).length, 0, '10分超は使わない');
  assert.equal((await readClaudeWindows({ home, fetchImpl: http(429), now: () => now + 61 * minute, cacheMaxAgeMs: 999 * minute })).length, 0, 'resets_at が過去なら使わない');
  const denied = await readClaudeWindows({ home, fetchImpl: http(401), now: () => now + minute });
  assert.equal(denied.length, 0); assert.match(denied.reason, /401/);
});
test('decision boundary cases and concurrent ceilings', () => {
  assert.equal(decideSweep({ windows: claude(60, 30, 120), now }).length, 0);
  assert.equal(decideSweep({ windows: claude(), now })[0].window, '5h');
  assert.equal(decideSweep({ windows: claude(60, 98), now }).length, 0);
  assert.equal(decideSweep({ windows: claude(60, 70, 200, 60), now })[0].window, '7d');
  assert.equal(decideSweep({ windows: claude(95, 70, 200, 60), now }).length, 0);
  const codex = { ...w('codex', 'primary', 6), windowMinutes: 10080 };
  assert.equal(decideSweep({ windows: [codex], now })[0].provider, 'codex');
  assert.equal(decideSweep({ windows: claude(60, 30, 11), now }).length, 0);
  assert.match(decideSweep({ windows: [{ ...codex, stale: true }], now })[0].reason, /stale/);
  assert.equal(decideSweep({ windows: [{ ...codex, exhausted: true }], now }).length, 0);
  const both = decideSweep({ windows: claude(60, 60, 45, 60), now });
  assert.equal(both.length, 1); assert.equal(both[0].deadline, now + 42 * minute);
  assert.equal(decideSweep({ windows: [codex, w('codex', 'secondary', 99)], now }).length, 0);
  assert.equal(decideSweep({ windows: [w('codex', 'primary', 1, -1)], now }).length, 0);
});
test('stop on any window ceiling, exhausted or unavailable', () => {
  assert.equal(shouldStopTick({ windows: claude(), provider: 'claude' }), false);
  assert.equal(shouldStopTick({ windows: claude(60, 97), provider: 'claude' }), true);
  assert.equal(shouldStopTick({ windows: [], provider: 'codex' }), true);
  assert.equal(shouldStopTick({ windows: [{ ...w('codex', 'primary', 0), exhausted: true }], provider: 'codex' }), true);
});

test('quoted user examples never become rate-limit telemetry', () => {
  const example = JSON.stringify({ type: 'user', message: { content: log({ primary: null, secondary: null }) } });
  const parsed = parseCodexRateLimits(`${log({ primary: raw })}\n${example}`);
  assert.equal(parsed.exhausted, false); assert.equal(parsed.primary.usedPercent, raw.used_percent);
});

test('millisecond reset jitter keeps the same window identity', () => {
  const a = claude().map(w => ({ ...w, resetsAt: w.resetsAt + 828 }));
  const b = claude().map(w => ({ ...w, resetsAt: w.resetsAt + 971 }));
  const first = decideSweep({ windows: a, now })[0], next = decideSweep({ windows: b, now })[0];
  assert.equal(first.resetsAt, next.resetsAt);
  assert.equal(first.deadline, a[0].resetsAt - 3 * minute);
});
