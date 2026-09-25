import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(toolsDir);
const hooksDir = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'hooks');
const callPattern = /(?<![\w.])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g;

const allowlist = new Map([
  ['tools/next-session-launch.mjs', [
    { marker: 'command: wt', reason: '次セッションの Windows Terminal を利用者に表示する' },
    { marker: "command: 'cmd.exe'", reason: 'cmd.exe start で次セッションを利用者に表示する' },
    { marker: 'windowsHide: false', reason: '次セッションの対話ターミナルを意図的に表示する' },
  ]],
]);

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(target);
    return entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') ? [target] : [];
  });
}

function completeCall(source, start) {
  const open = source.indexOf('(', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function relativeName(file) {
  if (file.startsWith(toolsDir + path.sep)) return `tools/${path.relative(toolsDir, file).replaceAll(path.sep, '/')}`;
  return `~/.claude/hooks/${path.relative(hooksDir, file).replaceAll(path.sep, '/')}`;
}

test('全ての子プロセス起動はコンソール窓を隠す', () => {
  const violations = [];
  const seenAllowlist = new Set();
  for (const file of [...filesUnder(toolsDir), ...filesUnder(hooksDir)]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = relativeName(file);
    for (const { marker } of allowlist.get(name) || []) {
      if (source.includes(marker)) seenAllowlist.add(`${name}:${marker}`);
    }
    for (const match of source.matchAll(callPattern)) {
      const call = completeCall(source, match.index);
      if (/windowsHide\s*:\s*true/.test(call) || /backgroundSpawnOptions\s*\(/.test(call)) continue;
      const exception = (allowlist.get(name) || []).find(({ marker }) => call.includes(marker));
      if (exception) continue;
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      violations.push(`${name}:${line} ${match[0].trim()}`);
    }
  }
  for (const [file, exceptions] of allowlist) {
    for (const { marker, reason } of exceptions) {
      assert.ok(seenAllowlist.has(`${file}:${marker}`), `未使用の許可リスト: ${file} (${reason})`);
    }
  }
  assert.deepEqual(violations, [], `windowsHide: true がない子プロセス起動:\n${violations.join('\n')}`);
});

test('detached は非Windows分岐・可視セッション・明示許可された単発退避だけで使う', () => {
  const violations = [];
  for (const file of [...filesUnder(toolsDir), ...filesUnder(hooksDir)]) {
    const source = fs.readFileSync(file, 'utf8');
    const name = relativeName(file);
    for (const match of source.matchAll(/detached\s*:\s*true/g)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      const context = source.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120);
      const platformGuarded = /(?:process\.platform|platform)\s*===\s*['"]win32['"][\s\S]*?windowsHide\s*:\s*true[\s\S]*?:\s*\{\s*detached\s*:\s*true/.test(context);
      const visibleSession = name === 'tools/next-session-launch.mjs';
      // Session archival explicitly requires detached + windowsHide on all platforms.
      // Keep this exception local to the one-shot launcher and still audit hidden stdio.
      const oneShotPurge = name === 'tools/purge-sessions.mjs' &&
        /detached:\s*true, windowsHide:\s*true, stdio:\s*'ignore'/.test(context);
      if (!platformGuarded && !visibleSession && !oneShotPurge) violations.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(violations, [], `無条件の detached: true:\n${violations.join('\n')}`);
});
