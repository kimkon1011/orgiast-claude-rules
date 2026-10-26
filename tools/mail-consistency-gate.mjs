#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"mail-consistency-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"mail-consistency-gate"}]};
import fs from 'node:fs/promises';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const HOOK_MATCHER = 'Bash|PowerShell';
const LIMIT = 5 * 1024 * 1024;
const SEND = /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/(?:messages|drafts)\/send|users\.messages\.send/u;
const tokens = command => (String(command).match(/(?:"[^"]*"|'[^']*'|[^\s"';|&])+|[;|&\n]+/gu) ?? []).map(x=>x.replace(/(["'])(.*?)\1/gu,'$2'));
async function readLimited(file) { const h=await fs.open(file,'r'); try { if((await h.stat()).size>LIMIT) throw new Error('5MB超'); const b=Buffer.alloc(LIMIT+1); const {bytesRead}=await h.read(b,0,b.length,0); if(bytesRead>LIMIT)throw new Error('5MB超'); return b.subarray(0,bytesRead).toString('utf8'); } finally { await h.close(); } }
export async function judge(input, { warning = () => {} } = {}) {
  try {
    if (!input || !/^(?:Bash|PowerShell)$/u.test(input.tool_name ?? '')) return { decision:'pass' };
    const command=String(input.tool_input?.command??''); const argv=tokens(command);
    if (/(?:^|[\\/])gmail-draft\.mjs\b/u.test(command)) {
      const ack=argv.indexOf('--ack-consistency');
      return ack>=0 ? {decision:'pass', additionalContext:`整合性チェックの例外承認理由「${argv[ack+1]??''}」を完了報告に必ず記載すること。`} : {decision:'pass'};
    }
    if(SEND.test(command)) return {decision:'block',reason:'生の Gmail API 送信は禁止です。node tools/gmail-draft.mjs --send <draftId> --json を使い、スレッド全体との整合性チェックを通してください。'};
    let cwd=input.cwd||process.cwd();
    for(let i=0;i<argv.length;i++) {
      if(/^(?:cd|Set-Location)$/iu.test(argv[i])&&argv[i+1]) cwd=path.resolve(cwd,argv[i+1]);
      if(!/(?:^|[\\/])node(?:\.exe)?$/iu.test(argv[i])) continue;
      let j=i+1; while(argv[j]?.startsWith('-')&&!/^(?:-e|--eval|-p|--print)/u.test(argv[j])) j++;
      if(!/\.(?:mjs|cjs|js)$/iu.test(argv[j]??'')) continue;
      const file=path.resolve(cwd,argv[j]); if(path.basename(file)==='gmail-draft.mjs') continue;
      if(SEND.test(await readLimited(file))) return {decision:'block',reason:'このスクリプトは生の Gmail API 送信を含みます。node tools/gmail-draft.mjs --send <draftId> --json を使ってください。'};
    }
  } catch(error) { warning(`判定をスキップ: ${error.message}`); }
  return {decision:'pass'};
}
export async function main(){try{const raw=await readStdinWithTimeout(4000);if(!raw.trim())return;const r=await judge(JSON.parse(raw),{warning:t=>console.error(`[MAIL-CONSISTENCY] ${t}`)});if(r.decision==='block')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:r.reason}}));else if(r.additionalContext)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:r.additionalContext}}));}catch(error){console.error(`[MAIL-CONSISTENCY] 判定をスキップ: ${error.message}`)}}
if(isEntry(import.meta.url))await main();
