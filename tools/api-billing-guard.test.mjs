import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectBillingMode, handleBilling, notifyBilling } from './api-billing-guard.mjs';
import { issueApprovals } from './claude-impl-approval.mjs';
const fixture = { oauthAccount: { accountUuid: 'account', emailAddress: 'test@example.invalid', organizationUuid: 'org', organizationName: 'Team', hasExtraUsageEnabled: false, billingType: 'stripe_subscription' } };
const base = { env: {}, claudeJson: {}, credentials: {}, settings: {} };
for (const [label, data, mode] of [
  ['kim-PC', { claudeJson: fixture, credentials: { claudeAiOauth: { subscriptionType: 'team' } } }, 'subscription'],
  ['API key wins over subscription', { env: { ANTHROPIC_API_KEY: 'SECRET' }, claudeJson: fixture }, 'api'],
  ['auth token', { env: { ANTHROPIC_AUTH_TOKEN: 'SECRET' } }, 'api'],
  ['helper', { settings: { apiKeyHelper: 'get-key' } }, 'api'],
  ['prepaid', { claudeJson: { oauthAccount: { billingType: 'prepaid' } } }, 'api'],
  ['proxy wins over key', { env: { ANTHROPIC_BASE_URL: 'https://proxy.invalid', ANTHROPIC_API_KEY: 'SECRET' } }, 'proxy'],
  ['official base', { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'SECRET' } }, 'api'],
  ['unknown', {}, 'unknown'],
  ['broken base', { env: { ANTHROPIC_BASE_URL: 'invalid' } }, 'unknown'],
  ...['team', 'pro', 'max', 'enterprise'].map(subscriptionType => [subscriptionType, { credentials: { claudeAiOauth: { subscriptionType, get accessToken() { throw Error('must not inspect secrets'); } } } }, 'subscription']),
]) test(`detect: ${label}`, () => { const got = detectBillingMode({ ...base, ...data }); assert.equal(got.mode, mode); assert.doesNotMatch(JSON.stringify(got), /SECRET/); });
function home(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }
test('extra usage metadata and account are preserved', () => {
  const got = detectBillingMode({ ...base, claudeJson: { oauthAccount: { ...fixture.oauthAccount, hasExtraUsageEnabled: true } } });
  assert.equal(got.extraUsage, true); assert.equal(got.account, 'test@example.invalid'); assert.equal(got.org, 'Team');
});
test('reads on-disk metadata; malformed/missing files are unknown', t => {
  const h = home(t); assert.equal(detectBillingMode({ home: h, env: {} }).mode, 'unknown');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify(fixture)); assert.equal(detectBillingMode({ home: h, env: {} }).mode, 'subscription');
  fs.writeFileSync(path.join(h, '.claude.json'), '{bad'); assert.equal(detectBillingMode({ home: h, env: {} }).mode, 'unknown');
});
test('all tools denied only for api; approval is session bound', async t => {
  const h = home(t), now = Date.now();
  for (const tool_name of ['Read', 'Bash', 'mcp__example', 'Write']) {
    const input = { hook_event_name: 'PreToolUse', tool_name, session_id: 's' };
    for (const mode of ['api', 'subscription', 'proxy', 'unknown']) {
      const result = await handleBilling(input, { home: h, now, detection: { mode, reason: 'test' } });
      assert.equal(result?.hookSpecificOutput.permissionDecision, mode === 'api' ? 'deny' : undefined);
    }
  }
  issueApprovals({ session_id: 's', prompt: '[API-BILLING-OK]' }, h, now);
  for (const [session_id, at, denied] of [['s', now, false], ['other', now, true], ['s', now + 3600000, true]]) {
    const result = await handleBilling({ hook_event_name: 'PreToolUse', session_id }, { home: h, now: at, detection: { mode: 'api' } });
    assert.equal(result?.hookSpecificOutput.permissionDecision === 'deny', denied);
  }
});
test('warnings persisted and notified only once daily; extra usage never denies', async t => {
  const h = home(t); let notifications = 0;
  const options = { home: h, now: Date.parse('2026-10-17T00:00:00Z'), detection: { mode: 'api', reason: 'prepaid', account: 'a', extraUsage: true }, notify: async () => { notifications++; } };
  const first = await handleBilling({ hook_event_name: 'SessionStart' }, options);
  assert.match(first.hookSpecificOutput.additionalContext, /🔒.*\n⚠️/);
  // extra usage の注意は SessionStart だけ。UserPromptSubmit では 🔒 のみ
  const second = await handleBilling({ hook_event_name: 'UserPromptSubmit' }, options);
  assert.match(second.hookSpecificOutput.additionalContext, /🔒/); assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /extra usage/);
  assert.equal(notifications, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/api-billing-detected.json'))).account, 'a');
  await handleBilling({ hook_event_name: 'SessionStart' }, { ...options, now: options.now + 86400000 }); assert.equal(notifications, 2);
  const out = await handleBilling({ hook_event_name: 'PreToolUse' }, { ...options, detection: { mode: 'subscription', extraUsage: true } });
  assert.equal(out, null);
  const start = await handleBilling({ hook_event_name: 'SessionStart' }, { ...options, home: home(t), detection: { mode: 'subscription', extraUsage: true } });
  assert.equal(start.hookSpecificOutput.permissionDecision, undefined); assert.match(start.hookSpecificOutput.additionalContext, /extra usage/);
});
test('notification fallback uses background fleet-mail; successful DM skips it', async t => {
  const h = home(t); let count = 0;
  const spawnImpl = (exe, args, options) => { count++; assert.equal(exe, process.execPath); assert.ok(args.includes('--body-file')); assert.equal(options.stdio, 'ignore'); const file = args[args.indexOf('--body-file') + 1]; assert.equal(fs.readFileSync(file, 'utf8'), 'warning'); fs.rmSync(path.dirname(file), { recursive: true }); return { on() {}, unref() {} }; };
  await notifyBilling(h, 'warning', { notify: async () => ({ delivered: 'none' }), spawnImpl }); assert.equal(count, 1);
  await notifyBilling(h, 'warning', { notify: async () => ({ delivered: 'dm' }), spawnImpl }); assert.equal(count, 1);
});
test('empty and malformed stdin fail open', t => {
  for (const input of ['', '{bad']) { const r = spawnSync(process.execPath, ['tools/api-billing-guard.mjs'], { input, encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home(t) } }); assert.equal(r.status, 0); assert.equal(r.stdout, ''); }
});
