// Windowsでclaude.batをshellなしでspawnできない問題を解決するためにexeの絶対パスを解決する
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function versionTuple(text) {
  const match = text.match(/\d+(\.\d+)*/);
  return match ? match[0].split('.').map(Number) : null;
}

export function compareVersionTuples(a, b) {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pickHighestVersion(paths) {
  let best = null;
  let bestVersion = null;
  for (const p of paths) {
    const v = versionTuple(p);
    if (!v) continue;
    if (best === null || compareVersionTuples(v, bestVersion) > 0) {
      best = p;
      bestVersion = v;
    } else if (compareVersionTuples(v, bestVersion) === 0 && p > best) {
      best = p;
    }
  }
  return best;
}

export function isUnspawnable(filePath, platform) {
  if (platform !== 'win32') return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.bat') || lower.endsWith('.cmd') || lower.endsWith('.ps1');
}

// <codeDir>/<版>/claude.exe または <codeDir>/<版>/<任意ハッシュサブディレクトリ>/claude.exe を探索し、
// 最も新しい版の exe を返す。最新版に exe が無ければ次に新しい版へフォールバックする。
export function findClaudeInVersionedDir(codeDir, { listDir, exists }) {
  const versionDirs = listDir(codeDir).filter((name) => versionTuple(name) !== null);
  versionDirs.sort((a, b) => {
    const diff = compareVersionTuples(versionTuple(b), versionTuple(a));
    if (diff !== 0) return diff;
    return b > a ? 1 : b < a ? -1 : 0;
  });

  for (const vDir of versionDirs) {
    const directExe = path.join(codeDir, vDir, 'claude.exe');
    if (exists(directExe)) return directExe;
    const subdirs = listDir(path.join(codeDir, vDir));
    for (const sub of subdirs) {
      const subExe = path.join(codeDir, vDir, sub, 'claude.exe');
      if (exists(subExe)) return subExe;
    }
  }
  return null;
}

export function candidateClaudeExecutables({ platform, home, localAppData, appData, pathEntries = [], listDir, exists }) {
  const bin = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [];

  const addUnique = (p) => {
    if (p && exists(p) && !candidates.includes(p)) {
      candidates.push(p);
    }
  };

  // 1. vscode 拡張
  if (home) {
    const vscodeExtDir = path.join(home, '.vscode', 'extensions');
    const extNames = listDir(vscodeExtDir);
    const matchingExts = extNames.filter((name) => /^anthropic\.claude-code-/i.test(name));
    if (matchingExts.length > 0) {
      const pickedExt = pickHighestVersion(matchingExts);
      if (pickedExt) {
        addUnique(path.join(vscodeExtDir, pickedExt, 'resources', 'native-binary', bin));
      }
    }
  }

  // 2. Packages\Claude_*
  if (platform === 'win32' && localAppData) {
    const packagesDir = path.join(localAppData, 'Packages');
    const pkgs = listDir(packagesDir).filter((pkg) => /^Claude_/i.test(pkg));
    let pickedWindows = null;
    let pickedVersion = null;
    for (const pkg of pkgs) {
      const codeDir = path.join(packagesDir, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code');
      const candidate = findClaudeInVersionedDir(codeDir, { listDir, exists });
      if (!candidate) continue;
      const rel = path.relative(codeDir, candidate);
      const vSegment = rel.split(/[\\/]/)[0];
      const version = versionTuple(vSegment);
      if (!pickedVersion || (version && compareVersionTuples(version, pickedVersion) > 0)) {
        pickedVersion = version;
        pickedWindows = candidate;
      }
    }
    if (pickedWindows) {
      addUnique(pickedWindows);
    }
  }

  // 3. APPDATA\Claude\claude-code（新規: デスクトップ版の通常インストール先）
  if (platform === 'win32' && appData) {
    const codeDir = path.join(appData, 'Claude', 'claude-code');
    const pickedAppData = findClaudeInVersionedDir(codeDir, { listDir, exists });
    if (pickedAppData) {
      addUnique(pickedAppData);
    }
  }

  // 4. ~/.local/bin
  if (home) addUnique(path.join(home, '.local', 'bin', bin));

  // 5. PATH
  for (const entry of pathEntries) {
    const fullPath = path.join(entry, bin);
    if (!isUnspawnable(fullPath, platform)) {
      addUnique(fullPath);
    }
  }

  return candidates;
}

export function resolveClaudeExecutable(options = {}) {
  const { env = {} } = options;
  if (env.CLAUDE_CLI) return env.CLAUDE_CLI;
  if (env.CLAUDE_CLI_PATH) return env.CLAUDE_CLI_PATH;
  const candidates = candidateClaudeExecutables(options);
  return candidates.length > 0 ? candidates[0] : 'claude';
}

export function defaultResolveArgs(processLike) {
  const env = processLike.env;
  const platform = processLike.platform;
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);
  return {
    platform,
    home: env.USERPROFILE || env.HOME,
    localAppData: env.LOCALAPPDATA,
    appData,
    pathEntries: (env.PATH || env.Path || '')
      .split(platform === 'win32' ? ';' : ':')
      .filter((e) => e !== ''),
    env,
  };
}

// 実ディスクを引く既定の解決器。純関数側(上)は fs を注入させるのでここだけが node:fs を使う。
// spawn は shell を通さない(巨大プロンプトを argv で渡すため)。よって .bat/.cmd は候補にしない。
export async function resolveClaudeExecutableFromDisk(processLike = process) {
  const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const args = { ...defaultResolveArgs(processLike), listDir, exists };
  return { executable: resolveClaudeExecutable(args), candidates: candidateClaudeExecutables(args) };
}

// B. 子プロセス env の浄化
export function isRetainedClaudeEnvKey(key) {
  const upper = String(key || '').toUpperCase();
  return upper === 'CLAUDE_CODE_GIT_BASH_PATH' ||
         upper === 'CLAUDE_CLI' ||
         upper === 'CLAUDE_CLI_PATH' ||
         upper === 'CLAUDE_BIN';
}

export function shouldStripClaudeChildEnvKey(key) {
  if (isRetainedClaudeEnvKey(key)) return false;
  const upper = String(key || '').toUpperCase();
  if (upper === 'CLAUDECODE') return true;
  if (upper.startsWith('CLAUDE_CODE_')) return true;
  if (upper.startsWith('CLAUDE_AGENT_SDK_')) return true;
  if (upper === 'CLAUDE_PID') return true;
  if (upper.startsWith('CLAUDE_PREVIEW_')) return true;
  if (upper.startsWith('MCP_')) return true;
  if (upper.startsWith('ANTHROPIC_')) return true;
  if (upper === 'CLAUDE_CONFIG_DIR') return true;
  return false;
}

export function sanitizeClaudeChildEnv(parentEnv = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (!shouldStripClaudeChildEnvKey(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

export function listStrippedClaudeChildEnvKeys(parentEnv = process.env) {
  return Object.keys(parentEnv || {}).filter(shouldStripClaudeChildEnvKey);
}

// 監督セッションそのものを起動する箇所(auto-session / autopilot / fleet-agent など)用。
// デスクトップや別セッション固有の漏れ(CLAUDECODE / CLAUDE_CODE_* / CLAUDE_AGENT_SDK_* /
// CLAUDE_PID / CLAUDE_PREVIEW_* / MCP_*)だけを外し、そのプロセスが意図的に設定している
// ANTHROPIC_* と CLAUDE_CONFIG_DIR(アカウント切替で意図的に設定される)は残す。
// 全社 hook を効かせたい監督には config dir を変えない。
export function sanitizeClaudeSupervisorEnv(parentEnv = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    const upper = String(key || '').toUpperCase();
    const intentional = upper.startsWith('ANTHROPIC_') || upper === 'CLAUDE_CONFIG_DIR';
    if (intentional || !shouldStripClaudeChildEnvKey(key)) clean[key] = value;
  }
  return clean;
}

// C. 専用 CLAUDE_CONFIG_DIR 方式
// 子を止めるのは lane-guard だけではない（bash-delegation, delegation-warn, claude-impl-approval,
// Stop の各ゲート, SessionStart の setup --converge による全体設定の書き換え等）。
// lane-guard だけ例外にしても他ゲートで同じ型が再発し、ゲート側に「env 変数で素通り」の穴を増やすことになる。
// 委譲先は監督ではなく実行役なので監督向けゲートは原理的に対象外。
// 専用設定ディレクトリなら全社 hook と監督向け CLAUDE.md を一括で外せ、監督側の gate には一切穴を開けない。
export function prepareWorkerConfigDir({ home = process.env.ORGIAST_HOME || os.homedir(), userSettingsPath } = {}) {
  const workerDir = path.join(home, '.claude', 'cheap-code-worker');
  const settingsFile = path.join(workerDir, 'settings.json');
  const userSettings = userSettingsPath || path.join(home, '.claude', 'settings.json');
  let deny = [];
  try {
    const raw = fs.readFileSync(userSettings, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.permissions?.deny)) {
      deny = [...parsed.permissions.deny];
    }
  } catch {}

  const config = {
    permissions: {
      defaultMode: 'bypassPermissions',
      deny,
    },
    disableAllHooks: true,
  };

  fs.mkdirSync(workerDir, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return workerDir;
}
