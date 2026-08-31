#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

export function needsWorktreeRepair(gitFileContent) {
  return /^gitdir:\s*[A-Za-z]:/i.test(String(gitFileContent ?? '').trim());
}

if (isEntry(import.meta.url)) {

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceNative = args.includes('--force-native');
const cwdIndex = args.indexOf('--cwd');
const promptFileIndex = args.indexOf('--prompt-file');
const timeoutIndex = args.indexOf('--timeout');
const cwd = path.resolve(cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd());
// cwdIndex が -1 のとき cwdIndex+1 が 0 になり、指示文(第1引数)を捨ててしまうので条件付きで除外する。
const omitted = new Set();
if (dryRun) omitted.add(args.indexOf('--dry-run'));
if (forceNative) omitted.add(args.indexOf('--force-native'));
if (cwdIndex >= 0) { omitted.add(cwdIndex); omitted.add(cwdIndex + 1); }
if (promptFileIndex >= 0) { omitted.add(promptFileIndex); omitted.add(promptFileIndex + 1); }
if (timeoutIndex >= 0) { omitted.add(timeoutIndex); omitted.add(timeoutIndex + 1); }
const usage = '使い方: node tools/codex-do.mjs "<指示>" [--cwd <path>] [--prompt-file <file>] [--timeout <秒>] [--dry-run]';

// タイムアウト既定30分。無限に待って気付かないより、切って原因を見に行くほうが安い。
const timeoutSeconds = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 1800;
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(`--timeout は正の秒数で指定してください\n${usage}`);
  process.exit(2);
}

// 指示文はファイルから読むのを既定にする。argv で渡すとシェルがバッククォートを
// コマンド置換として実行し、仕様の一部が消えたプロンプトが Codex に届く(2026-08-26 実害)。
let instruction = args.filter((_, index) => !omitted.has(index)).join(' ').trim();
if (promptFileIndex >= 0) {
  const promptFile = args[promptFileIndex + 1];
  if (!promptFile) { console.error(`--prompt-file にファイルパスが必要です\n${usage}`); process.exit(2); }
  try {
    instruction = fs.readFileSync(promptFile, 'utf8').trim();
  } catch (error) {
    console.error(`--prompt-file を読めません: ${promptFile} (${error.code || error.message})`);
    process.exit(2);
  }
}
if (!instruction) { console.error(usage); process.exit(2); }

const home = process.env.ORGIAST_HOME || os.homedir();
const slug = cwd.replace(/[^a-z0-9]/gi, '-').toLowerCase();
const projects = path.join(home, '.claude', 'projects');
let memoryFile = path.join(projects, slug, 'memory', 'MEMORY.md');
if (!fs.existsSync(memoryFile)) {
  const candidates = [];
  try {
    for (const project of fs.readdirSync(projects)) {
      const candidate = path.join(projects, project, 'memory', 'MEMORY.md');
      try { candidates.push({ file: candidate, mtime: fs.statSync(candidate).mtimeMs }); } catch {}
    }
  } catch {}
  candidates.sort((a, b) => b.mtime - a.mtime);
  memoryFile = candidates[0]?.file || '';
}
const readLimit = (file, limit) => { try { return fs.readFileSync(file, 'utf8').slice(0, limit); } catch { return ''; } };
const mainMemory = memoryFile ? readLimit(memoryFile, 8000) : '';
const memoryDir = memoryFile ? path.dirname(memoryFile) : '';
const terms = [...new Set((instruction.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []))];
const related = [];
if (memoryDir) {
  try {
    for (const name of fs.readdirSync(memoryDir)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
      const file = path.join(memoryDir, name);
      const body = readLimit(file, 12000);
      const header = body.split(/\r?\n/).filter((line) => /^(name|description)\s*:/i.test(line)).join(' ').toLowerCase();
      const haystack = `${name.toLowerCase()} ${header}`;
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      if (score) related.push({ name, score, body: body.slice(0, 4000) });
    }
  } catch {}
}
related.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const claudeMd = readLimit(path.join(cwd, 'CLAUDE.md'), 6000);
const context = [];
if (mainMemory || related.length || claudeMd) {
  context.push('これは Claude(監督)が蓄積したコンテキスト。既存の失敗パターンを繰り返さないこと。');
  if (mainMemory) context.push(`\n## MEMORY.md\n${mainMemory}`);
  for (const item of related.slice(0, 3)) context.push(`\n## 関連 memory: ${item.name}\n${item.body}`);
  if (claudeMd) context.push(`\n## 対象プロジェクト CLAUDE.md\n${claudeMd}`);
}
const prompt = `${context.join('\n')}\n\n## 実装指示\n${instruction}`.trim();
if (dryRun) { console.log(prompt); process.exit(0); }

const started = Date.now();
function execute(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    let outputChars = 0, output = '', timedOut = false;
    // stdio を全て pipe にして TTY を渡さない。TTY 付きで起動すると codex が端末入力を
    // 待ったまま眠り続ける(2026-08-26 に 1日00:57 hang した実害)。
    const child = spawn(command, commandArgs, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n⏱ Codex が ${timeoutSeconds} 秒で応答を終えなかったので停止しました。--timeout で延長できます`);
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { outputChars += chunk.length; output += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, error, outputChars, output }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status: timedOut ? 124 : status, outputChars, output, timedOut }); });
    // 指示は stdin で渡し、必ず閉じる。閉じないと codex が
    // "Reading additional input from stdin..." のまま永久に待つ。
    child.stdin.end(prompt);
  });
}
let result;
if (process.platform === 'win32' && !forceNative) {
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le', timeout: 15000 });
  const distros = listed.status === 0 ? listed.stdout.split(/\r?\n/).map((x) => x.replace(/\0/g, '').trim()).filter(Boolean) : [];
  const distro = distros.find((x) => x.toLowerCase() === 'ubuntu') || distros[0];
  let usable = false;
  if (distro) {
    usable = spawnSync('wsl', ['-d', distro, '--', 'codex', '--version'], { stdio: 'ignore', timeout: 15000 }).status === 0;
    if (!usable) {
      console.error(`WSL ${distro} に Codex がないため自動インストールを試します`);
      spawnSync('wsl', ['-d', distro, '--', 'npm', 'i', '-g', '@openai/codex'], { stdio: 'inherit', timeout: 120000 });
      usable = spawnSync('wsl', ['-d', distro, '--', 'codex', '--version'], { stdio: 'ignore', timeout: 15000 }).status === 0;
    }
  }
  if (usable) {
    const gitFile = path.join(cwd, '.git');
    try {
      if (fs.statSync(gitFile).isFile() && needsWorktreeRepair(fs.readFileSync(gitFile, 'utf8'))) {
        const repaired = spawnSync('git', ['-C', cwd, '-c', 'worktree.useRelativePaths=true', 'worktree', 'repair'], { encoding: 'utf8' });
        if (repaired.status === 0) console.error('⚠️ Windows 絶対パスの gitdir は WSL 側 codex が解決できないため相対パスへ直しました');
        else console.error(`⚠️ Windows 絶対パスの gitdir を相対パスへ修復できませんでした（処理は続行します）: ${(repaired.stderr || repaired.error?.message || `exit ${repaired.status}`).trim()}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error(`⚠️ worktree の gitdir 確認に失敗しました（処理は続行します）: ${error?.message ?? error}`);
    }
    result = await execute('wsl', ['-d', distro, '--cd', cwd, '--', 'codex', 'exec', '-s', 'workspace-write', '-']);
  }
  else {
    console.error('⚠️ WSL 経路が使えないためネイティブ Windows codex で実行します。\nWindows 版は read-only サンドボックス固定でファイルを書けない既知の不具合(openai/codex#35428)があり、編集が保存されない可能性が高い。WSL の導入を推奨');
    result = await execute('codex', ['exec', '-s', 'workspace-write', '-'], { cwd });
  }
} else {
  if (process.platform === 'win32') console.error('⚠️ --force-native によりネイティブ Windows codex で実行します。編集が保存されない可能性があります');
  result = await execute('codex', ['exec', '-s', 'workspace-write', '-'], { cwd });
}
const secs = (Date.now() - started) / 1000;
const diff = spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf8' });
if (diff.stdout) process.stdout.write(diff.stdout);
// 読み取り専用の質問(説明して/調べて)では空diffが正常なので、指示自体が実装系のときだけ判定する。
const wantedEdit = /実装|作って|修正|直して|追加して|リファクタ|refactor|fix|implement/i.test(instruction);
if (wantedEdit && !result.timedOut && !diff.stdout.trim() && /実装|変更|修正|implemented|updated|modified/i.test(result.output || '')) {
  console.error('🚨 Codex は変更を書き込めていません（read-only サンドボックスの疑い）。WSL 経路で再実行してください');
  result.status = 1;
}
try {
  const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const usage = { t: new Date().toISOString(), provider: 'codex', model: 'codex-cli', in: Math.ceil(prompt.length / 4), out: Math.ceil((result.outputChars || 0) / 4), secs: Number(secs.toFixed(3)) };
  fs.appendFileSync(ledger, `${JSON.stringify(usage)}\n`, 'utf8');
} catch {}
process.exit(result?.status ?? 1);
}
