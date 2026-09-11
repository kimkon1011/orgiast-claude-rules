#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { resolveVscodeCli } from './next-session-launch.mjs';

export function parseMobileArgs(argv) {
  let count = 3;
  let name = 'スマホ用セッション';
  let recreate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--count') count = Number.parseInt(argv[++index], 10);
    else if (value === '--name') name = argv[++index];
    else if (value === '--recreate') recreate = true;
    else throw new Error(`不明な引数です: ${value}`);
  }
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('--count は 1..10 の整数で指定してください');
  if (!name) throw new Error('--name は空にできません');
  return { count, name, recreate };
}

export function buildMobileSessionsUri({ count, name, recreate = false }) {
  const suffix = recreate ? '&recreate=1' : '';
  return `vscode://orgiast.next-session/mobile?count=${count}&name=${encodeURIComponent(name)}${suffix}`;
}

export function planMobileSessionsLaunch({ codeCli, count, name, recreate = false }) {
  if (!codeCli) return null;
  const uri = buildMobileSessionsUri({ count, name, recreate });
  return {
    command: 'cmd.exe',
    args: ['/c', `""${codeCli}" --open-url "${uri}""`],
    windowsVerbatimArguments: true,
  };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? console.log;
  if (env.CLAUDE_HEADLESS || env.CI) {
    log('[mobile-sessions] 無人ジョブでは起動しません');
    return 0;
  }
  let options;
  try { options = parseMobileArgs(argv); } catch (error) {
    log(`[mobile-sessions] ${error.message}`);
    return 2;
  }
  const exists = io.exists ?? fs.existsSync;
  const home = io.homedir ?? os.homedir();
  const codeCli = resolveVscodeCli({ env, exists, homedir: home });
  const plan = planMobileSessionsLaunch({ codeCli, ...options });
  if (!plan) {
    log('[mobile-sessions] VSCode CLI (code.cmd) が見つかりません');
    return 1;
  }
  const spawnProcess = io.spawn ?? spawn;
  const child = spawnProcess(plan.command, plan.args, {
    stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  log(`[mobile-sessions] URI dispatch exit=${exitCode ?? 'signal'} count=${options.count} recreate=${options.recreate}`);
  return exitCode ?? 1;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
