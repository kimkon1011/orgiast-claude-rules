#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

// 機種依存パスを持たない。専用 worktree は共有クローンと同じ .git を指すので、
// ランチャーが専用 worktree 側から起動されても fetch / worktree add はそのまま通る。
export const DEFAULT_SHARED_REPO = path.resolve(import.meta.dirname, '..');

export function planCommands({ sharedRepo, pinnedTree, treeExists }) {
  const commands = [
    { label: 'fetch origin/main', cwd: sharedRepo, args: ['fetch', 'origin', 'main', '--quiet'] },
  ];
  if (!treeExists) {
    // ブランチを占有して対話セッションを妨害しないよう、専用 tree は必ず detached にする。
    commands.push({
      label: 'create pinned worktree',
      cwd: sharedRepo,
      args: ['worktree', 'add', '--detach', pinnedTree, 'origin/main'],
    });
  } else {
    // hard reset と clean は、誰も手で編集しない専用 tree にだけ限定する。
    commands.push(
      { label: 'reset pinned worktree', cwd: pinnedTree, args: ['reset', '--hard', 'origin/main', '--quiet'] },
      { label: 'clean pinned worktree', cwd: pinnedTree, args: ['clean', '-fd', '--quiet'] },
    );
  }
  return commands;
}

export function launchArgs(pinnedTree, argv) {
  return [path.join(pinnedTree, 'tools', 'auto-session.mjs'), ...argv];
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}

function exitCode(result) {
  if (Number.isInteger(result)) return result;
  if (Number.isInteger(result?.code)) return result.code;
  return 0;
}

export async function main(argv, io = {}) {
  const sharedRepo = process.env.ORGIAST_REPO || DEFAULT_SHARED_REPO;
  const pinnedTree = process.env.ORGIAST_AUTO_SESSION_TREE
    // 状態ディレクトリ(~/.claude/auto-session)の中に git tree を入れ子にすると
    // runs/ や .lock と混ざるので、兄弟ディレクトリに置く。
    || path.join(os.homedir(), '.claude', 'auto-session-repo');
  const run = io.run ?? defaultRun;
  const exists = io.exists ?? fs.existsSync;
  const log = io.log ?? ((message) => console.error(message));
  // ディレクトリだけ残った壊れた worktree を「用意できている」と誤判定しないよう、
  // 実際に起動する対象ファイルの有無で判定する。
  const entryPoint = launchArgs(pinnedTree, [])[0];
  const initialTreeExists = exists(entryPoint);
  const commands = planCommands({ sharedRepo, pinnedTree, treeExists: initialTreeExists });

  let preparationFailed = false;
  for (const command of commands) {
    try {
      const result = await run('git', command.args, { cwd: command.cwd, stdio: 'inherit' });
      if (exitCode(result) !== 0) throw new Error(`終了コード ${exitCode(result)}`);
    } catch (error) {
      preparationFailed = true;
      log(`[auto-session-launcher] 警告: ${command.label} に失敗しました: ${error?.message ?? error}`);
      break;
    }
  }

  // ネットワーク断や更新失敗で夜間実行を消さないため、既存 tree があれば古い状態でも起動する。
  if (!exists(entryPoint)) {
    log('[auto-session-launcher] エラー: 専用 worktree を用意できないため実行できません。');
    return 1;
  }
  if (preparationFailed) {
    log('[auto-session-launcher] 既存の専用 worktree を使って夜間実行を継続します。');
  }

  try {
    return exitCode(await run(process.execPath, launchArgs(pinnedTree, argv), { stdio: 'inherit' }));
  } catch (error) {
    log(`[auto-session-launcher] エラー: auto-session を起動できませんでした: ${error?.message ?? error}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
