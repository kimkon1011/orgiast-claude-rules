#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export function parseHandoffCwd(text) {
  const match = String(text).match(/<!--[^\r\n]*?cwd:\s*(.*?)\s*-->/);
  return match?.[1]?.trim() ?? '';
}

export function pickNewestExtensionBinary(names) {
  const candidates = names.flatMap((name) => {
    const match = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-/);
    return match ? [{ name, version: match.slice(1).map(Number) }] : [];
  });
  candidates.sort((a, b) => {
    for (let index = 0; index < 3; index += 1) {
      if (a.version[index] !== b.version[index]) return b.version[index] - a.version[index];
    }
    return 0;
  });
  return candidates[0]?.name ?? '';
}

// ネイティブインストール版は %APPDATA%\Claude\claude-code\<version>\claude.exe に入る。
// VSCode 拡張を入れていない機体でも起動できるよう、バージョン付きディレクトリから最新を選ぶ。
export function pickNewestVersionDir(names) {
  const candidates = names.flatMap((name) => {
    const match = String(name).match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? [{ name, version: match.slice(1).map(Number) }] : [];
  });
  candidates.sort((a, b) => {
    for (let index = 0; index < 3; index += 1) {
      if (a.version[index] !== b.version[index]) return b.version[index] - a.version[index];
    }
    return 0;
  });
  return candidates[0]?.name ?? '';
}

export function resolveClaudeBinary(io) {
  const { env, exists, readdir } = io;
  const homedir = typeof io.homedir === 'function' ? io.homedir() : io.homedir;
  if (env.CLAUDE_CLI_PATH && exists(env.CLAUDE_CLI_PATH)) return env.CLAUDE_CLI_PATH;

  const candidates = [
    path.join(homedir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(homedir, '.local', 'bin', 'claude.exe'),
    path.join(homedir, '.local', 'bin', 'claude'),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const installedDir = path.join(homedir, 'AppData', 'Roaming', 'Claude', 'claude-code');
  try {
    const version = pickNewestVersionDir(readdir(installedDir));
    if (version) {
      const binary = path.join(installedDir, version, 'claude.exe');
      if (exists(binary)) return binary;
    }
  } catch { /* インストール版が無い機体では黙って次へ */ }

  const extensionsDir = path.join(homedir, '.vscode', 'extensions');
  try {
    const extension = pickNewestExtensionBinary(readdir(extensionsDir));
    if (!extension) return '';
    const binary = path.join(extensionsDir, extension, 'resources', 'native-binary', 'claude.exe');
    return exists(binary) ? binary : '';
  } catch {
    return '';
  }
}

// Windows Terminal(wt.exe)は WindowsApps の実行エイリアス(reparse point)なので、
// fs.existsSync / statSync が EACCES で false を返す(2026-08-28 実測)。
// 存在確認は親ディレクトリの readdir で行う。ここを exists で書くと必ず conhost に落ちる。
export function resolveWt(io) {
  const { env, readdir, flagWt } = io;
  const homedir = typeof io.homedir === 'function' ? io.homedir() : io.homedir;
  if (flagWt !== undefined) return flagWt;
  if (env.WT_PATH) return env.WT_PATH;
  const dir = path.join(homedir, 'AppData', 'Local', 'Microsoft', 'WindowsApps');
  try {
    return readdir(dir).includes('wt.exe') ? path.join(dir, 'wt.exe') : '';
  } catch {
    return '';
  }
}

export function resolveVscodeCli(io) {
  const { env, exists } = io;
  const homedir = typeof io.homedir === 'function' ? io.homedir() : io.homedir;
  const candidates = [
    env.VSCODE_CLI_PATH,
    path.join(homedir, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd',
  ];
  return candidates.find((candidate) => candidate && exists(candidate)) ?? '';
}

export function buildVscodeUri(prompt) {
  const base = 'vscode://Anthropic.claude-code/open';
  return prompt ? `${base}?prompt=${encodeURIComponent(prompt)}` : base;
}

// 既定では URI を撃つだけにする。`code.cmd <cwd>` を先に走らせると、そのフォルダを開いている
// **既存ウィンドウが再読み込みされ拡張ホストが再起動する**（2026-08-30 実測。走っていたセッションが
// state_sync からやり直しになり、直後に撃った URI も落ちた）。新タブは「いま開いているウィンドウの
// ワークスペース」で開くので、通常はそれが正しい cwd になる。別フォルダを開きたい時だけ --open-folder。
// その場合も `-n`(新規ウィンドウ)にして既存ウィンドウを触らない。
export function planVscodeLaunch({ codeCli, cwd, prompt, openFolder = false }) {
  if (!codeCli) return null;
  const steps = [];
  if (openFolder) {
    if (!cwd) return null;
    steps.push({ label: 'open-folder', command: 'cmd.exe', args: ['/c', codeCli, '-n', cwd] });
  }
  steps.push({ label: 'open-session', command: 'cmd.exe', args: ['/c', codeCli, '--open-url', buildVscodeUri(prompt)] });
  return steps;
}

// 既定はターミナル。VSCode 経路(URI)は**新しいタブを開くだけでプロンプトを送信しない**ので、
// 自動で /session-start まで到達できない(拡張 2.1.251 実測 / 2026-08-30)。argv で
// `claude "/session-start"` を起動するターミナル経路だけが手数ゼロで成立する。
// VSCode の中に開きたい時だけ --target vscode / ORGIAST_NEXT_SESSION_TARGET=vscode。
export function pickRoute({ codeCli, flagTarget, env }) {
  if (flagTarget === 'vscode' || env.ORGIAST_NEXT_SESSION_TARGET === 'vscode') return 'vscode';
  return 'terminal';
}

// 親セッションの環境変数をそのまま渡すと、新しいセッションが「今のセッションの子」として
// 起動してしまう(CLAUDE_CODE_SESSION_ID / CLAUDECODE / CLAUDE_CODE_MESSAGING_SOCKET を継承し、
// VSCode 拡張の IPC に相乗りする)。CLAUDE* は原則すべて落とし、必要なものだけ残す。
export const KEPT_CLAUDE_ENV = new Set(['CLAUDE_CLI_PATH', 'CLAUDE_CONFIG_DIR']);

export function sanitizeEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^CLAUDE/i.test(key) && !KEPT_CLAUDE_ENV.has(key.toUpperCase())) continue;
    clean[key] = value;
  }
  return clean;
}

export function planLaunch({ claudeBin, cwd, prompt, wt }) {
  if (!claudeBin || !cwd) return null;
  if (wt) {
    return { command: wt, args: ['-w', 'new-window', '-d', cwd, claudeBin, prompt], cwd, detached: true };
  }
  return {
    command: 'cmd.exe',
    args: ['/c', 'start', '', '/D', cwd, claudeBin, prompt],
    cwd,
    detached: true,
  };
}

export function shouldLaunch({ state, now, env, force }) {
  if (state.enabled === false) {
    return { ok: false, reason: '設定で無効化されています (~/.claude/next-session-launch.json の enabled:false)' };
  }
  if (env.ORGIAST_NO_AUTO_NEXT_SESSION === '1') {
    return { ok: false, reason: 'ORGIAST_NO_AUTO_NEXT_SESSION=1 で抑止されています' };
  }
  if (env.CLAUDE_HEADLESS || env.CI) {
    return { ok: false, reason: '無人実行(headless/CI)なので対話セッションは起動しません' };
  }
  const lastLaunch = Date.parse(state.lastLaunchAt);
  if (!force && !Number.isNaN(lastLaunch) && now - lastLaunch < 120_000) {
    return { ok: false, reason: '120秒以内に起動済みなので二重起動を防ぎます' };
  }
  return { ok: true };
}

function parseArgs(argv) {
  const result = { dryRun: false, prompt: '/session-start', cwd: '', force: false, wt: undefined, target: undefined, openFolder: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--open-folder') result.openFolder = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--prompt' && argv[index + 1] !== undefined) result.prompt = argv[++index];
    else if (arg === '--cwd' && argv[index + 1] !== undefined) result.cwd = argv[++index];
    else if (arg === '--wt' && argv[index + 1] !== undefined) result.wt = argv[++index];
    else if (arg === '--target' && argv[index + 1] !== undefined) result.target = argv[++index];
  }
  return result;
}

export async function launchNextSession(argv = [], io = {}) {
  const env = io.env ?? process.env;
  const getHomedir = io.homedir ?? os.homedir;
  const home = typeof getHomedir === 'function' ? getHomedir() : getHomedir;
  const exists = io.exists ?? fs.existsSync;
  const readdir = io.readdir ?? fs.readdirSync;
  const readFile = io.readFile ?? fs.promises.readFile;
  const writeFile = io.writeFile ?? fs.promises.writeFile;
  const rename = io.rename ?? fs.promises.rename;
  const spawnProcess = io.spawn ?? spawn;
  const wait = io.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = io.log ?? console.log;

  try {
    const flags = parseArgs(argv);
    const claudeDir = path.join(home, '.claude');
    const statePath = path.join(claudeDir, 'next-session-launch.json');
    const handoffPath = path.join(claudeDir, 'next-session.md');
    const currentPath = path.join(claudeDir, 'current-session.json');
    const readText = async (file) => {
      try { return await readFile(file, 'utf8'); } catch { return ''; }
    };
    const readJson = async (file, fallback) => {
      try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
    };

    const state = await readJson(statePath, { enabled: true });
    const decision = shouldLaunch({ state, now: Date.now(), env, force: flags.force });
    if (!decision.ok) {
      log(`[next-session] スキップ: ${decision.reason}`);
      return 0;
    }

    const handoffCwd = parseHandoffCwd(await readText(handoffPath));
    const current = await readJson(currentPath, {});
    const cwd = flags.cwd || handoffCwd || current.cwd || REPO_ROOT;
    const codeCli = resolveVscodeCli({ env, exists, homedir: home });
    const route = pickRoute({ codeCli, flagTarget: flags.target, env });

    if (route === 'vscode') {
      if (!codeCli) {
        log('[next-session] スキップ: VSCode CLI (code.cmd) が見つかりません (VSCODE_CLI_PATH で明示できます)');
        return 0;
      }
      const steps = planVscodeLaunch({ codeCli, cwd, prompt: flags.prompt, openFolder: flags.openFolder });
      if (flags.dryRun) {
        log(JSON.stringify({ route: 'vscode', steps }));
        return 0;
      }

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const child = spawnProcess(step.command, step.args, {
          cwd,
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
          env: sanitizeEnv(env),
        });
        const isLast = index === steps.length - 1;
        if (typeof child.once === 'function') {
          // 先行手順は終了まで待つ。最後の1手は起動を確認したら待たない(code.cmd の終了を待つ必要はない)。
          await new Promise((resolve, reject) => {
            child.once(isLast ? 'spawn' : 'exit', resolve);
            child.once('error', reject);
          });
        }
        if (isLast && typeof child.unref === 'function') child.unref();
        if (!isLast) await wait(2500);
      }

      const nextState = { ...state, enabled: state.enabled !== false, lastLaunchAt: new Date().toISOString(), lastCwd: cwd, lastRoute: route };
      const tmpPath = `${statePath}.tmp-${process.pid}`;
      await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
      await rename(tmpPath, statePath);
      // 拡張の URI は prompt を送信しない(入力欄に置くだけ)。「開いた=始まった」と書くと嘘の成功報告になる。
      log(`[next-session] VSCode に新しいタブを開きました(prompt は送信されません。セッションは入力欄で送信すると始まります): ${cwd} / prompt=${flags.prompt}`);
      return 0;
    }

    const claudeBin = resolveClaudeBinary({ env, exists, readdir, homedir: home });
    if (!claudeBin) {
      log('[next-session] スキップ: claude CLI が見つかりません (CLAUDE_CLI_PATH で明示できます)');
      return 0;
    }

    const wt = resolveWt({ env, readdir, homedir: home, flagWt: flags.wt });
    const plan = planLaunch({ claudeBin, cwd, prompt: flags.prompt, wt });
    if (flags.dryRun) {
      log(JSON.stringify(plan));
      return 0;
    }

    const child = spawnProcess(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: sanitizeEnv(env),
    });
    if (typeof child.once === 'function') {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    }
    child.unref();

    const nextState = { ...state, enabled: state.enabled !== false, lastLaunchAt: new Date().toISOString(), lastCwd: cwd, lastRoute: route };
    const tmpPath = `${statePath}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    await rename(tmpPath, statePath);
    log(`[next-session] 新しいセッションを起動しました: ${cwd} / prompt=${flags.prompt}`);
    return 0;
  } catch (error) {
    log(`[next-session] スキップ: 起動に失敗しました (${error?.message ?? error})`);
    return 0;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await launchNextSession(process.argv.slice(2));
}
