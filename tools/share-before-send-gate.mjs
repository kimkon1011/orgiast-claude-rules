#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"share-before-send-gate","remedies":[{"kind":"repo-file","ref":"tools/drive-share.mjs"}]};
import fs from 'node:fs';
import path from 'node:path';
import { extractFileId, shareLedgerPath } from './lib/drive-share.mjs';
import { extractAddresses } from './internal-recipient-gmail-guard.mjs';
import { readStdin } from './transcript-tail.mjs';
import { isEntry } from './is-entry.mjs';

export const HOOK_MATCHER = 'mcp__claude_ai_Discord[^|]*__(send_dm|send_message|reply_message)|mcp__claude_ai_Gmail(?:_\\d+)?__(send_message|create_draft|reply|forward|update_draft)|Bash|PowerShell';
const TARGET = new RegExp(`^(?:${HOOK_MATCHER})$`);
const SHELL = /^(?:Bash|PowerShell)$/;
export function fileIds(text) {
  return [...new Set((String(text).match(/https?:\/\/(?:docs|drive)\.google\.com\/[^\s<>"'\\)\]。]+/g) ?? []).map(extractFileId).filter(Boolean))];
}
function tokens(command) {
  return (command.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map(t => t.replace(/(["'])(.*?)\1/g, '$2'));
}
function transcriptIds(raw) {
  const ids = new Set();
  for (const line of raw.split(/\r?\n/).filter(l => l.trim())) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'assistant' && row.message?.role !== 'assistant') continue;
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type !== 'tool_use') continue;
      const input = block.input ?? {};
      if (/^mcp__claude_ai_Google_Drive(?:_\d+)?__share_file$/.test(block.name)) {
        for (const value of Object.values(input)) {
          if (typeof value === 'string') {
            const id = extractFileId(value);
            if (id) ids.add(id);
          }
        }
      } else if (SHELL.test(block.name)) {
        const command = String(input.command ?? '');
        if (/\s--dry(?:-run)?(?:\s|$)/.test(command)) continue;
        if (!/\bdrive-share\.mjs\b/.test(command) && !/\b(?:gdoc-create|gdoc-publish|drive-upload)\.mjs\b[\s\S]*\s--share(?:\s|=)/.test(command)) continue;
        for (const id of fileIds(command)) ids.add(id);
        const args = tokens(command);
        for (let i = 0; i < args.length; i++) if (['--id', '--update'].includes(args[i])) {
          const id = extractFileId(args[i + 1]);
          if (id) ids.add(id);
        }
      }
    }
  }
  return ids;
}

export function judge(input, { ledgerPath = shareLedgerPath(), now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('hook 入力が不正です');
  if (!TARGET.test(input.tool_name ?? '')) return { decision: 'pass' };
  const args = input.tool_input ?? {};
  let text = JSON.stringify(args);
  if (SHELL.test(input.tool_name)) {
    text = String(args.command ?? '');
    if (!/\b(?:discord-dm|gmail-draft)\.mjs\b/.test(text)) return { decision: 'pass' };
    const argv = tokens(text);
    for (let i = 0; i < argv.length; i++) {
      const match = argv[i].match(/^--(?:body-file|message-file|content-file|text-file)(?:=(.*))?$/);
      if (!match) continue;
      const file = match[1] ?? argv[++i];
      if (!file) throw new Error('本文ファイル指定が不正です');
      text += '\n' + fs.readFileSync(path.resolve(input.cwd || process.cwd(), file), 'utf8');
    }
  } else if (/Gmail/.test(input.tool_name)) {
    const recipients = extractAddresses(args);
    if (recipients.length && recipients.every(e => e === 'kim@orgiast.jp')) return { decision: 'pass' };
  }
  const ids = fileIds(text);
  if (!ids.length) return { decision: 'pass' };
  // Evidence files are read only after finding a target link. I/O/parse failures
  // propagate to the entrypoint's fail-open handler, as with existing guards.
  // 共有記録がまだ無いPCでも判定する（fail-open で素通りさせない）。壊れた行だけ捨てる。
  const ledger = (fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '').split(/\r?\n/)
    .filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const recorded = new Set(ledger.filter(r => {
    const age = now - Date.parse(r.ts);
    return age >= 0 && age <= 30 * 86400000 && Array.isArray(r.emails) && r.emails.length;
  }).map(r => r.fileId));
  const pending = ids.filter(id => !recorded.has(id));
  if (!pending.length) return { decision: 'pass' };
  const shared = input.transcript_path && fs.existsSync(input.transcript_path) ? transcriptIds(fs.readFileSync(input.transcript_path, 'utf8')) : new Set();
  const missing = pending.filter(id => !shared.has(id));
  if (!missing.length) return { decision: 'pass' };
  return { decision: 'block', reason: missing.map(id => `送信前に相手へ共有してください: node tools/drive-share.mjs --id ${id} --to <相手のメール>（社内は編集者・社外はコメント可が既定）。共有済みのファイルなら同コマンドで記録されます（既存権限はスキップ）。`).join('\n') };
}
export async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const result = judge(JSON.parse(raw));
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch (error) { console.error(`[SHARE-BEFORE-SEND] 判定をスキップ: ${String(error.message).replace(/[\r\n]+/g, ' ')}`); }
}
if (isEntry(import.meta.url)) await main();
