#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { billingApproved } from './lib/claude-approval.mjs';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';
export const GATE_CONTRACT = {"name": "api-billing-guard", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "api-billing-guard"}]};
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } }
export function detectBillingMode({ home = os.homedir(), env = process.env, claudeJson, credentials, settings } = {}) {
  const oauth = (claudeJson ?? readJson(path.join(home, '.claude.json')))?.oauthAccount;
  // Only subscriptionType is inspected; credentials are never included in results or logs.
  const subscriptionType = (credentials ?? readJson(path.join(home, '.claude', '.credentials.json')))?.claudeAiOauth?.subscriptionType;
  const config = settings ?? readJson(path.join(home, '.claude', 'settings.json'));
  const common = { extraUsage: oauth?.hasExtraUsageEnabled === true, account: oauth?.emailAddress || oauth?.accountUuid || null, org: oauth?.organizationName || oauth?.organizationUuid || null };
  const result = (mode, reason) => ({ mode, reason, ...common });
  if (env.ANTHROPIC_BASE_URL) {
    try { if (new URL(env.ANTHROPIC_BASE_URL).hostname !== 'api.anthropic.com') return result('proxy', 'ANTHROPIC_BASE_URL: proxy'); } catch {}
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return result('api', 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN');
  if (config?.apiKeyHelper) return result('api', 'settings.apiKeyHelper');
  if (oauth?.billingType === 'stripe_subscription' || /^(team|pro|max|enterprise)$/.test(subscriptionType || '')) return result('subscription', 'Claude subscription');
  if (typeof oauth?.billingType === 'string' && oauth.billingType.trim()) return result('api', `billingType=${oauth.billingType}`);
  return result('unknown', '課金情報なし');
}
function billingMessage(reason) {
  return `🔒 このPCの Claude Code は従量課金(Console/APIキー: ${reason})で動いています。§2.8.5 により全ツールを停止します。\`claude /login\` で Claude アカウント(Team シート)を選び直してください。kim が同じ指示で [API-BILLING-OK] と書いたときだけ60分許可。`;
}
export async function notifyBilling(home, body, { notify = notifyKim, spawnImpl = spawn } = {}) {
  const delivered = await notify(body, { home, plainJa: false, webhookFallback: false, signal: AbortSignal.timeout(1000) });
  if (delivered?.delivered && delivered.delivered !== 'none') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-billing-'));
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, body, { mode: 0o600 });
  const child = spawnImpl(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-mail.mjs'), '--send', '--to', 'kim-PC', '--kind', 'note', '--body-file', file, '--why', '従量課金ログイン検知'], { ...backgroundSpawnOptions(), stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: home } });
  child.on('error', () => {});
  child.unref();
}
export async function handleBilling(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), detection, notify = notifyBilling } = {}) {
  const event = input.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse'].includes(event)) return null;
  const status = detection ?? detectBillingMode({ home });
  const messages = [];
  const locked = status.mode === 'api' && !billingApproved(home, input.session_id, now);
  if (status.mode === 'api' && event !== 'PreToolUse') messages.push(billingMessage(status.reason));
  // extra usage の注意は SessionStart だけ(毎プロンプト・毎ツールで出すと本文の指示を埋める)。通知は下の1日1回ガード。
  if (status.extraUsage && event === 'SessionStart') messages.push('⚠️ このアカウントは上限超過後の従量課金(extra usage)が ON です。kim の方針(2026-09-08 OFF)と不一致。');
  if (event !== 'PreToolUse' && messages.length) {
    try {
      const dir = path.join(home, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      if (status.mode === 'api') fs.writeFileSync(path.join(dir, 'api-billing-detected.json'), JSON.stringify({ at: new Date(now).toISOString(), mode: status.mode, reason: status.reason, account: status.account }) + '\n');
      const file = path.join(dir, 'api-billing-notified.json');
      const date = new Date(now).toISOString().slice(0, 10);
      if (readJson(file).date !== date) {
        fs.writeFileSync(file, JSON.stringify({ date }) + '\n');
        await notify(home, messages.join('\n'));
      }
    } catch {}
  }
  const output = { hookEventName: event };
  if (event === 'PreToolUse' && locked) Object.assign(output, { permissionDecision: 'deny', permissionDecisionReason: billingMessage(status.reason) });
  if (messages.length) output.additionalContext = messages.join('\n');
  return Object.keys(output).length > 1 ? { hookSpecificOutput: output } : null;
}
if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    if (raw) {
      const output = await handleBilling(JSON.parse(raw.replace(/^\uFEFF/, '')));
      if (output) console.log(JSON.stringify(output));
    }
  } catch {}
}
