#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"gmail-connector-url-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"gmail-connector-url-gate"},{"kind":"repo-file","ref":"tools/gmail-draft.mjs"}]};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';

export const HOOK_MATCHER = 'mcp__claude_ai_Gmail(?:_\\d+)?__(create_draft|update_draft|send_message|reply|forward)';
export const TARGET = new RegExp(`^(?:${HOOK_MATCHER})$`);
const OVERRIDE_FILE = 'gmail-connector-url-gate-override';
const GOOGLE_REDIRECT = /https?:\/\/(?:www\.)?google\.com\/url\?q=/i;
const WEB_URL = /https?:\/\/[^\s<>"']+/i;

export function overrideActive(home, now = Date.now()) {
  let raw;
  try { raw = fs.readFileSync(path.join(home, '.claude', OVERRIDE_FILE), 'utf8'); } catch { return false; }
  const expiry = Date.parse(raw.split(/\r?\n/)[0].trim());
  return Number.isFinite(expiry) && now < expiry;
}

export function judge(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now() } = {}) {
  const toolName = input?.tool_name || '';
  if (!TARGET.test(toolName)) return { decision: 'pass' };
  const args = input?.tool_input || {};
  const text = `${args.subject ?? ''}\n${args.body ?? ''}\n${args.htmlBody ?? ''}`;
  const redirected = GOOGLE_REDIRECT.test(text);
  if (!redirected && !WEB_URL.test(text)) return { decision: 'pass' };
  if (overrideActive(home, now)) return { decision: 'pass', override: true };
  const reason = `[GMAIL-CONNECTOR-URL-GATE] ${redirected ? 'Google 転送 URL（google.com/url?q=）の貼り戻しを検出しました。' : 'メールに http:// または https:// の URL が含まれています。'}\nclaude.ai の Gmail コネクタは保存時に URL を https://www.google.com/url?q=… に書き換える（2026-10-18 実測。body・htmlBody の a href とも、生 MIME まで書き換わる）。URL を含む社外宛メールは \`node tools/gmail-draft.mjs --to … --subject … --body-file …\` で作る。SA 鍵の無い PC は aujust リポジトリの GitHub Actions 経由（memory: project-cr-pc-gmail-read-via-gha-secret）で同じ Gmail API を使う。`;
  return { decision: 'block', reason };
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const result = judge(JSON.parse(raw));
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch (error) {
    console.error(`[GMAIL-CONNECTOR-URL-GATE] 判定をスキップ: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
  }
}

if (isEntry(import.meta.url)) await main();
