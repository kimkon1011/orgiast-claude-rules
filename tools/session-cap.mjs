#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { sessionApproved } from './purge-sessions.mjs';
import { isEntry } from './is-entry.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const ids = value => new Set(JSON.stringify(value ?? null).match(UUID)?.map(s => s.toLowerCase()) ?? []);
const content = row => typeof row.message?.content === 'string' ? row.message.content : (row.message?.content ?? []).filter(x => x.type === 'text').map(x => x.text ?? '').join('\n');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
function vscodeDir(home) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'Code/User');
  return process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Code/User') : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code/User');
}

// Only disposable copies are opened by SQLite, including WAL/SHM when present.
export function readState(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cap-state-'));
  let db;
  try {
    const copy = path.join(tmp, 'state.vscdb');
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.copyFileSync(file + suffix, copy + suffix, fs.constants.COPYFILE_EXCL); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    db = new DatabaseSync(copy, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('Anthropic.claude-code');
    if (!row) throw new Error('extension state missing');
    const value = JSON.parse(row.value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid extension state');
    return value;
  } finally { db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

// VS Code workspace files allow comments and trailing commas. Strip only outside strings.
function workspaceJson(text) {
  let clean = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { clean += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; }
    else if (c === '"') { inString = true; clean += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; clean += ' '; }
    else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    else clean += c;
  }
  return JSON.parse(clean.replace(/^\uFEFF/, ''));
}
export function scopeRoots(userDir, home) {
  const storage = readJson(path.join(userDir, 'globalStorage/storage.json'));
  const windows = [storage.windowsState?.lastActiveWindow, ...(storage.windowsState?.openedWindows ?? [])].filter(Boolean);
  const roots = windows.map(window => {
    if (window.folder) return fileURLToPath(window.folder);
    if (window.workspaceIdentifier?.configURIPath) {
      const file = fileURLToPath(window.workspaceIdentifier.configURIPath);
      const first = workspaceJson(fs.readFileSync(file, 'utf8')).folders?.[0];
      if (first?.uri) return fileURLToPath(first.uri);
      if (first?.path) return path.resolve(path.dirname(file), first.path);
    }
    return home;
  });
  return [...new Set(roots.length ? roots : [home])];
}
function projectDirs(base, roots) {
  const available = entries(path.join(base, 'projects')).filter(e => e.isDirectory());
  return [...new Set(roots.flatMap(root => {
    const encoded = root.replace(/[^a-zA-Z0-9]/g, '-');
    return available.filter(e => e.name.toLowerCase() === encoded.toLowerCase()).map(e => path.join(base, 'projects', e.name));
  }))];
}
function liveIds(base, now) {
  const live = new Set();
  for (const e of entries(path.join(base, 'current-sessions'))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const row = readJson(path.join(base, 'current-sessions', e.name));
    if (now - Date.parse(row.at) <= 10 * MINUTE) live.add(row.sessionId ?? row.id ?? e.name.slice(0, -5));
  }
  return live;
}
function processCommands(file) {
  if (file) {
    const rows = readJson(file);
    return (Array.isArray(rows) ? rows : [rows]).filter(row => typeof row === 'string' || !row.Name || /^(claude|node)(\.exe)?$/i.test(row.Name)).map(row => typeof row === 'string' ? row : row.CommandLine ?? row.args ?? '').join('\n');
  }
  if (process.platform !== 'win32') return run('ps', ['-eo', 'pid,args']).split('\n').filter(line => /(?:^|[\s/])(claude|node)(?:\s|$)/i.test(line)).join('\n');
  return run('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|node)(\\.exe)?$' } | Select-Object ProcessId,CommandLine | ConvertTo-Json"]);
}
export async function inspectSession(file) {
  const stat = fs.statSync(file);
  const data = { id: path.basename(file, '.jsonl'), file, projectId: path.basename(path.dirname(file)), title: '', entrypoint: '', cwd: '', userTurns: 0, firstUser: '', lastUser: '', lastAssistant: '', lastMessage: '', lastTimestamp: 0, mtime: stat.mtimeMs, size: stat.size, edited: [], committed: false };
  let customTitle = '', aiTitle = '', summary = '';
  const asks = new Set(), answered = new Set();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'custom-title' && row.customTitle) customTitle = row.customTitle;
      if (row.type === 'ai-title') aiTitle = row.aiTitle ?? row.title ?? aiTitle;
      if (row.type === 'summary') summary = row.summary ?? summary;
      if (row.entrypoint) data.entrypoint = row.entrypoint;
      if (row.cwd) data.cwd = row.cwd;
      const stamp = Date.parse(row.timestamp);
      if (Number.isFinite(stamp)) data.lastTimestamp = Math.max(data.lastTimestamp, stamp);
      const text = content(row).trim();
      const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
      if (row.isMeta || row.isSidechain) continue;
      if (row.type === 'user' && text && !text.startsWith('<') && !blocks.some(b => b.type === 'tool_result')) {
        data.userTurns++; data.firstUser ||= text; data.lastUser = text; data.lastMessage = 'user';
      }
      if (row.type === 'assistant' && (text || blocks.some(b => b.type === 'tool_use'))) {
        data.lastMessage = 'assistant'; if (text) data.lastAssistant = text;
      }
      for (const block of blocks) {
        if (block.type === 'tool_result') answered.add(block.tool_use_id);
        if (block.type !== 'tool_use') continue;
        if (block.name === 'AskUserQuestion') asks.add(block.id);
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(block.name)) {
          const edited = block.input?.file_path ?? block.input?.notebook_path;
          if (edited) data.edited.push(path.resolve(row.cwd || data.cwd || path.dirname(file), edited));
        }
        if (block.name === 'Bash' && /\bgit\s+(?:[^\n;&|]*\s)?commit\b/.test(block.input?.command ?? '')) data.committed = true;
      }
    }
  } finally { lines.close(); input.destroy(); }
  data.title = customTitle || aiTitle || summary || data.firstUser.slice(0, 80);
  data.edited = [...new Set(data.edited)];
  data.unanswered = [...asks].some(id => !answered.has(id));
  data.updated = Math.max(data.mtime, data.lastTimestamp);
  return data;
}
function pendingReasons(data, now) {
  const text = data.lastAssistant, reasons = [];
  if (/【kim 確認用の全文】|判断してほしい|してよいですか|承認待ち|返事待ち|[？?]\s*$/.test(text)) reasons.push('pending-text');
  const next = [...text.matchAll(/次に kim がすること\s*[:：]\s*([^\n]*)/g)].at(-1);
  if (next && !/^なし(?:[。\s]|$)/.test(next[1].trim())) reasons.push('pending-kim');
  const session = [...text.matchAll(/このセッション\s*[:：]\s*([^\n]*)/g)].at(-1);
  if (session && !sessionApproved(`このセッション: ${session[1].trim()}`) && !/^(?:閉じてよい|閉じて可)(?:[。\s]|$)/.test(session[1].trim())) reasons.push('pending-session');
  if (data.lastMessage === 'user') reasons.push('pending-user');
  if (data.unanswered) reasons.push('pending-question');
  const deadline = data.title.match(/^【(\d{2})\/(\d{2})\/(\d{2}):(\d{2})まで】/);
  if (deadline) {
    const date = new Date(now);
    const year = date.getFullYear();
    const due = new Date(year, +deadline[1] - 1, +deadline[2], +deadline[3], +deadline[4]);
    // December sessions can carry a January deadline.
    if (due.getMonth() === 0 && date.getMonth() === 11) due.setFullYear(year + 1);
    if (due > date) reasons.push('pending-deadline');
  }
  return reasons;
}
function gitInspector() {
  const directories = new Map(), repositories = new Map();
  function repoFor(dir) {
    const visited = [];
    let current = path.resolve(dir), found;
    while (!found) {
      if (directories.has(current)) { found = directories.get(current); break; }
      visited.push(current);
      try {
        // Locate the nearest .git before reusing a parent result: nested repos and
        // worktree .git files must not inherit their outer repository's status.
        fs.lstatSync(path.join(current, '.git'));
        try { found = { repo: run('git', ['-C', current, 'rev-parse', '--show-toplevel']).trim() }; }
        catch { found = { error: true }; }
      } catch (e) {
        if (e.code !== 'ENOENT') { found = { error: true }; break; }
        const parent = path.dirname(current);
        if (parent === current) { found = { error: false }; break; }
        current = parent;
      }
    }
    for (const visitedDir of visited) directories.set(visitedDir, found);
    return found;
  }
  function inspect(repo) {
    if (!repositories.has(repo)) {
      const state = { dirty: new Set(), unknown: false, unpushed: 0, upstreamUnknown: false };
      try {
        const rows = run('git', ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]; if (!row) continue;
          state.dirty.add(path.resolve(repo, row.slice(3)));
          if (/R|C/.test(row.slice(0, 2)) && rows[i + 1]) state.dirty.add(path.resolve(repo, rows[++i]));
        }
      } catch { state.unknown = true; }
      try { state.unpushed = Number(run('git', ['-C', repo, 'rev-list', '--count', '@{u}..HEAD']).trim()); }
      catch { state.upstreamUnknown = true; }
      repositories.set(repo, state);
    }
    return repositories.get(repo);
  }
  return data => {
    const reasons = new Set(), repos = new Set();
    for (const dir of new Set([data.cwd, ...data.edited.map(file => path.dirname(file))].filter(Boolean))) {
      const found = repoFor(dir);
      if (found.error && data.edited.length) reasons.add('git-unknown');
      if (found.repo) repos.add(found.repo);
    }
    const normalize = file => process.platform === 'win32' ? file.toLowerCase() : file;
    for (const repo of repos) {
      const state = inspect(repo), dirty = new Set([...state.dirty].map(normalize));
      if (data.edited.some(file => dirty.has(normalize(file)))) reasons.add('git-dirty');
      if (data.committed && state.unpushed > 0) reasons.add('git-unpushed');
      if ((state.unknown || state.upstreamUnknown) && data.edited.length) reasons.add('git-unknown');
      if (data.committed && state.upstreamUnknown) reasons.add('git-unknown');
    }
    return [...reasons];
  };
}
function acquire(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { fs.closeSync(fd); }
      return () => fs.unlinkSync(file);
    } catch (e) {
      if (!['EEXIST', 'EPERM'].includes(e.code)) throw e;
      const before = fs.statSync(file);
      let pid; try { pid = readJson(file).pid; } catch { return null; }
      if (!Number.isInteger(pid) || pid < 1) return null;
      try { process.kill(pid, 0); return null; } catch (error) { if (error.code !== 'ESRCH') return null; }
      const after = fs.statSync(file);
      if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) return null;
      fs.unlinkSync(file);
    }
  }
  return null;
}
function movePair(from, to, id) {
  fs.mkdirSync(to, { recursive: true });
  const source = path.join(from, `${id}.jsonl`), dest = path.join(to, `${id}.jsonl`);
  const side = path.join(from, id), destSide = path.join(to, id);
  if (fs.existsSync(dest) || fs.existsSync(destSide)) throw new Error('archive-exists');
  const hasSide = fs.existsSync(side);
  if (hasSide) fs.renameSync(side, destSide);
  try { fs.renameSync(source, dest); }
  catch (e) { if (hasSide) fs.renameSync(destSide, side); throw e; }
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file);
}
export async function sessionCap({ home = os.homedir(), vscodeUserDir = vscodeDir(home), now = new Date().toISOString(), cap = 30, maxMove = 200, dryRun = false, reportDir, processesFile } = {}) {
  const time = Date.parse(now);
  if (!Number.isFinite(time) || !Number.isInteger(cap) || cap < 0 || !Number.isInteger(maxMove) || maxMove < 0) throw new Error('invalid now/cap/max-move');
  const base = path.join(home, '.claude'), stateDir = path.join(base, 'session-cap');
  const result = { at: new Date(time).toISOString(), host: os.hostname(), scopeRoots: [], projectDirs: [], cap, before: 0, after: 0, programmaticIgnored: 0, archived: [], kept: [], pending: [], overCap: null, dryRun, stateReadable: false };
  let release = () => {};
  if (!dryRun) { fs.mkdirSync(stateDir, { recursive: true }); release = acquire(path.join(stateDir, 'lock')); }
  if (!release) return { ...result, skipped: 'locked' };
  const inventory = [];
  try {
    let state;
    try { state = readState(path.join(vscodeUserDir, 'globalStorage/state.vscdb')); result.stateReadable = true; }
    catch (e) { result.error = e.message; return result; }
    try { result.scopeRoots = scopeRoots(vscodeUserDir, home); result.projectDirs = projectDirs(base, result.scopeRoots); }
    catch (e) { result.skipped = 'scope-unreadable'; result.error = e.message; return result; }
    const hidden = new Set(state.hiddenSessionIds ?? []);
    const files = result.projectDirs.flatMap(dir => entries(dir).filter(e => e.isFile() && e.name.endsWith('.jsonl') && !hidden.has(e.name.slice(0, -6))).map(e => path.join(dir, e.name)));
    const visible = [];
    for (const file of files) {
      try {
        const data = await inspectSession(file);
        if (/^sdk/.test(data.entrypoint)) { result.programmaticIgnored++; continue; }
        visible.push(data);
      } catch (e) {
        // Unknown entrypoints count as visible; unreadable sessions stay protected.
        visible.push({ id: path.basename(file, '.jsonl'), title: '', file, entrypoint: '', mtime: null, reasons: ['inspection-failed'], error: e.message });
      }
    }
    result.before = result.after = visible.length;
    let live = new Set(), commands = '', open = new Set(), protectionError;
    try {
      live = liveIds(base, time); commands = processCommands(processesFile);
      for (const entry of entries(path.join(vscodeUserDir, 'workspaceStorage'))) {
        if (!entry.isDirectory()) continue;
        const file = path.join(vscodeUserDir, 'workspaceStorage', entry.name, 'state.vscdb');
        if (!fs.existsSync(file)) continue;
        const updated = Math.max(...[file, file + '-wal', file + '-shm'].filter(f => fs.existsSync(f)).map(f => fs.statSync(f).mtimeMs));
        if (time - updated > 14 * 24 * HOUR) continue;
        // A missing extension key is an empty workspace, not an unreadable DB.
        try { for (const id of ids(readState(file))) open.add(id); }
        catch (e) { if (e.message !== 'extension state missing') throw e; }
      }
    } catch (e) {
      protectionError = result.error = e.message;
    }
    const grouped = new Set(result.scopeRoots.flatMap(root => [...ids(state[`sessionGroups:${root}`])]));
    const unread = new Set(result.scopeRoots.flatMap(root => [...ids(state[`sessionUnread:${root}`])]));
    const git = gitInspector();
    for (const data of visible) {
      data.unread = unread.has(data.id.toLowerCase());
      if (data.error) { inventory.push(data); continue; }
      try {
        const reasons = protectionError ? ['protection-unreadable'] : [];
        if (time - data.updated <= 10 * MINUTE || live.has(data.id) || commands.includes(data.id)) reasons.push('running');
        if (open.has(data.id.toLowerCase())) reasons.push('running', 'open-tab');
        if (/QuotaSweep|UnsentLedger|AutoSession|MorningSessionSweep|Fleet|auto-session|nightly/i.test(data.title + '\n' + data.firstUser) && time - data.updated <= 6 * HOUR) reasons.push('job-active');
        const pending = pendingReasons(data, time);
        if (pending.length) { reasons.push('pending', ...pending); result.pending.push({ id: data.id, title: data.title, excerpt: data.lastAssistant.slice(0, 300), reasons: pending }); }
        if (/下書き|未送信|送ってよい|送信承認/.test(data.lastAssistant)) reasons.push('draft');
        reasons.push(...git(data));
        if (grouped.has(data.id.toLowerCase())) reasons.push('grouped');
        const automatic = data.userTurns === 0;
        if (!automatic && !data.title.includes('【閉じて可】') && !sessionApproved(data.lastAssistant)) reasons.push('user-opened');
        if (automatic && time - data.updated < 24 * HOUR) reasons.push('automatic-recent');
        inventory.push({ ...data, reasons: [...new Set(reasons)] });
      } catch (e) { inventory.push({ ...data, reasons: ['inspection-failed'], error: e.message }); }
    }
    const candidates = inventory.filter(s => !s.reasons.length).sort((a, b) => a.updated - b.updated || a.id.localeCompare(b.id));
    for (const data of candidates) {
      if (result.after <= cap || result.archived.length >= maxMove) break;
      const to = path.join(base, 'projects-archive', data.projectId);
      try {
        if (fs.existsSync(path.join(to, `${data.id}.jsonl`)) || fs.existsSync(path.join(to, data.id))) throw new Error('archive-exists');
        const fresh = fs.statSync(data.file);
        if (fresh.size !== data.size || fresh.mtimeMs !== data.mtime || liveIds(base, time).has(data.id)) throw new Error('changed-during-scan');
        const row = { sessionId: data.id, projectId: data.projectId, reason: 'cap30', title: data.title, at: result.at };
        if (!dryRun) {
          movePair(path.dirname(data.file), to, data.id);
          try { fs.appendFileSync(path.join(base, 'archived-sessions.jsonl'), JSON.stringify(row) + '\n'); }
          catch (e) { movePair(to, path.dirname(data.file), data.id); throw e; }
        }
        result.archived.push({ id: data.id, ...row }); result.after--;
      } catch (e) { data.reasons.push(e.message); }
    }
    const archived = new Set(result.archived.map(row => row.id));
    result.kept = inventory.filter(s => !archived.has(s.id)).map(s => ({ id: s.id, title: s.title, reasons: s.reasons.length ? s.reasons : [result.archived.length >= maxMove ? 'max-move' : 'cap-reached'] }));
    return result;
  } finally {
    if (result.after > cap) result.overCap = { count: result.after - cap, reason: [...new Set(result.kept.flatMap(s => s.reasons))].join(', ') || '保護対象または退避上限により超過' };
    try {
      if (!dryRun) writeJson(path.join(stateDir, 'last.json'), result);
      if (reportDir) {
        const archived = new Set(result.archived.map(row => row.id));
        const report = inventory.map(({ id, title, mtime, entrypoint, unread, reasons }) => ({ id, title, mtime, entrypoint, unread, reasons, decision: archived.has(id) ? 'archive' : 'keep' }));
        fs.mkdirSync(reportDir, { recursive: true });
        writeJson(path.join(reportDir, 'inventory.json'), { ...result, inventory: report });
        writeJson(path.join(reportDir, 'skipped.json'), report.filter(row => row.decision === 'keep').map(({ id, title, reasons }) => ({ id, title, reasons })));
        writeJson(path.join(reportDir, 'archived.json'), result.archived);
        fs.writeFileSync(path.join(reportDir, 'pending-found.md'), '# 確認待ちセッション\n\n' + (result.pending.map(row => `- ${row.id} — ${row.title}\n  ${row.excerpt.replace(/\n/g, '\n  ')}`).join('\n\n') || '確認待ちはありません。') + '\n');
      }
    } finally { release(); }
  }
}
export function parseArgs(args) {
  const options = {};
  const names = { '--cap': 'cap', '--max-move': 'maxMove', '--home': 'home', '--vscode-user-dir': 'vscodeUserDir', '--now': 'now', '--processes-file': 'processesFile', '--report-dir': 'reportDir' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--json') options.json = true;
    else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) { const key = names[args[i]]; options[key] = ['cap', 'maxMove'].includes(key) ? Number(args[++i]) : args[++i]; }
    else throw new Error(`unknown or missing argument: ${args[i]}`);
  }
  return options;
}
if (isEntry(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2)), result = await sessionCap(options);
    console.log(options.json ? JSON.stringify(result) : `可視 ${result.before} → ${result.after} / 上限 ${result.cap} / ${result.dryRun ? '退避予定' : '退避'} ${result.archived.length}\n${JSON.stringify(result, null, 2)}`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
