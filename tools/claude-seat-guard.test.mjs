import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateClaudeSeatGuard, syncGbOffloadFlags } from './lib/claude-seat-guard.mjs';

function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-seat-guard-')); }
const NOW = Date.parse('2026-11-25T00:00:00Z');

test('週次・5時間閾値と取得不能を判定する', async () => {
  const home = tempHome();
  const weekly = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: {}, caller: 'test', readWindows: async () => [{ window: '7d', usedPercent: 95, resetsAt: NOW + 1000 }] });
  assert.equal(weekly.blocked, true);
  assert.equal(weekly.reason, 'weekly-threshold');
  const five = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: {}, caller: 'test', readWindows: async () => [{ window: '5h', usedPercent: 97, resetsAt: NOW + 1000 }] });
  assert.equal(five.reason, 'five-hour-threshold');
  const unavailable = await evaluateClaudeSeatGuard({ home: tempHome(), now: () => NOW, env: {}, caller: 'test', readWindows: async () => Object.assign([], { reason: 'no usage' }) });
  assert.deepEqual([unavailable.blocked, unavailable.reason], [false, 'usage-unavailable']);
});

test('pause と simulate を優先する', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'claude-seat-guard-pause.json'), JSON.stringify({ until: new Date(NOW + 60_000).toISOString(), reason: 'verify' }));
  const paused = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: { ORGIAST_CLAUDE_GUARD_SIMULATE_WEEKLY: '1' }, caller: 'test' });
  assert.equal(paused.source, 'pause-file');
  fs.unlinkSync(path.join(home, '.claude', 'claude-seat-guard-pause.json'));
  const simulated = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: { ORGIAST_CLAUDE_GUARD_SIMULATE_WEEKLY: '99' }, caller: 'test' });
  assert.deepEqual([simulated.blocked, simulated.weeklyPercent, simulated.source], [true, 99, 'simulate']);
});

test('取得不能時は直前の blocked 判定をリセットまで維持する', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'claude-seat-guard-state.json'), JSON.stringify({ blocked: true, source: 'oauth-usage', weeklyPercent: 99, fiveHourPercent: 12, resetsAt: new Date(NOW + 60_000).toISOString() }));
  const verdict = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: {}, caller: 'test', readWindows: async () => [] });
  assert.deepEqual([verdict.blocked, verdict.reason, verdict.source, verdict.weeklyPercent, verdict.resetsAt], [true, 'sticky-last-blocked', 'last-state', 99, new Date(NOW + 60_000).toISOString()]);
});

test('取得不能時も simulate の直前状態は引き継がない', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'claude-seat-guard-state.json'), JSON.stringify({ blocked: true, source: 'simulate', weeklyPercent: 99, resetsAt: new Date(NOW + 60_000).toISOString() }));
  const verdict = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: {}, caller: 'test', readWindows: async () => [] });
  assert.deepEqual([verdict.blocked, verdict.reason], [false, 'usage-unavailable']);
});

test('取得不能時も期限切れの直前状態は引き継がない', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'claude-seat-guard-state.json'), JSON.stringify({ blocked: true, source: 'oauth-usage', weeklyPercent: 99, resetsAt: new Date(NOW - 1).toISOString() }));
  const verdict = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: {}, caller: 'test', readWindows: async () => [] });
  assert.deepEqual([verdict.blocked, verdict.reason], [false, 'usage-unavailable']);
});

test('取得不能時は古いキャッシュでも週次上限を優先する', async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'quota-claude-window-cache.json'), JSON.stringify({ observedAt: NOW - 11 * 60_000, windows: [{ window: '5h', usedPercent: 1, resetsAt: NOW + 30_000 }, { window: '7d', usedPercent: 99, resetsAt: NOW + 60_000 }] }));
  fs.writeFileSync(path.join(home, '.claude', 'claude-seat-guard-state.json'), JSON.stringify({ blocked: true, source: 'oauth-usage', weeklyPercent: 98, resetsAt: new Date(NOW + 120_000).toISOString() }));
  const verdict = await evaluateClaudeSeatGuard({ home, now: () => NOW, env: {}, caller: 'test', readWindows: async () => [] });
  assert.deepEqual([verdict.blocked, verdict.reason, verdict.source, verdict.weeklyPercent, verdict.resetsAt], [true, 'weekly-threshold', 'stale-cache', 99, new Date(NOW + 60_000).toISOString()]);
});

test('自分の旗だけを作成・撤去する', () => {
  const home = tempHome();
  const state = path.join(home, 'gb-offload', 'state');
  fs.mkdirSync(state, { recursive: true });
  syncGbOffloadFlags({ home, verdict: { blocked: true, reason: 'weekly-threshold', resetsAt: '2026-11-26T00:00:00Z' } });
  assert.match(fs.readFileSync(path.join(state, 'no-new'), 'utf8'), /^set-by claude-seat-guard/);
  fs.writeFileSync(path.join(state, 'no-resume'), 'set-by human\n');
  syncGbOffloadFlags({ home, verdict: { blocked: false, reason: 'below-threshold', resetsAt: null } });
  assert.equal(fs.existsSync(path.join(state, 'no-new')), false);
  assert.equal(fs.readFileSync(path.join(state, 'no-resume'), 'utf8'), 'set-by human\n');
});
