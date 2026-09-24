#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import pool from './lib/mobile-state.cjs';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { resolveVscodeCli } from './next-session-launch.mjs';

export function parseMobileArgs(argv, defaultCount = 1) {
  let count = defaultCount;
  let dryRun = false;
  let name = 'スマホ用セッション';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--count') count = Number(argv[++index]);
    else if (value === '--dry-run') dryRun = true;
    else if (value === '--name') name = argv[++index];
    else throw new Error(`不明な引数です: ${value}`);
  }
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('--count は 1..10 の整数で指定してください');
  if (!name) throw new Error('--name は空にできません');
  return { count, name, ...(dryRun ? { dryRun } : {}) };
}

export function buildMobileSessionsUri({ count, name }) {
  return `vscode://orgiast.next-session/mobile?count=${count}&name=${encodeURIComponent(name)}`;
}

export function planMobileSessionsLaunch({ codeCli, count, name }) {
  if (!codeCli) return null;
  const uri = buildMobileSessionsUri({ count, name });
  return {
    command: 'cmd.exe',
    args: ['/c', `""${codeCli}" --open-url "${uri}""`],
    windowsVerbatimArguments: true,
  };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? console.log;
  if ((env.CLAUDE_HEADLESS || env.CI) && !argv.includes('--dry-run')) {
    log('[mobile-sessions] 無人ジョブでは起動しません');
    return 0;
  }
  const home = io.homedir ?? env.ORGIAST_HOME ?? os.homedir();
  let options;
  try { options = parseMobileArgs(argv, pool.readConfig(home, env)); } catch (error) {
    log(`[mobile-sessions] ${error.message}`);
    return 2;
  }
  const exists = io.exists ?? fs.existsSync;
  if (options.dryRun) {
    const state = pool.readSnapshot(home);
    const waiting = state?.waiting ?? '不明（拡張の状態未取得・期限切れ）';
    const missing = state ? Math.max(0, options.count - state.waiting) : '不明';
    log(`[mobile-sessions] 現在の待機数: ${waiting} / 目標: ${options.count} / 起動する本数: ${missing} (dry-run: 起動なし)`);
    return 0;
  }
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
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`VSCode CLI exit ${code}`)));
    child.once('error', reject);
  });
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
