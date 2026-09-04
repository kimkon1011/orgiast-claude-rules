#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { armToFile } from './session-relaunch.mjs';

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

export function buildVscodeExtUri({ prompt, cwd, claude, probe = false }) {
  const params = [
    `prompt=${encodeURIComponent(prompt)}`,
    `cwd=${encodeURIComponent(cwd)}`,
  ];
  if (claude) params.push(`claude=${encodeURIComponent(claude)}`);
  if (probe) params.push('probe=1');
  return `vscode://orgiast.next-session/start?${params.join('&')}`;
}

export function planVscodeExtLaunch({ codeCli, prompt, cwd, claude }) {
  if (!codeCli || !cwd) return null;
  const uri = buildVscodeExtUri({ prompt, cwd, claude });
  // URI は `&` 区切りの複数パラメータを持つ。cmd.exe は引用されていない `&` を
  // コマンド区切りとして解釈し、cwd/claude が別コマンド扱いで落ちる（2026-09-04 実測:
  // `'cwd' is not recognized as an internal or external command`）。cmd /c "..." の
  // 一枚文字列にして URI を引用符で囲み、windowsVerbatimArguments で node の再クォートを止める。
  return {
    label: 'open-session',
    command: 'cmd.exe',
    args: ['/c', `""${codeCli}" --open-url "${uri}""`],
    windowsVerbatimArguments: true,
  };
}

export function pickBundledVsix(names) {
  return names
    .filter((name) => /^orgiast-next-session-[0-9]+(?:\.[0-9]+){2}\.vsix$/.test(String(name)))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? '';
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

// 既定は VSCode(Claude Code のタブ)。ターミナル経路は wt.exe で**別ウィンドウの CLI セッション**を
// 立ち上げるため、VSCode 側で作業中のセッションと並走してぶつかる(2026-08-30 kim 指示で既定を反転)。
// VSCode 経路は URI で新しいタブを開き `/session-start` を入力欄に**置くだけ**で送信はしない
// (拡張 2.1.251 実測: webview は setInputText するのみ)。start は Enter 1 回だけ user が押す。
// ターミナルで開きたい時だけ --target terminal / ORGIAST_NEXT_SESSION_TARGET=terminal。
// **VSCode CLI が見つからない機体でもターミナルへは落とさない**(2026-08-30)。落とすと
// 「コードは VSCode 既定なのにターミナルが開く」が再発し、原因が env でも古いコピーでもなく
// codeCli 解決の失敗だった場合に気付けない。CLI が無い時は route=vscode のままスキップして
// 何も起動しない(呼び出し側でログを出す)。ターミナルは明示指定した時だけ。
// inline は「窓もタブも開かず、次に開いたセッションが自分から session-start を実行する」第三の経路。
// 起動先の軸は target 一本にする(mode という第二の軸を作ると target=vscode かつ mode=window のような
// 意味の無い組み合わせが生まれる)。旧 mode 表記は他機体に残っている可能性があるので読むだけ受ける。
// 旧 `window`(= wt.exe で別ウィンドウ)は vscode へ寄せる。既定を VSCode タブへ反転した 2026-08-30 の
// kim 指示より前の表記であり、いま terminal として復活させると「並走してぶつかる」実害へ戻る。
export function pickRoute({ codeCli, flagTarget, env, state = {} }) {
  const raw = flagTarget
    ?? env.ORGIAST_NEXT_SESSION_TARGET
    ?? env.ORGIAST_NEXT_SESSION_MODE
    ?? state.target
    ?? state.mode;
  const target = String(raw ?? '').trim().toLowerCase();
  if (target === 'inline') return 'inline';
  if (target === 'terminal') return 'terminal';
  if (target === 'vscode-ext') return 'vscode-ext';
  return 'vscode';
}

export function withTarget(state, value) {
  const normalized = String(value ?? '').toLowerCase();
  const target = normalized === 'window' ? 'vscode' : normalized;
  if (!['vscode', 'vscode-ext', 'terminal', 'inline'].includes(target)) return null;
  return { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}), target };
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

export function resolveConfigDir({ state, env, home }) {
  const stateConfigDir = typeof state?.configDir === 'string' ? state.configDir.trim() : '';
  if (stateConfigDir) {
    const configDir = /^~(?:[\\/]|$)/.test(stateConfigDir)
      ? path.join(home, stateConfigDir.replace(/^~[\\/]?/, ''))
      : stateConfigDir;
    return { configDir, source: 'state' };
  }

  const envConfigDir = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (envConfigDir) return { configDir: envConfigDir, source: 'env' };
  return { configDir: path.join(home, '.claude'), source: 'default' };
}

export function accountConfigPath(configDir, home) {
  const normalize = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase();
  return normalize(configDir) === normalize(path.join(home, '.claude'))
    ? path.join(home, '.claude.json')
    : path.join(configDir, '.claude.json');
}

export function pickAccountEmail(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return '';
  const email = config.oauthAccount?.emailAddress;
  return typeof email === 'string' && email.trim() ? email.trim() : '';
}

export function childEnv({ env, configDir, source }) {
  const clean = sanitizeEnv(env);
  if (source === 'state') clean.CLAUDE_CONFIG_DIR = configDir;
  return clean;
}

// VSCode 拡張のアカウントは拡張自身のログイン(secure storage)で決まり、CLAUDE_CONFIG_DIR では動かない。
// config dir から読んだメールを vscode 経路で断定すると、当たっている保証のない値を成功ログに書くことになる。
export function accountLabel({ account, route, accountPath }) {
  if (!account) return `不明(${accountPath})`;
  return route === 'vscode' || route === 'vscode-ext' ? `${account}(参考: 実際は VSCode ウィンドウのログイン)` : account;
}

export function trustKeyVariants(cwd) {
  const original = String(cwd ?? '');
  if (!original) return [];
  return [...new Set([
    original,
    original.replaceAll('/', '\\'),
    original.replaceAll('\\', '/'),
  ])];
}

export function applyTrust(config, cwd) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const sourceProjects = source.projects && typeof source.projects === 'object' && !Array.isArray(source.projects)
    ? source.projects
    : {};
  const projects = { ...sourceProjects };
  let changed = source.projects !== sourceProjects;

  for (const key of trustKeyVariants(cwd)) {
    const entry = sourceProjects[key];
    if (entry?.hasTrustDialogAccepted === true) continue;
    projects[key] = {
      ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}),
      hasTrustDialogAccepted: true,
    };
    changed = true;
  }

  return { config: changed ? { ...source, projects } : source, changed };
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

export function hasUnsentVscodeTab({ state, now, promptConsumed, windowMs = 6 * 60 * 60 * 1000 }) {
  if (state.lastRoute !== 'vscode') return false;
  const lastLaunch = Date.parse(state.lastLaunchAt);
  if (Number.isNaN(lastLaunch)) return false;
  if (now - lastLaunch >= windowMs) return false;
  return promptConsumed === false;
}

export function shouldLaunch({ state, now, env, force, pendingTab }) {
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
  if (!force && pendingTab === true) {
    return { ok: false, reason: '前回開いた VSCode タブがまだ未送信です。タブバー右端のタブ（タブ名 Claude Code）で Enter を押すと始まります。新しく開き直すには --force-launch' };
  }
  return { ok: true };
}

function parseArgs(argv) {
  const result = { dryRun: false, prompt: '/session-start', cwd: '', force: false, wt: undefined, target: undefined, openFolder: false, sessionId: '', action: '', actionValue: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--open-folder') result.openFolder = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--prompt' && argv[index + 1] !== undefined) result.prompt = argv[++index];
    else if (arg === '--cwd' && argv[index + 1] !== undefined) result.cwd = argv[++index];
    else if (arg === '--session' && argv[index + 1] !== undefined) result.sessionId = argv[++index];
    else if (arg === '--wt' && argv[index + 1] !== undefined) result.wt = argv[++index];
    else if (arg === '--target' && argv[index + 1] !== undefined) result.target = argv[++index];
    else if ((arg === '--set-target' || arg === '--set-mode') && argv[index + 1] !== undefined) { result.action = 'set-target'; result.actionValue = argv[++index]; }
    else if (arg === '--show-target' || arg === '--show-mode') result.action = 'show-target';
    else if (arg === '--enable') result.action = 'enable';
    else if (arg === '--disable') result.action = 'disable';
  }
  return result;
}

export async function launchNextSession(argv = [], io = {}) {
  const env = io.env ?? process.env;
  const getHomedir = io.homedir ?? os.homedir;
  const home = typeof getHomedir === 'function' ? getHomedir() : getHomedir;
  const exists = io.exists ?? fs.existsSync;
  const readdir = io.readdir ?? fs.readdirSync;
  const stat = io.stat ?? fs.statSync;
  const readHead = io.readHead ?? ((file, maxBytes = 65536) => {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  });
  const readFile = io.readFile ?? fs.promises.readFile;
  const writeFile = io.writeFile ?? fs.promises.writeFile;
  const rename = io.rename ?? fs.promises.rename;
  const spawnProcess = io.spawn ?? spawn;
  const wait = io.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = io.log ?? console.log;
  const arm = io.armToFile ?? armToFile;

  try {
    const flags = parseArgs(argv);
    const claudeDir = path.join(home, '.claude');
    const statePath = path.join(claudeDir, 'next-session-launch.json');
    const claudeConfigPath = path.join(home, '.claude.json');
    const handoffPath = path.join(claudeDir, 'next-session.md');
    const currentPath = path.join(claudeDir, 'current-session.json');
    const readText = async (file) => {
      try { return await readFile(file, 'utf8'); } catch { return ''; }
    };
    const readJson = async (file, fallback) => {
      try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
    };

    const state = await readJson(statePath, { enabled: true });
    const codeCli = resolveVscodeCli({ env, exists, homedir: home });
    let route = pickRoute({ codeCli, flagTarget: flags.target, env, state });

    if (flags.action) {
      if (flags.action === 'show-target') {
        log(`target=${route} / enabled=${state.enabled !== false}`);
        return 0;
      }
      let nextState;
      if (flags.action === 'set-target') {
        nextState = withTarget(state, flags.actionValue);
        if (!nextState) {
          log(`[next-session] エラー: target は vscode / vscode-ext / terminal / inline のいずれかを指定してください`);
          return 2;
        }
      } else {
        nextState = { ...state, enabled: flags.action === 'enable' };
      }
      const tmpPath = `${statePath}.tmp-${process.pid}`;
      await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
      await rename(tmpPath, statePath);
      if (flags.action === 'set-target') {
        log(`[next-session] target=${nextState.target} に設定しました`);
        if (nextState.enabled === false) log('[next-session] 停止中です。--enable が必要です');
      } else {
        log(`[next-session] enabled=${nextState.enabled}`);
      }
      return 0;
    }

    const now = typeof io.now === 'function' ? io.now() : (io.now ?? Date.now());
    let promptConsumed = null;
    const lastLaunch = Date.parse(state.lastLaunchAt);
    if (state.lastCwd && !Number.isNaN(lastLaunch)) {
      try {
        // auto-session.mjs の cwdSlug と同じ規則。前回開いた cwd の transcript bucket を見る。
        const slug = String(state.lastCwd ?? '').replace(/[^A-Za-z0-9]/g, '-');
        const transcriptDir = path.join(claudeDir, 'projects', slug);
        // bucket が無い = その cwd でセッションが1度も始まっていない = 注入した prompt は未消化。
        // ENOENT は「判定できない」ではなく「未送信」の積極的な証拠なので fail-open にしない。
        // 新しい cwd では必ずここを通るので、fail-open にすると抑止すべき場面でこそ効かなくなる
        // (2026-08-31 実測: lastCwd=...\aujust-sales-automation の bucket が存在せず抑止が空振りした)。
        let names;
        try {
          names = readdir(transcriptDir);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          names = [];
        }
        const candidates = names
          .filter((name) => String(name).endsWith('.jsonl'))
          .map((name) => ({ file: path.join(transcriptDir, name), birthtimeMs: stat(path.join(transcriptDir, name)).birthtimeMs }))
          .filter(({ birthtimeMs }) => typeof birthtimeMs === 'number' && Number.isFinite(birthtimeMs) && birthtimeMs > lastLaunch)
          .sort((a, b) => b.birthtimeMs - a.birthtimeMs)
          .slice(0, 10);
        const prompt = state.lastPrompt || flags.prompt;
        promptConsumed = false;
        for (const candidate of candidates) {
          const head = String(await readHead(candidate.file, 65536));
          // hook の添付レコードが "type":"user" で先に来ても掴まないよう "role":"user" まで見る
          // (実測: 直近 transcript 25件すべてで最初の "type":"user" 行は "role":"user" を持つ)
          const firstUserLine = head.split(/\r?\n/).find((line) => line.includes('"type":"user"') && line.includes('"role":"user"'));
          if (firstUserLine?.includes(prompt)) {
            promptConsumed = true;
            break;
          }
        }
      } catch {
        promptConsumed = null;
      }
    }
    const { configDir, source: configDirSource } = resolveConfigDir({ state, env, home });
    const firstAccountConfigPath = accountConfigPath(configDir, home);
    const nestedAccountConfigPath = path.join(configDir, '.claude.json');
    const homeAccountConfigPath = path.join(home, '.claude.json');
    const fallbackAccountConfigPath = firstAccountConfigPath === homeAccountConfigPath
      ? nestedAccountConfigPath
      : homeAccountConfigPath;
    let account = pickAccountEmail(await readJson(firstAccountConfigPath, null));
    if (!account && fallbackAccountConfigPath !== firstAccountConfigPath) {
      account = pickAccountEmail(await readJson(fallbackAccountConfigPath, null));
    }
    const launchEnv = childEnv({ env, configDir, source: configDirSource });
    const pendingTab = hasUnsentVscodeTab({ state, now, promptConsumed });
    const decision = shouldLaunch({ state, now, env, force: flags.force, pendingTab: route === 'inline' ? false : pendingTab });
    if (!decision.ok) {
      log(`[next-session] スキップ: ${decision.reason}`);
      return 0;
    }

    const handoffCwd = parseHandoffCwd(await readText(handoffPath));
    const current = await readJson(currentPath, {});
    const cwd = flags.cwd || handoffCwd || current.cwd || REPO_ROOT;
    const accountLog = accountLabel({ account, route, accountPath: firstAccountConfigPath });
    if (configDirSource === 'state' && (route === 'vscode' || route === 'vscode-ext')) {
      // 効かない指定を黙って無視すると「固定したつもり」の事故になる。terminal 経路なら env で効く。
      log(`[next-session] 注意: configDir(${configDir}) は VSCode 拡張経路では効きません。アカウントを固定するなら --target terminal を使ってください`);
    }

    if (route === 'inline') {
      if (flags.dryRun) {
        log(JSON.stringify({ route: 'inline', cwd, sessionId: flags.sessionId }));
        return 0;
      }
      const armed = arm({ home, sessionId: flags.sessionId, cwd });
      if (!armed) {
        log('[next-session] スキップ: session-relaunch が無効です (--on で有効化)');
        return 0;
      }
      const nextState = { ...state, enabled: state.enabled !== false, lastLaunchAt: new Date().toISOString(), lastCwd: cwd, lastRoute: 'inline', lastPrompt: flags.prompt, lastAccount: account, lastConfigDir: configDir };
      const tmpPath = `${statePath}.tmp-${process.pid}`;
      await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
      await rename(tmpPath, statePath);
      log(`[next-session] 予約しました(inline): /clear すると新しいセッションが自分から ${flags.prompt} を実行します`);
      return 0;
    }

    if (route === 'vscode-ext') {
      const claudeBin = resolveClaudeBinary({ env, exists, readdir, homedir: home });
      const step = planVscodeExtLaunch({ codeCli, cwd, prompt: flags.prompt, claude: claudeBin });
      if (flags.dryRun) {
        log(JSON.stringify({ route: 'vscode-ext', step, extensionId: 'orgiast.next-session', account, configDir, configDirSource }));
        return 0;
      }

      try {
        if (!codeCli) throw new Error('VSCode CLI (code.cmd) が見つかりません');
        const runCodeCli = io.runCodeCli ?? (async (args) => {
          const child = spawnProcess('cmd.exe', ['/c', codeCli, ...args], {
            cwd,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: launchEnv,
          });
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (chunk) => { stdout += chunk; });
          child.stderr?.on('data', (chunk) => { stderr += chunk; });
          const code = await new Promise((resolve, reject) => {
            child.once('exit', resolve);
            child.once('error', reject);
          });
          return { code, stdout, stderr };
        });
        const listed = await runCodeCli(['--list-extensions']);
        if (listed.code !== 0) throw new Error(`拡張一覧の取得に失敗しました: ${listed.stderr || `exit ${listed.code}`}`);
        const installed = String(listed.stdout).split(/\r?\n/).some((line) => line.trim().toLowerCase() === 'orgiast.next-session');
        if (!installed) {
          const packageDir = path.join(REPO_ROOT, 'packages', 'vscode-next-session');
          const vsixName = pickBundledVsix(readdir(packageDir));
          if (!vsixName) throw new Error(`同梱 VSIX が見つかりません: ${packageDir}`);
          const installedResult = await runCodeCli(['--install-extension', path.join(packageDir, vsixName), '--force']);
          if (installedResult.code !== 0) throw new Error(`拡張のインストールに失敗しました: ${installedResult.stderr || `exit ${installedResult.code}`}`);
        }

        const child = spawnProcess(step.command, step.args, {
          cwd,
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
          env: launchEnv,
          windowsVerbatimArguments: step.windowsVerbatimArguments === true,
        });
        if (typeof child.once === 'function') {
          // `spawn` は「プロセスを作った」だけで、code.cmd → Code.exe が起動中の VSCode へ URL を
          // IPC で渡し終える前に親が抜けると URI が届かない（2026-09-04 実測: ランチャー経由だと
          // ptyhost.log に端末起動が一切残らないが、exit を待つと即座に残る）。exit まで待つ。
          // ただし code.cmd が固まっても止まらないよう上限を設ける。
          await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
            const timer = setTimeout(() => finish(resolve), 30000);
            if (typeof timer.unref === 'function') timer.unref();
            child.once('exit', () => finish(resolve));
            child.once('error', (error) => finish(reject, error));
          });
        }
        if (typeof child.unref === 'function') child.unref();

        const nextState = { ...state, enabled: state.enabled !== false, lastLaunchAt: new Date().toISOString(), lastCwd: cwd, lastRoute: 'vscode-ext', lastPrompt: flags.prompt, lastAccount: account, lastConfigDir: configDir };
        const tmpPath = `${statePath}.tmp-${process.pid}`;
        await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
        await rename(tmpPath, statePath);
        log(`[next-session] VSCode の統合ターミナルで次セッションを起動しました: ${cwd} / prompt=${flags.prompt} / account=${accountLog}`);
        return 0;
      } catch (error) {
        log(`[next-session] vscode-ext を使えないため vscode 経路へフォールバックします: ${error?.message ?? error}`);
        route = 'vscode';
      }
    }

    if (route === 'vscode') {
      if (!codeCli) {
        log('[next-session] スキップ: VSCode CLI (code.cmd) が見つかりません (VSCODE_CLI_PATH で明示できます)');
        return 0;
      }
      const steps = planVscodeLaunch({ codeCli, cwd, prompt: flags.prompt, openFolder: flags.openFolder });
      if (flags.dryRun) {
        log(JSON.stringify({ route: 'vscode', steps, account, configDir, configDirSource }));
        return 0;
      }

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const child = spawnProcess(step.command, step.args, {
          cwd,
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
          env: launchEnv,
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

      const nextState = { ...state, enabled: state.enabled !== false, lastLaunchAt: new Date().toISOString(), lastCwd: cwd, lastRoute: route, lastPrompt: flags.prompt, lastAccount: account, lastConfigDir: configDir };
      const tmpPath = `${statePath}.tmp-${process.pid}`;
      await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
      await rename(tmpPath, statePath);
      // 拡張の URI は prompt を送信しない(入力欄に置くだけ)。「開いた=始まった」と書くと嘘の成功報告になる。
      log(`[next-session] VSCode に新しいタブを1枚開きました\n  場所  : タブバーの一番右端\n  タブ名: Claude Code（送信するまでこの名前のままです）\n  入力欄: ${flags.prompt} が入っています → Enter 1回で開始\n  cwd   : ${cwd}
  account: ${accountLog}`);
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
      log(JSON.stringify({ ...plan, account, configDir, configDirSource }));
      return 0;
    }

    let trustRegistered = false;
    if (env.ORGIAST_NO_AUTO_TRUST !== '1') {
      try {
        // 読めなかった時に {} を土台にして書き戻すと、~/.claude.json ごと(oauthAccount や
        // 他プロジェクトの設定まで)消える。**読めた時だけ**触る。
        const config = await readJson(claudeConfigPath, null);
        const usable = config && typeof config === 'object' && !Array.isArray(config);
        const trusted = usable ? applyTrust(config, cwd) : { changed: false };
        if (trusted.changed) {
          const trustTmpPath = `${claudeConfigPath}.tmp-${process.pid}`;
          await writeFile(trustTmpPath, `${JSON.stringify(trusted.config, null, 2)}\n`, 'utf8');
          await rename(trustTmpPath, claudeConfigPath);
          trustRegistered = true;
        }
      } catch { /* 信頼設定に失敗しても、次セッションの起動は止めない */ }
    }

    const child = spawnProcess(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: launchEnv,
    });
    if (typeof child.once === 'function') {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    }
    child.unref();

    const nextState = { ...state, enabled: state.enabled !== false, lastLaunchAt: new Date().toISOString(), lastCwd: cwd, lastRoute: route, lastPrompt: flags.prompt, lastAccount: account, lastConfigDir: configDir };
    const tmpPath = `${statePath}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    await rename(tmpPath, statePath);
    if (trustRegistered) log(`[next-session] フォルダ信頼を事前登録しました: ${cwd}`);
    log(`[next-session] 新しいセッションを起動しました: ${cwd} / prompt=${flags.prompt} / account=${accountLog}`);
    return 0;
  } catch (error) {
    log(`[next-session] スキップ: 起動に失敗しました (${error?.message ?? error})`);
    return 0;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await launchNextSession(process.argv.slice(2));
}
