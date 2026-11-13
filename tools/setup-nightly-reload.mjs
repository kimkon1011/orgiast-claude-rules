import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export function ensureRestoreWindows(file) {
  let raw = '{}\n';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const clean = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    token => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, ' '));
  const parsed = JSON.parse(clean.replace(/^\uFEFF/, ' ').replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === ',' ? ' ' : token));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid VS Code settings object');
  if (parsed['window.restoreWindows'] === 'all') return false;
  const keys = [...clean.matchAll(/"window\.restoreWindows"\s*:\s*("(?:\\.|[^"\\])*"|null|true|false|[\d.-]+)/g)];
  let next;
  if (Object.hasOwn(parsed, 'window.restoreWindows')) {
    if (keys.length !== 1) throw new Error('Ambiguous window.restoreWindows setting');
    const match = keys[0];
    const start = match.index + match[0].length - match[1].length;
    next = raw.slice(0, start) + '"all"' + raw.slice(start + match[1].length);
  } else {
    const start = clean.indexOf('{') + 1;
    next = raw.slice(0, start) + '\n  "window.restoreWindows": "all"' + (Object.keys(parsed).length ? ',' : '') + raw.slice(start);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

export function convergeNightlyReload({ platform = process.platform, run = execFileSync,
  settingsPath = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json'),
  restore = ensureRestoreWindows } = {}) {
  const result = { description: 'VS Code 夜間再起動（04:40〜06:00、20分刻み）', checked: true, repaired: false };
  if (platform !== 'win32') return { ...result, status: 'NOTICE' };
  try {
    const settingsChanged = restore(settingsPath);
    let tasksChanged = false;
    for (const script of ['register-nightly-reload-vscode.ps1', 'register-reopen-lost-sessions.ps1']) {
      const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(toolsDir, script)],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const registration = JSON.parse(String(output).replace(/^\uFEFF/, '').trim());
      if (typeof registration.changed !== 'boolean') throw new Error('Invalid task registration result');
      tasksChanged ||= registration.changed;
    }
    return { ...result, status: 'OK', repaired: settingsChanged || tasksChanged };
  } catch (error) { return { ...result, status: 'NG', reason: error.message }; }
}
if (isEntry(import.meta.url)) {
  const result = convergeNightlyReload();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'NG' ? 1 : 0;
}
