#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "mail-draft-account-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "mail-draft-account-gate"}]};
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdin } from './transcript-tail.mjs';
import { TARGET } from './internal-recipient-gmail-guard.mjs';

export const REMEDY = 'メールは seisaku-team@orgiast.jp の下書きに作る: node tools/gmail-draft.mjs --to <宛先> --subject "<件名>" --body-file <本文ファイル> --json → 読み戻し node tools/gmail-search.mjs --user seisaku-team@orgiast.jp --query "in:drafts subject:<件名>" --json → user が「送って」と言ったら node tools/gmail-draft.mjs --send <draftId> --json';
export const SHARED_ACCOUNT = 'seisaku-team@orgiast.jp';
// 共有アカウント自身でログインしている席（user-PC 等）は Gmail MCP も共有アカウント名義になるので通す
export function claudeAccountEmail(env = process.env) {
  if (env.ORGIAST_CLAUDE_ACCOUNT_EMAIL !== undefined) return env.ORGIAST_CLAUDE_ACCOUNT_EMAIL;
  try { return JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress ?? ''; } catch { return ''; }
}
export function judge(input, env = process.env, account = '') {
  if (env.ORGIAST_MAIL_ACCOUNT_GATE === 'off' || !TARGET.test(input?.tool_name ?? '')) return null;
  if (String(account).toLowerCase() === SHARED_ACCOUNT) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `[MAIL-DRAFT-ACCOUNT] Gmail MCP は個人アカウント名義になるため使用できません。${REMEDY}` } };
}
if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const result = judge(JSON.parse(raw), process.env, claudeAccountEmail());
      if (result) console.log(JSON.stringify(result));
    }
  } catch { console.error('[MAIL-DRAFT-ACCOUNT] 入力を読めないため判定をスキップしました。'); }
}
