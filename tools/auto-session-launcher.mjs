#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

// 機種依存パスを持たない。専用 worktree は共有クローンと同じ .git を指すので、
// ランチャーが専用 worktree 側から起動されても fetch / worktree add はそのまま通る。
export const DEFAULT_SHARED_REPO = path.resolve(import.meta.dirname, '..');

// pinnedTree に対する更新コマンドのうち、失敗が「ローカル tree が汚れている」ことを意味するもの。
// これらが失敗した場合だけ使い捨て fallback tree を作る（fetch 失敗＝ネットワーク断とは区別する）。
const LOCAL_STATE_LABELS = new Set([
  'detach pinned worktree',
  'reset pinned worktree',
  'clean pinned worktree',
]);

const FALLBACK_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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
      // 前回の夜間セッションが作業ブランチを checkout したまま終わっていることがある。
      // その状態で reset --hard すると「そのブランチの ref ごと」origin/main へ動いてしまうので、
      // 先に detach して、reset がどのブランチも巻き込まないようにする。
      { label: 'detach pinned worktree', cwd: pinnedTree, args: ['checkout', '--detach', 'origin/main', '--quiet'] },
      { label: 'reset pinned worktree', cwd: pinnedTree, args: ['reset', '--hard', 'origin/main', '--quiet'] },
      { label: 'clean pinned worktree', cwd: pinnedTree, args: ['clean', '-fd', '--quiet'] },
    );
  }
  return commands;
}

export function launchArgs(pinnedTree, argv) {
  return [path.join(pinnedTree, 'tools', 'auto-session.mjs'), ...argv];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// pinnedTree が汚れていて更新できない時に使う、使い捨て worktree のパス。
// 機種依存パスを持たないよう pinnedTree と同じ親ディレクトリの兄弟パスにする。
export function fallbackTreePath(pinnedTree, date) {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `${pinnedTree}-fallback-${stamp}`;
}

function parseFallbackStamp(token) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(token);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? null : date;
}

// 溜まり続けた古い fallback tree を掃除する。失敗しても夜間実行を止めてはいけないため、
// readdir / remove / prune のどこで失敗しても無視して先へ進む（呼び出し元へ例外を投げない）。
async function cleanupStaleFallbackTrees({ sharedRepo, pinnedTree, now, run, readdir }) {
  const dir = path.dirname(pinnedTree);
  const prefix = `${path.basename(pinnedTree)}-fallback-`;
  let entries;
  try {
    entries = readdir(dir);
  } catch {
    return;
  }
  const cutoff = now().getTime() - FALLBACK_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const parsed = parseFallbackStamp(entry.slice(prefix.length));
    if (!parsed || parsed.getTime() >= cutoff) continue;
    try {
      await run('git', ['worktree', 'remove', '--force', path.join(dir, entry)], {
        cwd: sharedRepo,
        stdio: ['inherit', 'inherit', 'pipe'],
      });
    } catch {}
  }
  try {
    await run('git', ['worktree', 'prune'], { cwd: sharedRepo, stdio: ['inherit', 'inherit', 'pipe'] });
  } catch {}
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    child.once('error', () => resolve({ code: 1, stderrTail }));
    child.once('close', (code) => resolve({ code: Number.isInteger(code) ? code : 1, stderrTail }));
  });
}

function exitCode(result) {
  if (Number.isInteger(result)) return result;
  if (Number.isInteger(result?.code)) return result.code;
  return 0;
}

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}${sign}${hh}:${mm}`;
}

export function appendLauncherLog(file, message, io = {}) {
  const read = io.readFile ?? fs.readFileSync;
  const write = io.writeFile ?? fs.writeFileSync;
  const mkdir = io.mkdir ?? fs.mkdirSync;
  try {
    mkdir(path.dirname(file), { recursive: true });
    let lines = [];
    try { lines = String(read(file, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-500); } catch {}
    lines.push(message);
    write(file, `${lines.slice(-500).join('\n')}\n`);
  } catch {}
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
  const now = io.now ?? (() => new Date());
  const readdir = io.readdir ?? ((dir) => fs.readdirSync(dir));
  const bootLog = io.bootLog ?? ((message) => appendLauncherLog(path.join(os.homedir(), '.claude', 'auto-session', 'launcher.log'), message));
  const started = now();
  const stamp = () => `[${localIso(now())}]`;
  bootLog(`${stamp()} start argv=${JSON.stringify(argv)} pinnedTree=${pinnedTree}`);
  // ディレクトリだけ残った壊れた worktree を「用意できている」と誤判定しないよう、
  // 実際に起動する対象ファイルの有無で判定する。
  const initialEntryPoint = launchArgs(pinnedTree, [])[0];
  const initialTreeExists = exists(initialEntryPoint);
  const commands = planCommands({ sharedRepo, pinnedTree, treeExists: initialTreeExists });

  let networkFailure = false;
  let localStateFailure = false;
  let genericFailure = false;

  for (const command of commands) {
    try {
      const result = await run('git', command.args, {
        cwd: command.cwd,
        stdio: ['inherit', 'inherit', 'pipe'],
      });
      if (exitCode(result) !== 0) {
        const error = new Error(`終了コード ${exitCode(result)}`);
        error.stderrTail = result?.stderrTail;
        throw error;
      }
    } catch (error) {
      const warning = `[auto-session-launcher] 警告: ${command.label} に失敗しました: ${error?.message ?? error}`;
      const warningWithStderr = error?.stderrTail ? `${warning}\nstderr: ${error.stderrTail}` : warning;
      log(warningWithStderr);
      bootLog(`${stamp()} ${warningWithStderr}`);
      if (command.label === 'fetch origin/main') networkFailure = true;
      else if (LOCAL_STATE_LABELS.has(command.label)) localStateFailure = true;
      else genericFailure = true;
      break;
    }
  }

  // ローカル tree の状態が原因で更新に失敗した場合だけ、pinnedTree には一切書き込まず
  // 使い捨て tree を新規に作ってそこから起動する（他セッションの未コミット作業を壊さないため）。
  let launchTree = pinnedTree;
  if (localStateFailure) {
    const fallbackTree = fallbackTreePath(pinnedTree, now());
    let fallbackOk = false;
    try {
      const result = await run('git', ['worktree', 'add', '--detach', fallbackTree, 'origin/main'], {
        cwd: sharedRepo,
        stdio: ['inherit', 'inherit', 'pipe'],
      });
      if (exitCode(result) !== 0) {
        const error = new Error(`終了コード ${exitCode(result)}`);
        error.stderrTail = result?.stderrTail;
        throw error;
      }
      fallbackOk = true;
    } catch (error) {
      const warning = `[auto-session-launcher] 警告: fallback tree の作成に失敗しました: ${error?.message ?? error}`;
      const warningWithStderr = error?.stderrTail ? `${warning}\nstderr: ${error.stderrTail}` : warning;
      log(warningWithStderr);
      bootLog(`${stamp()} ${warningWithStderr}`);
    }
    if (fallbackOk) {
      launchTree = fallbackTree;
      log(`[auto-session-launcher] pinnedTree を更新できないため使い捨て tree ${fallbackTree} から起動します。`);
    } else {
      // fallback tree の作成にも失敗した時だけ、最後の手段として古い tree のまま起動する。
      // 「黙って古いコードで走った」ことを後から grep 一発で分かるよう stale マーカーを残す。
      const staleWarning = '[auto-session-launcher] 警告: stale 実行 — origin/main へ更新できず古い tree のまま起動します';
      log(staleWarning);
      bootLog(`${stamp()} ${staleWarning}`);
    }
  }

  // fallback tree が溜まり続けないよう、3日より古いものを掃除する。失敗しても致命にしない。
  await cleanupStaleFallbackTrees({ sharedRepo, pinnedTree, now, run, readdir });

  const entryPoint = launchArgs(launchTree, [])[0];

  // ネットワーク断や更新失敗で夜間実行を消さないため、既存 tree があれば古い状態でも起動する。
  if (!exists(entryPoint)) {
    log('[auto-session-launcher] エラー: 専用 worktree を用意できないため実行できません。');
    bootLog(`${stamp()} abort 専用 worktree を用意できません`);
    return 1;
  }
  if (networkFailure || genericFailure) {
    log('[auto-session-launcher] 既存の専用 worktree を使って夜間実行を継続します。');
    bootLog(`${stamp()} 警告は非致命: 既存の専用 worktree を使って継続します`);
  }
  // どの tree から起動したかを必ず残す（fallback したかどうかが後から読めるように）。
  bootLog(`${stamp()} launched from ${launchTree}`);

  try {
    // タスクスケジューラ経由では inherit した子の stderr が保存されないため、終了状態は boot log に残す。
    const result = await run(process.execPath, launchArgs(launchTree, argv), {
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    const code = exitCode(result);
    bootLog(`${stamp()} exit ${code} elapsed=${Math.max(0, Math.round((now() - started) / 1000))}s`);
    if (code !== 0 && result?.stderrTail) bootLog(`${stamp()} stderr: ${result.stderrTail}`);
    return code;
  } catch (error) {
    log(`[auto-session-launcher] エラー: auto-session を起動できませんでした: ${error?.message ?? error}`);
    bootLog(`${stamp()} abort auto-session を起動できませんでした: ${error?.message ?? error}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
