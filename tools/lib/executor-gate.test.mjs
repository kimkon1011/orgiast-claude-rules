import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsageLimitUntil, isUsageLimitText, countUnattendedToday, loadBudget, providerLimitedUntil, decideCodexGate, parseDeferred, DAY_MS } from './executor-gate.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
};

test('実例の上限メッセージ "try again at Oct 4th, 2026 3:12 AM" をローカル時刻で解析する', () => {
  const now = new Date(2026, 9, 3, 12, 0, 0).getTime();
  const until = parseUsageLimitUntil("ERROR: You've hit your usage limit. Upgrade to Pro, or try again at Oct 4th, 2026 3:12 AM.", now);
  assert.equal(until, new Date(2026, 9, 4, 3, 12, 0).getTime());
});

test('解析できなければ24時間後', () => {
  const now = 1_000_000_000_000;
  assert.equal(parseUsageLimitUntil("You've hit your usage limit.", now), now + DAY_MS);
});

test('isUsageLimitText', () => {
  assert.equal(isUsageLimitText("You've hit your usage limit"), true);
  assert.equal(isUsageLimitText('all good'), false);
});

test('countUnattendedToday は当日・unattended・codex・非deferred だけ数える', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, '.claude', 'executor-usage.jsonl');
  const now = new Date(2026, 9, 3, 12, 0, 0).getTime();
  const row = (extra) => JSON.stringify({ t: new Date(now).toISOString(), provider: 'codex', origin: 'unattended', status: 'ok', ...extra });
  fs.writeFileSync(file, [row(), row(), row({ origin: 'interactive' }), row({ status: 'deferred' }), row({ provider: 'glm' }), row({ t: new Date(now - 2 * DAY_MS).toISOString() }), 'not json'].join('\n'));
  assert.equal(countUnattendedToday(file, 'codex', now), 2);
  assert.equal(countUnattendedToday(file, 'glm', now), 1);
  assert.equal(countUnattendedToday(path.join(dir, 'none.jsonl'), 'codex', now), 0);
});

test('loadBudget: 無ければ既定を作り、あれば尊重し、足りないキーは補う', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, '.claude', 'executor-budget.json');
  assert.deepEqual(loadBudget(file), { codex: { unattendedPerDay: 8 }, glm: { unattendedPerDay: 20 } });
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ codex: { unattendedPerDay: 3 } }));
  assert.deepEqual(loadBudget(file), { codex: { unattendedPerDay: 3 }, glm: { unattendedPerDay: 20 } });
});

test('providerLimitedUntil: 未来の until だけ有効', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'h.jsonl');
  const now = 1000;
  fs.writeFileSync(file, [{ provider: 'glm', until: 500 }, { provider: 'glm', until: 5000 }, { provider: 'deepseek', until: 100 }].map(JSON.stringify).join('\n'));
  assert.equal(providerLimitedUntil(file, 'glm', now), 5000);
  assert.equal(providerLimitedUntil(file, 'deepseek', now), 0);
  assert.equal(providerLimitedUntil(path.join(dir, 'none'), 'glm', now), 0);
});

test('decideCodexGate: cooldown が優先、次に無人割当', (t) => {
  const home = tmp(t);
  const now = Date.now();
  assert.deepEqual(decideCodexGate({ home, origin: 'unattended', now }), { deferred: false });
  fs.writeFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), `${Array.from({ length: 8 }, () => JSON.stringify({ t: new Date(now).toISOString(), provider: 'codex', origin: 'unattended', status: 'ok' })).join('\n')}\n`);
  assert.equal(decideCodexGate({ home, origin: 'unattended', now }).reason, 'unattended_budget');
  assert.equal(decideCodexGate({ home, origin: 'interactive', now }).deferred, false);
  fs.writeFileSync(path.join(home, '.claude', 'codex-cooldown.json'), JSON.stringify({ until: now + 5000, reason: 'usage_limit', t: now }));
  assert.equal(decideCodexGate({ home, origin: 'interactive', now }).reason, 'codex_cooldown');
  assert.equal(decideCodexGate({ home, origin: 'unattended', now }).reason, 'codex_cooldown');
});

test('parseDeferred: 75 以外は null、75 は stdout の JSON から retryAt を読む', () => {
  assert.equal(parseDeferred(1, '{"status":"deferred"}'), null);
  assert.deepEqual(parseDeferred(75, 'log\n{"status":"deferred","reason":"codex_cooldown","retryAt":123}\n'), { reason: 'codex_cooldown', retryAt: 123 });
  const fallback = parseDeferred(75, 'no json');
  assert.equal(fallback.reason, 'deferred');
  assert.ok(fallback.retryAt > Date.now());
});
