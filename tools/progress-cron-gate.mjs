#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"progress-cron-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"progress-cron-gate"}]};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isHeadless } from './lib/unattended-session.mjs';

const REASON = 'CronCreate で定期進捗（例 cron `17 9-19/2 * * *`、prompt は約束した対象を実測して変化だけ5行以内で報告、kim に操作は求めない）を張ってから終えること。期限付きの待ちは one-shot も張る。';
const pass = reason => ({ decision: 'pass', reason });

// Real transcripts use hook_success, hook_additional_context and async_hook_response
// attachments with hookEvent: SessionStart and hookName: SessionStart:resume.
function lastSessionBoundary(entries) {
  let explicit = -1, gap = -1;
  const sessionStart = value => typeof value === 'string' && /\bSessionStart\b/.test(value);
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i], attachment = row?.attachment;
    if ((row?.type === 'system' && (sessionStart(row.subtype) || sessionStart(row.content))) ||
        (row?.type === 'attachment' && typeof attachment?.type === 'string' && attachment.type.includes('hook') &&
          (attachment.hookEvent === 'SessionStart' || /^SessionStart(?::|$)/.test(attachment.hookName || '')))) explicit = i;
    // Only adjacent timestamped rows count; missing/invalid timestamps are not a gap.
    if (i > 0 && Date.parse(row?.timestamp) - Date.parse(entries[i - 1]?.timestamp) > 30 * 60 * 1000) gap = i;
  }
  return explicit >= 0 ? { index: explicit, start: explicit + 1 } : { index: gap, start: Math.max(0, gap) };
}

// Read the whole transcript to locate the latest start, even before the runner's tail.
export function evaluateProgressCron(input = {}, { raw, home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), env = process.env } = {}) {
  try {
    if (isHeadless(env) || ['sdk-cli', 'sdk-ide'].includes(input.entrypoint || input.entryPoint || env.CLAUDE_CODE_ENTRYPOINT)) return pass('headless');
    if (input.agent_id || input.isSidechain === true || /(?:^|[\\/])subagents(?:[\\/]|$)/i.test(input.transcript_path || '')) return pass('subagent');
    const source = raw ?? fs.readFileSync(input.transcript_path, 'utf8');
    const entries = source.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (entries.some(row => ['sdk-cli', 'sdk-ide'].includes(row?.entrypoint || row?.entryPoint))) return pass('headless');
    const assistants = entries.filter(row => row && (row.type === 'assistant' || row.message?.role === 'assistant'));
    if (assistants.at(-1)?.isSidechain === true) return pass('subagent');
    const main = assistants.filter(row => row.isSidechain !== true);
    const boundary = lastSessionBoundary(entries);
    const current = entries.slice(boundary.start).filter(row => row && (row.type === 'assistant' || row.message?.role === 'assistant') && row.isSidechain !== true);
    if (current.some(row => Array.isArray(row.message?.content) && row.message.content.some(block => block?.type === 'tool_use' && block.name === 'CronCreate'))) return pass('cron-created');
    const content = main.at(-1)?.message?.content;
    const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '').trimEnd();
    // Only terminal footer lines count, not examples in the response body.
    const footer = text.match(/(?:^|\n)この後の自動進行:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?このセッション:[ \t]*([^\r\n]*)$/);
    const session = text.match(/(?:^|\n)このセッション:[ \t]*([^\r\n]*)$/)?.[1] || '';
    const promised = footer && footer[1].trim() && !/^なし(?:[。.]|[ \t]*[（(].*[）)])?$/.test(footer[1].trim());
    if (!promised && !session.includes('まだ閉じない')) return pass('no-promise');
    const id = input.session_id || input.sessionId || input.transcript_path;
    if (!id) return pass('no-session-id');
    // Same .claude state directory as stop-recheck; exclusive creation bounds concurrent Stops too.
    const boundaryId = entries[boundary.index]?.timestamp ?? `line:${boundary.index}`;
    const keyInput = boundary.index < 0 ? String(id) : JSON.stringify([String(id), boundaryId]);
    const key = crypto.createHash('sha256').update(keyInput).digest('hex');
    const file = path.join(home, '.claude', 'progress-cron-gate-state', `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify({ blockedAt: new Date().toISOString() }) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return pass('already-blocked'); throw error; }
    return { decision: 'block', code: 'PROGRESS-CRON-REQUIRED', reason: REASON };
  } catch { return pass('unavailable'); }
}

if (isEntry(import.meta.url)) {
  try {
    const input = JSON.parse(await readStdinWithTimeout());
    const result = evaluateProgressCron(input);
    if (result.decision === 'block') { process.stderr.write(`${result.reason}\n`); process.exitCode = 2; }
  } catch { /* Match existing gates: malformed hook input fails open. */ }
}
