import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsageLimitUntil, isUsageLimitText, countUnattendedToday, loadBudget, providerLimitedUntil, decideCodexGate, parseDeferred, readCodexCooldownUntil, writeCodexCooldownFile, DAY_MS } from './executor-gate.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
};

const HOUR = 60 * 60 * 1000;

// 2026-10-11 03:23 に実測した値(週次リセット 90.5 時間)。これが素通りすると
// 枠が回復しても Codex が再試行されない(cooldown は自動では消えない)。
test('writeCodexCooldownFile は5時間超の再開時刻を5時間へ丸め reason に :capped を残す', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, '.claude', 'codex-cooldown.json');
  const now = new Date(2026, 9, 11, 3, 23, 0).getTime();
  writeCodexCooldownFile(file, now + 90.5 * HOUR, now);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.until, now + 5 * HOUR);
  assert.equal(saved.reason, 'usage_limit:capped');
  assert.equal(saved.t, now);
  assert.equal(readCodexCooldownUntil(file, now), now + 5 * HOUR);
});

test('writeCodexCooldownFile は5時間以内の再開時刻をそのまま書く', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, '.claude', 'codex-cooldown.json');
  const now = new Date(2026, 9, 11, 3, 23, 0).getTime();
  const until = now + 3 * HOUR;
  writeCodexCooldownFile(file, until, now);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.until, until);
  assert.equal(saved.reason, 'usage_limit');
  assert.equal(readCodexCooldownUntil(file, now), until);
});

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

// writeCodexCooldown()(codex-cooldown.mjs)は { codex: { until, reason, at } } 形式で書く。
// トップレベルの until しか読まないと、codex-do が書いたクールダウンを尊重せず毎回起動してしまう
// (2026-10-17 実測)。
test('readCodexCooldownUntil は { codex: { until } } 形式と旧トップレベル形式の両方を読む', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, '.claude', 'codex-cooldown.json');
  const now = 1_000_000;
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now + 5000, reason: 'usage_limit', at: now } }));
  assert.equal(readCodexCooldownUntil(file, now), now + 5000);
  fs.writeFileSync(file, JSON.stringify({ until: now + 7000, reason: 'usage_limit', t: now }));
  assert.equal(readCodexCooldownUntil(file, now), now + 7000);
  fs.writeFileSync(file, JSON.stringify({ codex: { until: now - 1 }, until: now - 2 }));
  assert.equal(readCodexCooldownUntil(file, now), 0);
  assert.equal(readCodexCooldownUntil(path.join(dir, 'missing.json'), now), 0);
});

test('parseDeferred: 75 以外は null、75 は stdout の JSON から retryAt を読む', () => {
  assert.equal(parseDeferred(1, '{"status":"deferred"}'), null);
  assert.deepEqual(parseDeferred(75, 'log\n{"status":"deferred","reason":"codex_cooldown","retryAt":123}\n'), { reason: 'codex_cooldown', retryAt: 123 });
  const fallback = parseDeferred(75, 'no json');
  assert.equal(fallback.reason, 'deferred');
  assert.ok(fallback.retryAt > Date.now());
});
