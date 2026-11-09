#!/usr/bin/env node
// Remote Control session metadata only; no LLM/search requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { hostExitArchive } from './lib/host-exit-archive.mjs';
import { isEntry } from './is-entry.mjs';
const BASE = 'https://api.anthropic.com/v1/code/sessions';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function writeProgress(base, stage, detail, nowFn = Date.now) {
  const progressPath = path.join(base || path.join(os.homedir(), '.claude'), 'reopen-lost-sessions-progress.json');
  const data = { pid: process.pid, stage, detail, at: new Date(nowFn()).toISOString() };
  fs.writeFileSync(progressPath, JSON.stringify(data) + '\n');
}
export function parseJsonTolerant(raw) {
  if (typeof raw !== 'string') return raw;
  const noBom = raw.replace(/^\uFEFF/, '');
  try { return JSON.parse(noBom); } catch {}

  let result = '';
  let inString = false;
  let escape = false;
  const N = noBom.length;

  for (let i = 0; i < N; i++) {
    const ch = noBom[i];

    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      result += ch;
      inString = true;
      continue;
    }

    // Line comment //
    if (ch === '/' && noBom[i + 1] === '/') {
      i += 2;
      while (i < N && noBom[i] !== '\n' && noBom[i] !== '\r') {
        i++;
      }
      i--;
      continue;
    }

    // Block comment /* */
    if (ch === '/' && noBom[i + 1] === '*') {
      i += 2;
      while (i < N && !(noBom[i] === '*' && noBom[i + 1] === '/')) {
        i++;
      }
      if (i < N) {
        i += 1;
      }
      continue;
    }

    // Trailing comma before ] or }
    if (ch === ',') {
      let j = i + 1;
      while (j < N) {
        if (noBom[j] === ' ' || noBom[j] === '\t' || noBom[j] === '\n' || noBom[j] === '\r') {
          j++;
          continue;
        }
        if (noBom[j] === '/' && noBom[j + 1] === '/') {
          j += 2;
          while (j < N && noBom[j] !== '\n' && noBom[j] !== '\r') {
            j++;
          }
          continue;
        }
        if (noBom[j] === '/' && noBom[j + 1] === '*') {
          j += 2;
          while (j < N && !(noBom[j] === '*' && noBom[j + 1] === '/')) {
            j++;
          }
          if (j < N) j += 2;
          continue;
        }
        break;
      }
      if (j < N && (noBom[j] === ']' || noBom[j] === '}')) {
        continue;
      }
    }

    result += ch;
  }

  return JSON.parse(result);
}
export function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    try {
      let raw = uri.replace(/^file:\/\/\/?/, '');
      raw = decodeURIComponent(raw);
      if (/^[a-zA-Z]:/.test(raw)) {
        return path.win32.normalize(raw);
      }
      return path.normalize(raw);
    } catch {
      return null;
    }
  }
}
function normalizePath(p) {
  if (!p) return '';
  const resolved = path.resolve(p);
  return resolved.replace(/\//g, '\\').toLowerCase();
}
function isCwdInWorkspace(workspaceFilePath, cwd, fsImpl) {
  try {
    if (!fsImpl.existsSync(workspaceFilePath)) return false;
    const raw = fsImpl.readFileSync(workspaceFilePath, 'utf8');
    const parsed = parseJsonTolerant(raw);
    if (!parsed || !Array.isArray(parsed.folders)) return false;
    const workspaceDir = path.dirname(path.resolve(workspaceFilePath));
    const normCwd = normalizePath(cwd);
    for (const folder of parsed.folders) {
      let folderPath = null;
      if (typeof folder?.path === 'string') {
        folderPath = folder.path;
      } else if (typeof folder?.uri === 'string') {
        folderPath = uriToPath(folder.uri);
      }
      if (!folderPath) continue;
      const folderAbs = path.resolve(workspaceDir, folderPath);
      const normFolder = normalizePath(folderAbs);
      if (normCwd === normFolder) return true;
      const prefix = normFolder.endsWith('\\') ? normFolder : normFolder + '\\';
      if (normCwd.startsWith(prefix)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
export function findWorkspaceForCwd(cwd, { env = process.env, fsImpl = fs } = {}) {
  if (!cwd) return null;
  const candidates = [];
  if (env.ORGIAST_VSCODE_WORKSPACE && typeof env.ORGIAST_VSCODE_WORKSPACE === 'string') {
    candidates.push(env.ORGIAST_VSCODE_WORKSPACE);
  }
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const storagePath = path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json');
  if (fsImpl.existsSync(storagePath)) {
    try {
      const content = fsImpl.readFileSync(storagePath, 'utf8');
      const data = parseJsonTolerant(content);
      const uris = [];
      const lastActive = data?.windowsState?.lastActiveWindow?.workspaceIdentifier?.configURIPath;
      if (typeof lastActive === 'string') uris.push(lastActive);
      const opened = data?.windowsState?.openedWindows;
      if (Array.isArray(opened)) {
        for (const win of opened) {
          const uri = win?.workspaceIdentifier?.configURIPath;
          if (typeof uri === 'string') uris.push(uri);
        }
      }
      for (const uri of uris) {
        const p = uriToPath(uri);
        if (p && p.endsWith('.code-workspace')) {
          candidates.push(p);
        }
      }
    } catch {}
  }
  try {
    let currentDir = path.resolve(cwd);
    while (true) {
      if (fsImpl.existsSync(currentDir)) {
        try {
          const entries = fsImpl.readdirSync(currentDir);
          for (const entry of entries) {
            const name = typeof entry === 'string' ? entry : entry.name;
            if (name && name.endsWith('.code-workspace')) {
              candidates.push(path.join(currentDir, name));
            }
          }
        } catch {}
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {}
  const seenNorm = new Set();
  for (const candPath of candidates) {
    const norm = normalizePath(candPath);
    if (!norm || seenNorm.has(norm)) continue;
    seenNorm.add(norm);
    if (isCwdInWorkspace(candPath, cwd, fsImpl)) {
      const resolvedFile = path.resolve(candPath);
      const ext = path.extname(resolvedFile);
      const workspaceName = path.basename(resolvedFile, ext);
      return { workspaceFile: resolvedFile, workspaceName };
    }
  }
  return null;
}
export function hasConversation(rows, bytes = 0) {
  return bytes > 200 * 1024 || rows.some(row => {
    if (!['user', 'assistant'].includes(row.type)) return false;
    let c = row.message?.content;
    if (Array.isArray(c)) c = c.map(x => x?.text ?? '').join(' ');
    return typeof c === 'string' && !!c.trim() && (row.type === 'assistant' || !/<local-command-caveat>|<command-name>|<command-message>/.test(c));
  });
}
// git worktree 判定。フォルダ（または祖先）に `.git` ファイルがあり内容の gitdir: が
// `...worktrees/...` を含む、または正規化パスが `\.claude\worktrees\` を含む場合に worktree。
// `.git` ディレクトリ（メイン checkout）に到達したらそこで打ち切って false。
function isWorktreeFolder(cwd, fsImpl) {
  if (!cwd) return false;
  const norm = normalizePath(cwd);
  if (norm.includes('\\.claude\\worktrees\\')) return true;
  let dir = path.resolve(cwd);
  while (true) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fsImpl.statSync(gitPath);
      if (stat.isFile()) {
        const content = fsImpl.readFileSync(gitPath, 'utf8');
        if (/gitdir\s*:\s*[^\r\n]*worktrees/i.test(content)) return true;
        return false; // 通常の gitdir ファイル（サブモジュール等）は worktree ではない
      }
      if (stat.isDirectory()) return false; // メイン checkout 配下。worktree ではない
    } catch { /* この階層に .git は無い: 親へ */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}
// 再接続で開くフォルダを決める。cwd が worktree のときは、transcript の cwd 履歴のうち
// worktree でない最初の cwd → 無ければ git worktree list のメイン worktree。
// どちらも無い場合は null（開かずスキップ。新しい worktree ウィンドウは絶対に開かない）。
export function resolveReopenFolder(cwd, transcriptCwds = [], { fsImpl = fs, spawn = spawnSync } = {}) {
  if (!cwd) return null;
  if (!isWorktreeFolder(cwd, fsImpl)) return cwd;
  for (const candidate of transcriptCwds) {
    if (candidate && !isWorktreeFolder(candidate, fsImpl)) return candidate;
  }
  try {
    const list = run('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], spawn);
    const first = String(list).split('\n')[0];
    if (first.startsWith('worktree ')) return first.slice('worktree '.length).trim();
  } catch { /* git 不可: null へ */ }
  return null;
}
export function hasHostExit(events, since, until) {
  return events.some(e => e.event_type === 'system' && e.payload?.reason === 'host_exit'
    && Date.parse(e.created_at) >= Date.parse(since) && Date.parse(e.created_at) <= Date.parse(until));
}
export function exclusion(local, closed, alive) {
  if (!local || !local.cwd) return 'noLocal';
  if (closed.has(local.id)) return 'closed';
  if (!local.hasConversation) return 'empty';
  if (alive.has(local.id)) return 'alive';
  return null;
}
export function parseAgents(output) {
  const agents = JSON.parse(output);
  if (!Array.isArray(agents) || agents.some(a => !a?.kind || (a.kind === 'interactive' && !a.sessionId))) throw Error('Invalid agents inventory');
  return new Set(agents.filter(a => a.kind === 'interactive').map(a => a.sessionId));
}
function run(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.error || result.status !== 0) throw Error(`${path.basename(command)} failed: ${result.error?.message ?? result.status}`);
  return result.stdout.trim();
}
function ps(script, spawn) { return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], spawn); }
export function agentsWithRetry(cli, spawn) {
  const go = () => parseAgents(run(cli, ['agents', '--json'], spawn));
  try { return go(); }
  catch (e) { return go(); }
}
export function agentsFromRegistry(sessionsDir) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    return new Set();
  }
  const result = new Set();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, entry);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (data.kind !== 'interactive' || !data.sessionId) continue;
    if (data.pid) {
      try {
        process.kill(data.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') continue;
      }
    }
    result.add(data.sessionId);
  }
  return result;
}
export async function measureCpuAsync({ sampleMs = 1000, cpusImpl = os.cpus, wait = sleep } = {}) {
  try {
    const first = cpusImpl();
    await wait(sampleMs);
    const second = cpusImpl();
    let totalIdle1 = 0, totalAll1 = 0;
    let totalIdle2 = 0, totalAll2 = 0;
    for (const cpu of first) {
      const t = cpu.times;
      totalAll1 += t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq;
      totalIdle1 += t.idle;
    }
    for (const cpu of second) {
      const t = cpu.times;
      totalAll2 += t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq;
      totalIdle2 += t.idle;
    }
    const idleDiff = totalIdle2 - totalIdle1;
    const totalDiff = totalAll2 - totalAll1;
    return totalDiff > 0 ? Math.round(100 * (1 - idleDiff / totalDiff)) : null;
  } catch { return null; }
}
const quotePS = s => "'" + s.replaceAll("'", "''") + "'";
// VS Code の可視メインウィンドウが1つ以上開いているかを PowerShell で確認する。
// タイムアウト 15 秒。エラー・タイムアウト・数値でない出力時は安全側（ウィンドウあり＝URIのみ）として true を返す。
export function hasCodeWindow(spawn = spawnSync) {
  try {
    const script = '@(Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count';
    const res = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (res.error || res.status !== 0) return true;
    const count = parseInt(String(res.stdout ?? '').trim(), 10);
    if (!Number.isFinite(count)) return true;
    return count > 0;
  } catch { return true; }
}
// 開くべきターゲットを決める。
// - VS Code ウィンドウが1つでも開いている → { launch: 'uri-only', target: null }（code <path> を一切実行しない）
// - ウィンドウが無い → storage.json の lastActiveWindow を参照。
//   lastActiveWindow が folder ならフォルダ、workspaceIdentifier ならワークスペースを開く。
//   ワークスペースよりフォルダを優先する（指示書: lastActiveWindow が folder なのに .code-workspace を選ぶ現在の挙動をやめる）。
//   フォルダもワークスペースも決まらない場合は cwd を開く。
export function resolveLaunchTarget({ cwd, env = process.env, fsImpl = fs, spawn = spawnSync } = {}) {
  if (hasCodeWindow(spawn)) {
    return { launch: 'uri-only', target: null, openedWith: null };
  }
  // ウィンドウ無し: storage.json の lastActiveWindow を確認
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const storagePath = path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json');
  if (fsImpl.existsSync(storagePath)) {
    try {
      const content = fsImpl.readFileSync(storagePath, 'utf8');
      const data = parseJsonTolerant(content);
      const lastActive = data?.windowsState?.lastActiveWindow;
      if (lastActive) {
        // folder 優先
        if (lastActive.folder) {
          const folderPath = uriToPath(lastActive.folder);
          if (folderPath) {
            return { launch: 'opened-window', target: folderPath, openedWith: 'folder' };
          }
        }
        // workspaceIdentifier があればワークスペースファイル
        const configURI = lastActive.workspaceIdentifier?.configURIPath;
        if (configURI) {
          const wsPath = uriToPath(configURI);
          if (wsPath && wsPath.endsWith('.code-workspace')) {
            return { launch: 'opened-window', target: wsPath, openedWith: 'workspace' };
          }
        }
      }
    } catch {}
  }
  // どちらも決まらない → cwd をフォルダとして開く
  if (cwd) {
    return { launch: 'opened-window', target: cwd, openedWith: 'folder' };
  }
  return { launch: 'uri-only', target: null, openedWith: null };
}
export function resolveCodeCli(env = process.env, exists = fs.existsSync) {
  const candidates = [env.VSCODE_CLI_PATH, path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', 'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd'];
  const cli = candidates.find(x => x && exists(x));
  if (!cli) throw Error('code.cmd not found');
  return cli;
}
export function localIndex(base, onlyId, { sinceMs, largeFileThreshold = 64 * 1024 * 1024, largeFileHead = 8 * 1024 * 1024, largeFileTail = 8 * 1024 * 1024 } = {}) {
  const index = new Map();
  const projects = path.join(base, 'projects');
  let indexed = 0, skippedOld = 0;
  const startMs = Date.now();
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === '_deleted-backup') continue;
    for (const file of fs.readdirSync(path.join(projects, dir.name))) {
      if (!file.endsWith('.jsonl') || (onlyId && file !== `${onlyId}.jsonl`)) continue;
      const filePath = path.join(projects, dir.name, file);
      // mtime フィルタ: sinceMs が指定され、onlyId が無い場合、古いファイルは飛ばす
      if (!onlyId && sinceMs !== undefined) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < sinceMs) { skippedOld++; continue; }
        } catch { /* stat 不可なら読む */ }
      }
      let raw;
      const stat = fs.statSync(filePath);
      if (stat.size > largeFileThreshold) {
        // 巨大ファイル: 先頭 largeFileHead + 末尾 largeFileTail だけ読む
        const fd = fs.openSync(filePath, 'r');
        const bufHead = Buffer.alloc(largeFileHead);
        const bytesHead = fs.readSync(fd, bufHead, 0, largeFileHead, 0);
        const bufTail = Buffer.alloc(Math.min(largeFileTail, stat.size));
        const bytesTail = fs.readSync(fd, bufTail, 0, bufTail.length, Math.max(0, stat.size - bufTail.length));
        fs.closeSync(fd);
        raw = bufHead.toString('utf8', 0, bytesHead) + bufTail.toString('utf8', 0, bytesTail);
      } else {
        raw = fs.readFileSync(filePath, 'utf8');
      }
      // Most archived transcripts have no bridge. Avoid parsing gigabytes of tool output.
      if (!raw.includes('"bridge-session"')) continue;
      const lines = raw.split('\n');
      const parse = line => { try { return JSON.parse(line); } catch { return {}; } };
      const bridges = lines.filter(line => /"type"\s*:\s*"bridge-session"/.test(line)).map(parse)
        .filter(row => row.type === 'bridge-session' && row.bridgeSessionId);
      if (!bridges.length) continue;
      // cwd 履歴（大小文字無視で重複除去、出現順）。先頭が仕事の起点（worktree 移動前）。
      const cwds = [];
      const seenCwds = new Set();
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('"cwd"')) continue;
        const row = parse(lines[i]);
        if (typeof row.cwd !== 'string' || !row.cwd) continue;
        const norm = normalizePath(row.cwd);
        if (!norm || seenCwds.has(norm)) continue;
        seenCwds.add(norm);
        cwds.push(row.cwd);
      }
      const bytes = stat.size;
      const conversation = bytes > 200 * 1024 || hasConversation(lines.map(parse), bytes);
      indexed++;
      for (const bridge of bridges) {
        index.set(bridge.bridgeSessionId, { id: file.slice(0, -6), cwd: cwds[0], cwds, hasConversation: conversation });
      }
    }
  }
  const indexMs = Date.now() - startMs;
  return Object.assign(index, { indexed, skippedOld, indexMs });
}
function closedIds(base) {
  const ledger = readJson(path.join(base, 'closed-sessions.json'), { ids: [] });
  if (!Array.isArray(ledger.ids)) throw Error('Invalid closed ledger');
  return new Set(ledger.ids);
}
function reopenLoopCounts(base, nowFn = Date.now) {
  const logFile = path.join(base, 'reopen-lost-sessions.log');
  const counts = {};
  try {
    const raw = fs.readFileSync(logFile, 'utf8');
    const nowTime = typeof nowFn === 'function' ? nowFn() : nowFn;
    const cutoff = nowTime - 24 * 3600 * 1000;
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (!entry.at || !Array.isArray(entry.reopened)) continue;
        if (Date.parse(entry.at) < cutoff) continue;
        for (const r of entry.reopened) {
          const id = r?.id || r;
          if (id) counts[id] = (counts[id] || 0) + 1;
        }
      } catch {}
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return counts;
}
export function parseOptions(args, spawn = spawnSync) {
  const options = { dryRun: false, max: 30, gapSec: 10, watch: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--watch') { options.watch = true; continue; }
    const key = { '--since': 'since', '--until': 'until', '--max': 'max', '--gap-sec': 'gapSec' }[arg];
    if (!key || !args[i + 1]) throw Error(`Invalid option: ${arg}`);
    if (key === 'max') options.maxSet = true;
    options[key] = ['max', 'gapSec'].includes(key) ? Number(args[++i]) : args[++i];
  }
  if (options.watch && (options.since || options.until)) throw Error('--watch and --since/--until are mutually exclusive');
  if (!Number.isInteger(options.max) || options.max < 1 || !Number.isFinite(options.gapSec) || options.gapSec < 0) throw Error('Invalid max/gap');
  if (!options.watch) {
    if (!options.since || !options.until) {
      const boot = Date.parse(ps('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")', spawn));
      options.since ??= new Date(boot - 15 * 60000).toISOString();
      options.until ??= new Date(boot + 15 * 60000).toISOString();
    }
    if (!Number.isFinite(Date.parse(options.since)) || !Number.isFinite(Date.parse(options.until)) || Date.parse(options.since) > Date.parse(options.until)) throw Error('Invalid time range');
  }
  return options;
}
export function acquireLock(file, now = Date.now()) {
  try { if (now - fs.statSync(file).mtimeMs > 600000) fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  fs.writeSync(fd, String(process.pid));
  const timer = setInterval(() => {
    const date = new Date();
    // Primary: fd-based futimesSync for mtime tracking
    try { fs.futimesSync(fd, date, date); } catch {}
    // Fallback: path-based utimesSync for Windows compatibility
    try { fs.utimesSync(file, date, date); } catch {}
  }, 30000);
  timer.unref();
  return () => { clearInterval(timer); fs.closeSync(fd); fs.unlinkSync(file); };
}
export function resolveClaudeCli({ env = process.env, exists = fs.existsSync, readdir = fs.readdirSync, spawn = spawnSync } = {}) {
  // (a) env CLAUDE_CLI / CLAUDE_CLI_PATH / CLAUDE_BIN
  const fromEnv = env.CLAUDE_CLI || env.CLAUDE_CLI_PATH || env.CLAUDE_BIN;
  if (fromEnv && exists(fromEnv)) return fromEnv;

  const home = os.homedir();

  // (b) ~/.local/bin/claude.exe (or claude on non-win32)
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const localBin = path.join(home, '.local', 'bin', binName);
  if (exists(localBin)) return localBin;

  // (c) where.exe / which
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawn(cmd, ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status === 0) {
      const first = String(result.stdout ?? '').split('\n')[0].trim();
      if (first && exists(first)) return first;
    }
  } catch { /* not available or not found */ }

  // (d) winget Packages glob (Windows only)
  try {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pkgsDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    try {
      const entries = readdir(pkgsDir);
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (/^Anthropic\.ClaudeCode_/i.test(name)) {
          const exe = path.join(pkgsDir, name, binName);
          if (exists(exe)) return exe;
        }
      }
    } catch { /* directory not found */ }
  } catch { /* path construction error */ }

  throw new Error('claude CLI not found');
}

export async function reopenLost({ since, until, dryRun = false, max = 30, gapSec = 10,
  base = path.join(os.homedir(), '.claude'), fetchImpl = fetch, spawn = spawnSync, wait = sleep,
  now = Date.now, windowReady, claudeCli, codeCli, env = process.env, fsImpl = fs, stateBased = false,
  checkCpu = true, cpusImpl } = {}) {
  const result = { at: new Date(now()).toISOString(), since, until, candidates: [], reopened: [], skipped: { closed: 0, empty: 0, alive: 0, noLocal: 0, archivedByUser: 0, reopenLoop: 0, worktree: 0 }, aliveSource: null, agentsError: null, agentsDiag: null };
  // Dry run is strictly read-only: no lock or log mutation on the user's PC.
  const release = dryRun ? () => {} : acquireLock(path.join(base, 'reopen-lost-sessions.lock'));
  if (!release) return { ...result, error: 'locked' };
  writeProgress(base, 'lock', 'acquired');
  try {
    const token = readJson(path.join(base, '.credentials.json')).claudeAiOauth?.accessToken;
    const org = readJson(path.join(base, '..', '.claude.json')).oauthAccount?.organizationUuid;
    if (!token || !org) throw Error('Missing RC credentials');
    writeProgress(base, 'auth', 'credentials loaded');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org };
    const cli = claudeCli || resolveClaudeCli({ env, exists: fsImpl.existsSync, readdir: fsImpl.readdirSync, spawn });
    const alive = () => {
      // Stage 1: claude agents --json with 30s timeout, no retry
      try {
        const start = Date.now();
        const res = spawn(cli, ['agents', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
        const elapsed = Date.now() - start;
        if (res.error || res.status !== 0) {
          const msg = res.error?.message ?? `exit code ${res.status}`;
          result.aliveSource = 'registry';
          result.agentsError = msg;
          result.agentsDiag = {
            elapsedMs: elapsed,
            stderr: (res.stderr || '').slice(0, 300) || null,
            signal: res.signal || null,
            cwd: process.cwd(),
            claudeEnvKeys: Object.keys(process.env).filter(k => k.includes('CLAUDE')),
          };
          return agentsFromRegistry(path.join(base, 'sessions'));
        }
        result.aliveSource = 'agents';
        result.agentsError = null;
        result.agentsDiag = null;
        return parseAgents(res.stdout.trim());
      } catch (e) {
        result.aliveSource = 'registry';
        result.agentsError = e.message;
        result.agentsDiag = {
          elapsedMs: null,
          stderr: null,
          signal: null,
          cwd: process.cwd(),
          claudeEnvKeys: Object.keys(process.env).filter(k => k.includes('CLAUDE')),
        };
        throw e;
      }
    };
    const living = alive();
    writeProgress(base, 'alive', `source=${result.aliveSource}, count=${living.size}`);
    const indexSinceMs = stateBased
      ? now() - 72 * 3600 * 1000
      : Date.parse(since) - 24 * 3600 * 1000;
    const locals = localIndex(base, undefined, { sinceMs: Number.isFinite(indexSinceMs) ? indexSinceMs : now() - 72 * 3600 * 1000 });
    const closed = closedIds(base);
    writeProgress(base, 'index', `local=${locals.size}, closed=${closed.size}, skippedOld=${locals.skippedOld}, indexMs=${locals.indexMs}`);
    result.indexed = locals.indexed;
    result.indexSkippedOld = locals.skippedOld;
    result.indexMs = locals.indexMs;
    const reopenCounts = reopenLoopCounts(base, now);
    const deadline = now() + (stateBased ? 180000 : 60000);
    const get = async url => {
      if (now() >= deadline) throw Error('API time limit');
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.max(1, deadline - now())) });
      if (!response.ok) throw Error(`RC API HTTP ${response.status}`);
      return response.json();
    };
    let cursor = '';
    const seen = new Set(), seenIds = new Set();
    try {
      do {
        const body = await get(`${BASE}?${new URLSearchParams({ limit: '100', ...(cursor && { cursor }) })}`);
        if (!Array.isArray(body.data)) throw Error('Invalid sessions response');
        const sessions = stateBased ? body.data : body.data.filter(session => !Number.isFinite(Date.parse(session.updated_at)) || Date.parse(session.updated_at) >= Date.parse(since));

        // 状態ベースの候補（--watch 専用、events API 不要）
        if (stateBased) {
          const nowTime = now();
          const stateSince = new Date(nowTime - 72 * 3600 * 1000).toISOString();
          for (const session of sessions) {
            const local = locals.get(session.id);
            if (!local || seenIds.has(local.id)) continue;
            if (session.status !== 'active') continue;
            if (session.connection_status === 'connected') continue;
            const lastEvent = Date.parse(session.last_event_at);
            if (!Number.isFinite(lastEvent) || lastEvent < Date.parse(stateSince)) continue;
            const reason = exclusion(local, closed, living);
            if (reason) { result.skipped[reason]++; continue; }
            if (reopenCounts[local.id] >= 3) { result.skipped.reopenLoop++; continue; }
            seenIds.add(local.id);
            result.candidates.push({ id: local.id, cwd: local.cwd, cwds: local.cwds ?? [], title: session.title ?? '', source: 'state' });
          }
          // 降順の場合: 全セッションの last_event_at/updated_at が 72h より古ければそれ以上ページングしない
          const cutoff = Date.parse(stateSince);
          if (sessions.length > 0 && sessions.every(s => {
            const le = Date.parse(s.last_event_at);
            if (Number.isFinite(le) && le >= cutoff) return false;
            const ua = Date.parse(s.updated_at);
            return !Number.isFinite(ua) || ua < cutoff;
          })) {
            cursor = '';
          }
        }

        for (let offset = 0; offset < sessions.length; offset += 6) {
          const batch = await Promise.allSettled(sessions.slice(offset, offset + 6).map(async session => {
            const events = await get(`${BASE}/${encodeURIComponent(session.id)}/events?limit=20`);
            if (!Array.isArray(events.data)) throw Error('Invalid events response');
            return { session, events: events.data };
          }));
          for (const item of batch) {
            if (item.status !== 'fulfilled') continue;
            const { session, events } = item.value;
            if (!hasHostExit(events, since, until)) continue;
            const local = locals.get(session.id);
            const reason = exclusion(local, closed, living);
            if (reason) { result.skipped[reason]++; continue; }
            // Skip user-archived sessions (closed via mobile etc.)
            if (session.status === 'archived' && !hostExitArchive(events)) { result.skipped.archivedByUser++; continue; }
            // Skip sessions reopened 3+ times in the last 24h (infinite reopen guard)
            if (reopenCounts[local?.id] >= 3) { result.skipped.reopenLoop++; continue; }
            if (!local || seenIds.has(local.id)) continue;
            seenIds.add(local.id);
            result.candidates.push({ id: local.id, cwd: local.cwd, cwds: local.cwds ?? [], title: session.title ?? '', source: 'host_exit' });
          }
          const failed = batch.find(item => item.status === 'rejected');
          if (failed) throw failed.reason;
        }
        cursor = body.next_cursor || '';
        if (cursor && seen.has(cursor)) throw Error('Repeated API cursor');
        seen.add(cursor);
      } while (cursor);
    } catch (error) { result.apiError = error.message; }
    if (!dryRun && result.candidates.length) {
      writeProgress(base, 'fetch', `candidates=${result.candidates.length}`);
      // CPU 保護: 85% 以上なら開き直しを全部見送る
      const cpuLoad = checkCpu ? await measureCpuAsync({ cpusImpl }) : null;
      if (cpuLoad !== null && cpuLoad >= 85) {
        result.deferredCpu = cpuLoad;
      } else {
        const code = codeCli || resolveCodeCli(env, fsImpl.existsSync);
        let windowOpened = false; // 1回の実行で新規ウィンドウを作るのは最大1回まで
        for (const candidate of result.candidates.slice(0, max)) {
          writeProgress(base, 'open', `id=${candidate.id}`);
          // Recheck after fetching and between opens: close/purge may have happened meanwhile.
          const refreshed = [...localIndex(base, candidate.id).values()].find(l => l.id === candidate.id);
          const reason = exclusion(refreshed, closedIds(base), alive());
          if (reason) { result.skipped[reason]++; continue; }
          try {
            const folder = resolveReopenFolder(candidate.cwd, candidate.cwds, { fsImpl, spawn });
            // worktree のまま開く候補が無いときは開かずスキップ（新しい worktree ウィンドウは作らない）。
            if (!folder) { result.skipped.worktree++; continue; }
            // 開くべきターゲットを決定（ウィンドウ有無・storage.json の lastActiveWindow を考慮）
            const launchInfo = resolveLaunchTarget({ cwd: folder, env, fsImpl, spawn });
            let launch = launchInfo.launch;
            let targetPath = launchInfo.target;
            let openedWith = launchInfo.openedWith;
            // 既にウィンドウを開いた後は、以降の候補は URI のみ
            if (windowOpened && launch === 'opened-window') {
              launch = 'uri-only';
              targetPath = null;
              openedWith = null;
            }
            if (launch === 'opened-window') {
              // ウィンドウを開く
              windowOpened = true;
              const titlePattern = openedWith === 'workspace' ? path.basename(targetPath, '.code-workspace') : path.win32.basename(targetPath);
              ps(`& ${quotePS(code)} ${quotePS(targetPath)}; exit $LASTEXITCODE`, spawn);
              const ready = windowReady || (() => ps(`$w = @(Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.Contains(${quotePS(titlePattern)}) }); if ($w.Count) { 'ready' }`, spawn) === 'ready');
              let found = false;
              for (let elapsed = 0; elapsed <= 60; elapsed++) {
                if (await ready(candidate.cwd, targetPath, titlePattern)) { found = true; break; }
                if (elapsed < 60) await wait(1000);
              }
              if (!found) throw Error('VS Code window timeout');
              const current = [...localIndex(base, candidate.id).values()].find(l => l.id === candidate.id);
              const lateReason = exclusion(current, closedIds(base), alive());
              if (lateReason) { result.skipped[lateReason]++; continue; }
              // Focus again immediately before URI dispatch to reduce focus races.
              ps(`& ${quotePS(code)} ${quotePS(targetPath)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ${quotePS(code)} --open-url ${quotePS('vscode://anthropic.claude-code/open?session=' + encodeURIComponent(candidate.id))}; exit $LASTEXITCODE`, spawn);
            } else {
              // URI のみ: code --open-url だけを撃つ（既存ウィンドウで開く）
              ps(`& ${quotePS(code)} --open-url ${quotePS('vscode://anthropic.claude-code/open?session=' + encodeURIComponent(candidate.id))}; exit $LASTEXITCODE`, spawn);
            }
            result.reopened.push({ ...candidate, openedWith, folder, target: targetPath, launch });
          } catch (error) { (result.failed ??= []).push({ ...candidate, error: error.message }); }
          await wait(gapSec * 1000);
        }
        // Post-reopen verification: wait 90s then check which sessions are actually connected
        if (result.reopened.length) {
          writeProgress(base, 'verify', `waiting 90s for ${result.reopened.length} reopened`);
          await wait(90000);
          try {
            const agents = alive();
            result.verified = [];
            result.unverified = [];
            for (const r of result.reopened) {
              if (agents.has(r.id)) result.verified.push(r.id);
              else result.unverified.push(r.id);
            }
          } catch (e) { result.verifyError = e.message; }
        }
      }
    }
  } catch (error) { result.error = error.message; }
  finally {
    try { if (!dryRun) fs.appendFileSync(path.join(base, 'reopen-lost-sessions.log'), JSON.stringify(result) + '\n'); }
    finally { writeProgress(base, 'done', 'log written'); release(); }
  }
  return result;
}
export async function watchReopen(opts = {}, maxParam) {
  let base, max, dryRun, fetchImpl, spawn, wait, nowFn, claudeCli, codeCli, env, fsImpl, windowReady, cpusImpl;
  if (typeof opts === 'string' || opts === undefined) {
    base = opts ?? path.join(os.homedir(), '.claude');
    max = maxParam ?? 10;
    dryRun = false;
    nowFn = Date.now;
  } else {
    base = opts.base ?? path.join(os.homedir(), '.claude');
    max = opts.max ?? 10;
    dryRun = opts.dryRun ?? false;
    fetchImpl = opts.fetchImpl;
    spawn = opts.spawn;
    wait = opts.wait;
    nowFn = opts.now ?? Date.now;
    claudeCli = opts.claudeCli;
    codeCli = opts.codeCli;
    env = opts.env;
    fsImpl = opts.fsImpl;
    windowReady = opts.windowReady;
    cpusImpl = opts.cpusImpl;
  }
  const stateFile = path.join(base, 'reopen-lost-sessions-state.json');
  const state = readJson(stateFile, {});
  const nowTime = nowFn();
  const minSince = new Date(nowTime - 24 * 3600 * 1000).toISOString();
  const defaultSince = new Date(nowTime - 30 * 60000).toISOString();
  let since;
  const wmTime = state.watermark ? Date.parse(state.watermark) : NaN;
  if (Number.isFinite(wmTime)) {
    since = wmTime < Date.parse(minSince) ? minSince : state.watermark;
  } else {
    since = defaultSince;
  }
  const until = new Date(nowTime - 60000).toISOString();
  const result = await reopenLost({
    since, until, max, dryRun, base, fetchImpl, spawn, wait, now: nowFn, claudeCli, codeCli, env, fsImpl, windowReady, cpusImpl,
    stateBased: true
  });
  if (!result.error && !result.apiError && !result.deferredCpu && !dryRun) {
    fs.writeFileSync(stateFile, JSON.stringify({ watermark: until }) + '\n');
  }
  return result;
}
export function watchdogRecord(base, { exitImpl = process.exit } = {}) {
  const logPath = path.join(base, 'reopen-lost-sessions.log');
  try {
    const progress = readJson(path.join(base, 'reopen-lost-sessions-progress.json'), {});
    fs.appendFileSync(logPath, JSON.stringify({
      at: new Date().toISOString(),
      error: 'watchdog timeout',
      stage: progress.stage,
      detail: progress.detail,
      pid: progress.pid,
    }) + '\n');
  } catch {}
  writeProgress(base, 'watchdog', 'timeout');
  try { fs.unlinkSync(path.join(base, 'reopen-lost-sessions.lock')); } catch {}
  if (typeof exitImpl === 'function') {
    exitImpl(2);
  }
}
if (isEntry(import.meta.url)) {
  try {
    const opts = parseOptions(process.argv.slice(2));
    if (opts.watch) {
      const base = opts.base || path.join(os.homedir(), '.claude');
      let watchdogTimer = setTimeout(() => {
        watchdogRecord(base);
      }, 20 * 60 * 1000);
      const result = await watchReopen({
        base: opts.base,
        max: opts.maxSet ? opts.max : 10,
        dryRun: opts.dryRun,
      });
      clearTimeout(watchdogTimer);
      console.log(JSON.stringify(result));
      if (result.error || result.apiError || result.failed?.length || result.unverified?.length) process.exitCode = 1;
    } else {
      const result = await reopenLost(opts);
      console.log(JSON.stringify(result));
      if (result.error || result.apiError || result.failed?.length || result.unverified?.length) process.exitCode = 1;
    }
  } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
