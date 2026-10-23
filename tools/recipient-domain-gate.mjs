#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"recipient-domain-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"recipient-domain-gate"}]};
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractAddresses } from './internal-recipient-gmail-guard.mjs';
import { checkDomains, extractEmails, isInternalDomain } from './lib/mail-domain-check.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export const HOOK_MATCHER = 'mcp__claude_ai_Gmail(?:_\\d+)?__(send_message|create_draft|reply|forward|update_draft)|Bash|PowerShell';
const TARGET = new RegExp(`^(?:${HOOK_MATCHER})$`);
const LIMIT = 5 * 1024 * 1024;
const warn = text => console.error(`[RECIPIENT-DOMAIN] ${String(text).replace(/[\r\n]+/g, ' ')}`);
function tokens(command) {
  return (command.match(/(?:"[^"]*"|'[^']*'|[^\s"';|&])+|[;|&\n]+/g) ?? []).map(t => t.replace(/(["'])(.*?)\1/g, '$2'));
}
async function readLimited(file) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > LIMIT) throw new Error(`検査ファイルが5MB超: ${path.basename(file)}`);
    const buffer = Buffer.alloc(LIMIT + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > LIMIT) throw new Error('検査ファイルが5MB超');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
async function recipients(input, signal) {
  if (!/^(Bash|PowerShell)$/.test(input.tool_name)) return extractAddresses(input.tool_input);
  const argv = tokens(String(input.tool_input?.command ?? ''));
  const found = [];
  let cwd = input.cwd || process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (/^(?:cd|Set-Location)$/i.test(argv[i]) && argv[i + 1]) {
      const directory = /^-(?:Path|LiteralPath)$/i.test(argv[i + 1]) ? argv[i + 2] : argv[i + 1];
      if (directory) cwd = path.resolve(cwd, directory);
    }
    const directDraft = /(?:^|[\\/])gmail-draft\.mjs$/.test(argv[i]);
    if (!directDraft && !/(?:^|[\\/])node(?:\.exe)?$/i.test(argv[i])) continue;
    let j = directDraft ? i : i + 1;
    // Common node flags; -e/-p execute source rather than a script file.
    while (argv[j]?.startsWith('-')) {
      if (/^(?:-e|--eval|-p|--print)(?:=|$)/.test(argv[j])) break;
      if (['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(argv[j])) j++;
      j++;
    }
    if (!/\.(?:mjs|cjs|js)$/i.test(argv[j] ?? '')) continue;
    const file = path.resolve(cwd, argv[j]);
    if (path.basename(file) === 'gmail-draft.mjs') {
      for (let k = j + 1; k < argv.length && !/^[;|&\n]+$/.test(argv[k]); k++) {
        const flag = argv[k].match(/^--(?:to|cc|bcc)(?:=(.*))?$/);
        if (flag) found.push(...extractEmails(flag[1] ?? argv[++k] ?? ''));
      }
      continue;
    }
    const source = await readLimited(file);
    if (!/messages\/send|gmail\.send/.test(source)) continue;
    found.push(...extractEmails(source));
    // Only named sibling data files; never traverse paths or scan unrelated data.
    for (const entry of await fs.readdir(path.dirname(file), { withFileTypes: true })) {
      if (signal.aborted) return found;
      if (entry.isFile() && /\.(?:jsonl?|csv|tsv|txt)$/i.test(entry.name) && source.includes(entry.name)) {
        found.push(...extractEmails(await readLimited(path.join(path.dirname(file), entry.name))));
      }
    }
  }
  return [...new Set(found)];
}
export async function judge(input, { warn: warning = warn, budgetMs = 20000, ...options } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([(async () => {
      if (!input || typeof input !== 'object') throw new Error('hook 入力が不正です');
      if (!TARGET.test(input.tool_name ?? '')) return { decision: 'pass' };
      const emails = (await recipients(input, controller.signal)).filter(e => !isInternalDomain(e.split('@')[1]));
      if (!emails.length || controller.signal.aborted) return { decision: 'pass' };
      const result = await checkDomains(emails.map(e => e.split('@')[1]), { ...options, signal: controller.signal });
      if (controller.signal.aborted) return { decision: 'pass' };
      if (result.unknown.length) warning(`DNS 未確認のため通過: ${result.unknown.map(r => `${r.domain}: ${r.reason}`).join(', ')}`);
      if (!result.bad.length) return { decision: 'pass' };
      const reason = result.bad.map(r => `${emails.filter(e => e.split('@')[1] === r.domain).join(', ')}（${r.domain}）: ${r.reason}`).join('\n') + '\n名刺画像・元データで綴りを確認して直してから送ってください。意図的に送る場合も直すまで送らないでください';
      return { decision: 'block', reason };
    })(), new Promise(resolve => { timer = setTimeout(() => {
      controller.abort(); warning('hook 上限時間を超えたため判定をスキップ'); resolve({ decision: 'pass' });
    }, budgetMs); })]);
  } catch (error) { warning(`判定をスキップ: ${error.message}`); return { decision: 'pass' }; }
  finally { clearTimeout(timer); }
}
export async function main() {
  const start = Date.now();
  try {
    const raw = await readStdinWithTimeout(4000);
    if (!raw.trim()) return;
    const result = await judge(JSON.parse(raw), { budgetMs: Math.max(1, 20000 - (Date.now() - start)) });
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch (error) { warn(`判定をスキップ: ${error.message}`); }
}
if (isEntry(import.meta.url)) await main();
