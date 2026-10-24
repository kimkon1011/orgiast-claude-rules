import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callWithFallback, isPermanentBillingDetail } from './llm-fallback.mjs';
import { collectFindings, emptyOutputReason, isBillingSuspendedRow } from './delegation-health-check.mjs';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const MOONSHOT = '{"error":{"message":"Your account is suspended due to insufficient balance, please recharge your account","type":"exceeded_current_quota_error"}}';
const homes = [];
function home() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-health-billing-')); homes.push(dir); fs.mkdirSync(path.join(dir, '.claude')); return dir; }
function write(dir, name, value) { fs.writeFileSync(path.join(dir, '.claude', name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); }
function row(value) { return `${JSON.stringify(value)}\n`; }
test.after(() => homes.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

test('恒久課金切れは Moonshot 本文だけを検出し Groq の課金URLを誤検出しない', () => {
  assert.equal(isPermanentBillingDetail(MOONSHOT), true);
  assert.equal(isPermanentBillingDetail('Rate limit reached. See https://console.groq.com/settings/billing'), false);
  assert.equal(isBillingSuspendedRow({ status: 'http_429', reason: MOONSHOT }), true);
});

test('Moonshot の恒久課金切れ429は24時間 cooldown を書く', async () => {
  const dir = home();
  const cooldownFile = path.join(dir, '.claude', 'provider-cooldown.json');
  let calls = 0;
  await callWithFallback({
    start: { provider: 'kimi', model: 'kimi-k3' }, chain: [{ provider: 'groq', model: 'fallback' }],
    payloadFor: () => ({ url: 'https://example.invalid', init: {} }),
    fetchImpl: async () => ++calls === 1 ? new Response(MOONSHOT, { status: 429 }) : new Response('{}', { status: 200 }),
    sleepImpl: async () => {}, cooldownFile, now: () => NOW.getTime(),
  });
  const state = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')).kimi;
  assert.equal(state.until - state.at, 24 * 60 * 60 * 1000);
  assert.equal(state.reason, 'http_429');
  assert.equal(state.permanentBilling, true);
});

test('Moonshot 429だけの全滅は修理不能な残高切れとして low にする', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [0, 1, 2].map((n) => row({
    t: new Date(NOW.getTime() - n * 60_000).toISOString(), provider: 'kimi', status: 'http_429', reason: MOONSHOT, out: 0,
  })).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((item) => item.id === 'lane_outage_unrepaired'), false);
  const finding = findings.find((item) => item.id === 'provider_billing_suspended');
  assert.equal(finding?.severity, 'low');
  assert.equal('fixTask' in finding, false);
  assert.match(finding.evidence.join(' '), /3件.*insufficient balance/);
});

test("status:'network' は一過性インフラ障害として分類する", () => {
  assert.equal(emptyOutputReason({ status: 'network', out: 0 }), 'infra_transient');
});

test('reason を持たない 429 と network の混在でも全滅扱いにしない', () => {
  const dir = home();
  // 実測 2026-10-22: kimi 24h = http_429 440 + network 9。旧分類は network を no_output に
  // 落とすため every(isQuotaLimitedRow) が false になり high 起票され続けた。
  write(dir, 'executor-usage.jsonl', [
    ...[0, 1, 2].map((n) => row({ t: new Date(NOW.getTime() - n * 60_000).toISOString(), provider: 'kimi', status: 'http_429', out: 0 })),
    ...[0, 1, 2].map((n) => row({ t: new Date(NOW.getTime() - n * 120_000).toISOString(), provider: 'kimi', status: 'network', out: 0 })),
  ].join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((item) => item.id === 'lane_outage_unrepaired'), false);
  assert.equal(findings.find((item) => item.id === 'provider_usage_limit')?.severity, 'low');
});

test('24h の恒久課金切れ cooldown があれば reason 無しの 429 でも残高切れとして報告する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [0, 1, 2].map((n) => row({
    t: new Date(NOW.getTime() - n * 60_000).toISOString(), provider: 'kimi', status: 'http_429', out: 0,
  })).join(''));
  write(dir, 'provider-cooldown.json', { kimi: { until: NOW.getTime() + 86_400_000, at: NOW.getTime(), reason: 'http_429', permanentBilling: true } });
  const findings = collectFindings({ home: dir, now: NOW });
  const finding = findings.find((item) => item.id === 'provider_billing_suspended');
  assert.equal(finding?.severity, 'low');
  assert.match(finding.evidence.join(' '), /cooldown http_429/);
});
