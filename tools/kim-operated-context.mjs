#!/usr/bin/env node
import os from 'node:os';
import { isKimOperated, claudeAccount } from './lib/kim-operated.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export async function main() {
  try {
    await readStdinWithTimeout();
    const home = process.env.ORGIAST_HOME || os.homedir();
    const account = claudeAccount(home);
    if (!isKimOperated(home, account)) return;
    const additionalContext = `この席の Claude アカウント（${account}）を操作しているのは kim＝金功勇（社長）本人。user を別人（cr さん等）として扱わない。\n社長確認・承認はこのチャットで全文を見せて user に直接聞く。kim 宛ての Bot DM で承認を頼み直したり、user に『金さんに伝えて』と頼んだりしない。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
