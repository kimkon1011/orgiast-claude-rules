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

function currentProcess(entries) {
  let start = 0, boundary = 'initial';
  const seen = new Set();
  for (const [index, row] of entries.entries()) {
    const hook = row?.attachment;
    // 2026-11-06: three resumed local JSONLs contain SessionStart:resume attachments; cwd/isMeta also change during ordinary turns.
    if (row?.type !== 'attachment' || row.isSidechain === true || hook?.hookEvent !== 'SessionStart' || !['SessionStart:startup', 'SessionStart:resume'].includes(hook.hookName)) continue;
    const id = hook.toolUseID || row.uuid || row.timestamp || `row:${index}`;
    if (seen.has(id)) continue; // Multiple hook results share one startup's toolUseID.
    seen.add(id);
    start = index;
    boundary = id;
  }
  return { entries: entries.slice(start), boundary };
}

// Read the whole session: CronCreate may precede the runner\'s transcript tail.
export function evaluateProgressCron(input = {}, { raw, home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), env = process.env } = {}) {
  try {
    if (isHeadless(env) || ['sdk-cli', 'sdk-ide'].includes(input.entrypoint || input.entryPoint || env.CLAUDE_CODE_ENTRYPOINT)) return pass('headless');
    if (input.agent_id || input.isSidechain === true || /(?:^|[\\/])subagents(?:[\\/]|$)/i.test(input.transcript_path || '')) return pass('subagent');
    const source = raw ?? fs.readFileSync(input.transcript_path, 'utf8');
    const parsed = source.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const { entries, boundary } = currentProcess(parsed);
    if (entries.some(row => ['sdk-cli', 'sdk-ide'].includes(row?.entrypoint || row?.entryPoint))) return pass('headless');
    const assistants = entries.filter(row => row && (row.type === 'assistant' || row.message?.role === 'assistant'));
    if (assistants.at(-1)?.isSidechain === true) return pass('subagent');
    const main = assistants.filter(row => row.isSidechain !== true);
    if (main.some(row => Array.isArray(row.message?.content) && row.message.content.some(block => block?.type === 'tool_use' && block.name === 'CronCreate'))) return pass('cron-created');
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
    const key = crypto.createHash('sha256').update(JSON.stringify([String(id), boundary])).digest('hex');
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
