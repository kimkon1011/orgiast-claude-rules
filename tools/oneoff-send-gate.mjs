#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"oneoff-send-gate","remedies":[{"kind":"repo-file","ref":"portable-knowhow/11_送信前の相手発言照合.md"}]};
import fs from 'node:fs';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const HOOK_MATCHER = 'Bash|PowerShell';
export const REASON = '使い捨てスクリプトからの送信は禁止（2026-11-28 東邦ハイツ控えの件）。node tools/pre-send-reply-check.mjs を通してから node tools/beeper-send.mjs 等の共通入口で送ってください';
const tokens = command => (String(command).match(/"[^"]*"|'[^']*'|[^\s;|&]+|[;|&]/g) || []).map(s => s.replace(/^(["'])([\s\S]*)\1$/, '$2'));
function official(file) {
  let dir = path.dirname(file);
  while (path.dirname(dir) !== dir) {
    if (path.basename(dir).toLowerCase() === 'tools' && fs.existsSync(path.join(path.dirname(dir), '.git'))) return true;
    dir = path.dirname(dir);
  }
  return false;
}
export function judge(input) {
  if (!/^(Bash|PowerShell)$/.test(input?.tool_name || '')) return { decision:'pass' };
  const argv = tokens(input.tool_input?.command || ''); let cwd = path.resolve(input.cwd || process.cwd());
  for (let i = 0; i < argv.length; i++) {
    if (/^(cd|Set-Location)$/i.test(argv[i]) && argv[i+1]) {
      let next = i + 1; if (/^-(Literal)?Path$/i.test(argv[next])) next++;
      if (argv[next]) cwd = path.resolve(cwd, argv[next]);
    }
    if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(argv[i])) continue;
    let j = i + 1;
    while (argv[j]?.startsWith('-')) {
      if (/^(-e|--eval|-p|--print)$/.test(argv[j])) break;
      if (/^(--require|-r|--import|--loader)$/.test(argv[j])) j++;
      j++;
    }
    if (!/\.(mjs|cjs|js)$/i.test(argv[j] || '')) continue;
    const file = path.resolve(cwd, argv[j]); if (official(file)) continue;
    let source; try { source = fs.readFileSync(file,'utf8'); } catch { continue; }
    const sending = (/beeper-api/.test(source) && /\bimport\b/.test(source) && /\bsendMessage\s*\(/.test(source))
      || (source.includes('/v1/chats/') && /messages/.test(source) && /POST/i.test(source))
      || (source.includes('discord.com/api') && source.includes('/messages') && /POST/i.test(source))
      || (source.includes('gmail.googleapis.com') && source.includes('messages/send'))
      || (source.includes('api.line.me') && /push|reply|multicast/.test(source));
    if (sending) return { decision:'block', reason:REASON };
  }
  return { decision:'pass' };
}
export async function main() {
  try {
    const raw = await readStdinWithTimeout(4000); if (!raw.trim()) return;
    const result = judge(JSON.parse(raw));
    if (result.decision === 'block') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason:result.reason } }));
      console.error(result.reason); process.exitCode = 2;
    }
  } catch (error) { console.error(`[ONEOFF-SEND] 判定をスキップ: ${error.message}`); }
}
if (isEntry(import.meta.url)) await main();
