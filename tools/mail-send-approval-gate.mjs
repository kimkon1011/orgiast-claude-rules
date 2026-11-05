#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"mail-send-approval-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"mail-send-approval-gate"}]};
import fs from 'node:fs';
import path from 'node:path';
import { readEvidence, approvedAfter, shellSegments, option, outputDecision } from './lib/approval-evidence.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const HOOK_MATCHER = 'mcp__claude_ai_Gmail(?:_\\d+)?__(send_message|reply|forward)|Bash|PowerShell';
export const BLOCK_REASON = '本文の全文をチャットに表示し、kim の『送ってよい』を得てから送信してください（組織指示11）。多数宛は mail-bulk-approve を使う';
const normalize = s => typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim() : '';
const block = () => ({ decision: 'block', reason: BLOCK_REASON });
export function sendTargets(input) {
  if (/^mcp__claude_ai_Gmail(?:_\d+)?__(send_message|reply|forward)$/.test(input?.tool_name)) {
    const a = input.tool_input ?? {};
    return [{ body: a.body ?? a.content ?? a.message ?? a.html_body ?? a.text ?? a.message_body }];
  }
  if (!/^(Bash|PowerShell)$/.test(input?.tool_name)) return [];
  const targets = [];
  for (const args of shellSegments(input.tool_input?.command ?? '')) {
    const script = args.find(a => /(?:^|[\\/])gmail-draft\.mjs$/.test(a));
    if (script && option(args, '--send')) targets.push({ draftId: option(args, '--send'), user: option(args, '--user') ?? 'seisaku-team@orgiast.jp' });
    // Repository inventory: gmail-draft --send is the sending CLI. Never exempt a
    // whole compound command just because a notification tool also appears in it.
    else if (args.some(a => /(?:^|[\\/])gmail-send\.mjs$/.test(a))) {
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : option(args, '--body') });
    }
  }
  return targets;
}
export function judge(input, { targets } = {}) {
  try {
    targets ??= sendTargets(input);
    if (!targets.length) return { decision: 'pass' };
    const rows = readEvidence(input);
    for (const target of targets) {
      const body = normalize(target.body);
      // Exact containment also catches edits in the middle of a long message.
      if (!body || !approvedAfter(rows, text => normalize(text).includes(body), 'mail')) return block();
    }
    return { decision: 'pass' };
  } catch { return block(); }
}
// Approval covers forwarded/quoted text too; consistency-check's mimeText strips
// quotes and must not be reused here. Ignore attachment MIME parts.
export function draftBody(payload) {
  const plain = [], html = [];
  function walk(part) {
    if (!part || part.filename) return;
    if (part.body?.data) {
      const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/plain') plain.push(decoded);
      else if (part.mimeType === 'text/html') html.push(decoded);
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);
  return (plain.length ? plain : html).join('\n');
}
export async function judgeLive(input, { loadDraft } = {}) {
  try {
    const targets = sendTargets(input);
    for (const t of targets) if (t.draftId) {
      if (!loadDraft) {
        const { getDriveToken, driveApi } = await import('./lib/drive-auth.mjs');
        loadDraft = async ({ draftId, user }) => {
          const token = await getDriveToken({ impersonate: user, scope: 'https://www.googleapis.com/auth/gmail.readonly', signal: AbortSignal.timeout(10000) });
          const response = await driveApi(token, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=full`, { signal: AbortSignal.timeout(10000) });
          return draftBody((await response.json()).message?.payload);
        };
      }
      t.body = await loadDraft(t);
    }
    return judge(input, { targets });
  } catch { return block(); }
}
if (isEntry(import.meta.url)) {
  try { const raw = await readStdinWithTimeout(4000); if (raw.trim()) outputDecision(await judgeLive(JSON.parse(raw))); }
  catch { outputDecision(block()); }
}
