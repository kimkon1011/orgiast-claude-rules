import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callWithFallback, isPermanentBillingDetail } from './llm-fallback.mjs';
import { collectFindings, emptyOutputReason, isBillingSuspendedRow } from './delegation-health-check.mjs';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const MOONSHOT = '{"error":{"message":"Your account is suspended due to insufficient balance, please recharge your account","type":"exceeded_current_quota_error"}}';
const XAI_CREDITS = '{"code":"permission-denied","error":"Your team ... has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';
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

test('xAI 403 クレジット切れ本文は恒久課金、Codex の時間回復型 purchase more credits は除外する', () => {
  assert.equal(isPermanentBillingDetail(XAI_CREDITS), true);
  assert.equal(isPermanentBillingDetail('purchase more credits or try again at 3:00 PM'), false);
  assert.equal(isBillingSuspendedRow({ status: 'http_403', reason: XAI_CREDITS }), true);
  assert.equal(isBillingSuspendedRow({ status: 'http_403', reason: 'invalid api key' }), false);
});

test('grok の http_403 xAIクレジット切れだけの全滅は lane_outage_unrepaired を起票しない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [0, 1, 2, 3, 4, 5, 6].map((n) => row({
    t: new Date(NOW.getTime() - n * 60_000).toISOString(), provider: 'grok', status: 'http_403', reason: XAI_CREDITS, out: 0,
  })).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((item) => item.id === 'lane_outage_unrepaired'), false);
  const finding = findings.find((item) => item.id === 'provider_billing_suspended');
  assert.equal(finding?.severity, 'low');
  assert.equal('fixTask' in finding, false);
});

test('xAI 403 クレジット切れは grok に permanent billing の 24h cooldown を書く', async () => {
  const dir = home();
  const cooldownFile = path.join(dir, '.claude', 'provider-cooldown.json');
  let calls = 0;
  await callWithFallback({
    start: { provider: 'grok', model: 'grok-4' }, chain: [{ provider: 'groq', model: 'fallback' }],
    payloadFor: () => ({ url: 'https://example.invalid', init: {} }),
    fetchImpl: async () => ++calls === 1 ? new Response(XAI_CREDITS, { status: 403 }) : new Response('{}', { status: 200 }),
    sleepImpl: async () => {}, cooldownFile, now: () => NOW.getTime(),
  });
  const state = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')).grok;
  assert.equal(state.until - state.at, 24 * 60 * 60 * 1000);
  assert.equal(state.reason, 'http_403');
  assert.equal(state.permanentBilling, true);
});

test('OpenRouter経由のKimiの恒久課金切れ429はOpenRouterに24時間 cooldown を書く', async () => {
  const dir = home();
  const cooldownFile = path.join(dir, '.claude', 'provider-cooldown.json');
  let calls = 0;
  await callWithFallback({
    start: { provider: 'kimi', model: 'kimi-k3' }, chain: [{ provider: 'groq', model: 'fallback' }],
    payloadFor: () => ({ url: 'https://example.invalid', init: {} }),
    fetchImpl: async () => ++calls === 1 ? new Response(MOONSHOT, { status: 429 }) : new Response('{}', { status: 200 }),
    sleepImpl: async () => {}, cooldownFile, now: () => NOW.getTime(),
  });
  const state = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')).openrouter;
  assert.equal(state.until - state.at, 24 * 60 * 60 * 1000);
  assert.equal(state.reason, 'http_429');
  assert.equal(state.permanentBilling, true);
});

test('恒久課金切れ cooldown は読み戻しで15分に切り詰めず、kimi 直APIを叩かない', async () => {
  const dir = home();
  const cooldownFile = path.join(dir, '.claude', 'provider-cooldown.json');
  fs.writeFileSync(cooldownFile, JSON.stringify({
    kimi: { until: NOW.getTime() + 86_400_000, at: NOW.getTime(), reason: 'http_429', permanentBilling: true },
  }));
  const fetched = [];
  await callWithFallback({
    start: { provider: 'kimi', model: 'kimi-k3' },
    chain: [{ provider: 'groq', model: 'fallback' }],
    payloadFor: (c) => ({ url: c.provider, init: {} }),
    fetchImpl: async (url) => { fetched.push(url); return new Response('{}', { status: 200 }); },
    sleepImpl: async () => {},
    cooldownFile,
    now: () => NOW.getTime() + 20 * 60_000,
  });
  assert.equal(fetched.includes('kimi'), false);
  const state = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')).kimi;
  assert.equal(state.until, NOW.getTime() + 86_400_000);
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

test('cooldown 中に no_output が混じっても lane_outage_unrepaired にしない', () => {
  // 実測 2026-11-14: gemini 470 件 = quota_limited 469 + no_output 1。
  // provider-cooldown に reason:"billing" のエントリがあるが permanentBilling なし。
  // 従来は benign.length(469) !== attempts.length(470) で lane_outage_unrepaired。
  const dir = home();
  write(dir, 'executor-usage.jsonl', [
    ...[0, 1, 2, 3].map((n) => row({
      t: new Date(NOW.getTime() - n * 60_000).toISOString(), provider: 'gemini', status: 'http_429', out: 0,
    })),
    ...[0, 1, 2, 3, 4].map((n) => row({
      t: new Date(NOW.getTime() - n * 120_000).toISOString(), provider: 'gemini', status: 'http_429', out: 0,
    })),
    // no_output: status='error' は infra_transient/quota_limited どちらにも該当せず no_output になる
    row({ t: new Date(NOW.getTime() - 300_000).toISOString(), provider: 'gemini', status: 'error', out: 0 }),
  ].join(''));
  write(dir, 'provider-cooldown.json', { gemini: { until: NOW.getTime() + 86_400_000, at: NOW.getTime(), reason: 'billing' } });
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((item) => item.id === 'lane_outage_unrepaired'), false);
  const finding = findings.find((item) => item.id === 'provider_usage_limit');
  assert.equal(finding?.severity, 'low');
  assert.equal('fixTask' in finding, false);
  assert.match(finding.evidence.join(' '), /cooldown 中の artifact/);
});
