#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"mail-send-approval-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"mail-send-approval-gate"}]};
import fs from 'node:fs';
import path from 'node:path';
import { readEvidence, approved, approvedAfter, human, textOf, shellSegments, option, outputDecision } from './lib/approval-evidence.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { validApprovalMarker } from './lib/send-approval.mjs';
export const HOOK_MATCHER = 'mcp__claude_ai_Gmail(?:_\\d+)?__(send_message|reply|forward)|Bash|PowerShell';
export const BLOCK_REASON = '本文の全文をチャットに表示し、kim の『送ってよい』を得てから送信してください（組織指示11）。多数宛は mail-bulk-approve を使う';
export const APPROVAL_MISSING_REASON = 'kim の最新の発言が送信承認として読めません（例: 送って／おくって／OK）。本文の全文を表示したうえで送信承認を得てください。';
export const BODY_NOT_SHOWN_REASON = '下書き本文の全文が、kim の最新の承認の前の Claude の発言に見つかりません。本文を記号なし（コードブロック可）で全文表示してから承認を得てください。';
export const HEADLESS_REASON = '無人の自動進行からの社外送信は拒否しました。本文ハッシュと一致する ~/.claude/send-approvals/<sha256>.json（approvedAt・kimQuote・bodyHash）が必要です。';
const normalize = s => typeof s === 'string' ? s.replace(/\r\n/g, '\n')
  .split('\n').map(line => line.replace(/^(?:>[ \t]?)+/, '').trimEnd())
  .filter(line => !/^[ \t]*```[^`]*$/.test(line)).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim() : '';
const block = (reason = BLOCK_REASON) => ({ decision: 'block', reason });
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
    else if (args.some(a => /(?:^|[\\/])line-group-send\.mjs$/.test(a))) {
      if (args.includes('--dry-run')) continue;
      const file = option(args, '--text-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : '', channel: 'line' });
    }
    else if (args.some(a => /(?:^|[\\/])line-channel\.mjs$/.test(a)) && args.includes('--send')) {
      if (args.includes('--dry-run')) continue;
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : '', channel: 'line' });
    }
    else if (args.some(a => /(?:^|[\\/])(?:beeper-send|discord-dm)\.mjs$/.test(a))) {
      if (args.includes('--dry-run')) continue;
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : option(args, '--body') ?? '', channel: 'message' });
    }
    // Repository inventory: gmail-draft --send is the sending CLI. Never exempt a
    // whole compound command just because a notification tool also appears in it.
    else if (args.some(a => /(?:^|[\\/])gmail-send\.mjs$/.test(a))) {
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : option(args, '--body') });
    }
  }
  return targets;
}
export function judge(input, { targets, env = process.env, home = env.ORGIAST_HOME } = {}) {
  try {
    targets ??= sendTargets(input);
    if (!targets.length) return { decision: 'pass' };
    const unattended = env.CLAUDE_HEADLESS === '1' || /^(?:auto-progress|auto-session)(?::|$)/.test(String(env.ORGIAST_HEADLESS_JOB || ''));
    const markerResults = targets.map(target => validApprovalMarker(normalize(target.body), { ...(home ? { home } : {}) }));
    if (markerResults.every(result => result.ok)) return { decision: 'pass' };
    if (unattended) return block(HEADLESS_REASON);
    const rows = readEvidence(input);
    const latestHuman = rows.findLast(human);
    if (!latestHuman || !approved(textOf(latestHuman), 'mail')) return block(APPROVAL_MISSING_REASON);
    for (const target of targets) {
      const body = normalize(target.body);
      // Exact containment also catches edits in the middle of a long message.
      if (!body || !approvedAfter(rows, text => normalize(text).includes(body), 'mail')) return block(BODY_NOT_SHOWN_REASON);
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
