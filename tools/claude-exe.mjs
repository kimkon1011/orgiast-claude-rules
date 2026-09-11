// Windowsでclaude.batをshellなしでspawnできない問題を解決するためにexeの絶対パスを解決する
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

export function candidateClaudeExecutables({ platform, home, localAppData, pathEntries = [], listDir, exists }) {
  const bin = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [];

  const addUnique = (p) => {
    if (p && exists(p) && !candidates.includes(p)) {
      candidates.push(p);
    }
  };

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

  if (platform === 'win32' && localAppData) {
  const packagesDir = path.join(localAppData, 'Packages');
  const pkgs = listDir(packagesDir).filter((pkg) => /^Claude_/i.test(pkg));
  let pickedWindows = null;
  let pickedVersion = null;
  for (const pkg of pkgs) {
    const codeDir = path.join(packagesDir, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code');
    const highest = pickHighestVersion(listDir(codeDir));
    if (!highest) continue;
    const version = versionTuple(highest);
    if (!pickedVersion || compareVersionTuples(version, pickedVersion) > 0) {
      pickedVersion = version;
      pickedWindows = path.join(codeDir, highest, 'claude.exe');
    }
  }
  if (pickedWindows) {
    addUnique(pickedWindows);
  }
  }

  if (home) addUnique(path.join(home, '.local', 'bin', bin));

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
  return {
    platform,
    home: env.USERPROFILE || env.HOME,
    localAppData: env.LOCALAPPDATA,
    pathEntries: (env.PATH || env.Path || '')
      .split(platform === 'win32' ? ';' : ':')
      .filter((e) => e !== ''),
    env,
  };
}

// 実ディスクを引く既定の解決器。純関数側(上)は fs を注入させるのでここだけが node:fs を使う。
// spawn は shell を通さない(巨大プロンプトを argv で渡すため)。よって .bat/.cmd は候補にしない。
export async function resolveClaudeExecutableFromDisk(processLike = process) {
  const fs = await import('node:fs');
  const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const args = { ...defaultResolveArgs(processLike), listDir, exists };
  return { executable: resolveClaudeExecutable(args), candidates: candidateClaudeExecutables(args) };
}
