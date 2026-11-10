#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"mail-send-approval-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"mail-send-approval-gate"}]};
import fs from 'node:fs';
import path from 'node:path';
import { readEvidence, approved, approvedAfter, human, textOf, shellSegments, option, outputDecision } from './lib/approval-evidence.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { validApprovalMarker } from './lib/send-approval.mjs';
import { readContextMarker, MAX_MARKER_AGE_MS } from './lib/send-context.mjs';
export const HOOK_MATCHER = 'mcp__claude_ai_Gmail(?:_\\d+)?__(send_message|reply|forward)|Bash|PowerShell';
export const BLOCK_REASON = '本文の全文をチャットに表示し、kim の『送ってよい』を得てから送信してください（組織指示11）。多数宛は mail-bulk-approve を使う';
export const APPROVAL_MISSING_REASON = 'kim の最新の発言が送信承認として読めません（例: 送って／おくって／OK）。本文の全文を表示したうえで送信承認を得てください。';
export const BODY_NOT_SHOWN_REASON = '下書き本文の全文が、kim の最新の承認の前の Claude の発言に見つかりません。本文を記号なし（コードブロック可）で全文表示してから承認を得てください。';
export const HEADLESS_REASON = '無人の自動進行からの社外送信は拒否しました。本文ハッシュと一致する ~/.claude/send-approvals/<sha256>.json（approvedAt・kimQuote・bodyHash）が必要です。';
export const CONTEXT_REASON = '送信前に宛先の履歴整合性チェックが必要です。node tools/send-context-check.mjs --channel <line|gmail|discord|beeper> --target <宛先> --text-file <送る本文> を実行してください。';
const normalize = s => typeof s === 'string' ? s.replace(/\r\n/g, '\n')
  .split('\n').map(line => line.replace(/^(?:>[ \t]?)+/, '').trimEnd())
  .filter(line => !/^[ \t]*```[^`]*$/.test(line)).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim() : '';
const block = (reason = BLOCK_REASON) => ({ decision: 'block', reason });
function executedScript(args, pattern) {
  const base = value => String(value ?? '').split(/[\\/]/).at(-1).replace(/\.exe$/i, '');
  if (pattern.test(base(args[0]))) return true;
  if (!/^node(?:js)?$/i.test(base(args[0]))) return false;
  // Only Node's entry script can send. A matching string in grep arguments,
  // comments, heredoc contents, or an imported module is data, not execution.
  const entry = args.slice(1).find(arg => arg === '--' || !arg.startsWith('-'));
  return entry !== '--' && pattern.test(base(entry));
}
export function sendTargets(input) {
  if (/^mcp__claude_ai_Gmail(?:_\d+)?__(send_message|reply|forward)$/.test(input?.tool_name)) {
    const a = input.tool_input ?? {};
    return [{ body: a.body ?? a.content ?? a.message ?? a.html_body ?? a.text ?? a.message_body }];
  }
  if (!/^(Bash|PowerShell)$/.test(input?.tool_name)) return [];
  const targets = [];
  for (const args of shellSegments(input.tool_input?.command ?? '')) {
    if (executedScript(args, /^gmail-draft\.mjs$/i) && option(args, '--send')) targets.push({ draftId: option(args, '--send'), user: option(args, '--user') ?? 'seisaku-team@orgiast.jp' });
    else if (executedScript(args, /^line-group-send\.mjs$/i)) {
      if (args.includes('--dry-run')) continue;
      const file = option(args, '--text-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : '', channel: 'line' });
    }
    else if (executedScript(args, /^line-channel\.mjs$/i) && args.includes('--send')) {
      if (args.includes('--dry-run')) continue;
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : '', channel: 'line' });
    }
    else if (executedScript(args, /^(?:beeper-send|discord-dm)\.mjs$/i)) {
      if (args.includes('--dry-run')) continue;
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : option(args, '--body') ?? '', channel: 'message' });
    }
    // Repository inventory: gmail-draft --send is the sending CLI. Never exempt a
    // whole compound command just because a notification tool also appears in it.
    else if (executedScript(args, /^gmail-send\.mjs$/i)) {
      const file = option(args, '--body-file');
      targets.push({ body: file ? fs.readFileSync(path.resolve(input.cwd ?? process.cwd(), file), 'utf8') : option(args, '--body') });
    }
  }
  return targets;
}
export function judge(input, { targets, env = process.env, home = env.ORGIAST_HOME, requireContext = false } = {}) {
  try {
    targets ??= sendTargets(input);
    if (!targets.length) return { decision: 'pass' };
    if (requireContext) for (const target of targets) {
        const marker = readContextMarker(normalize(target.body), home);
        if (!marker || Date.now() - Date.parse(marker.checkedAt) > MAX_MARKER_AGE_MS) return block(CONTEXT_REASON);
      }
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
export async function judgeLive(input, { loadDraft, requireContext = true } = {}) {
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
    return judge(input, { targets, requireContext });
  } catch { return block(); }
}
if (isEntry(import.meta.url)) {
  try { const raw = await readStdinWithTimeout(4000); if (raw.trim()) outputDecision(await judgeLive(JSON.parse(raw))); }
  catch { outputDecision(block()); }
}
