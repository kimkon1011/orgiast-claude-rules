#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--dry-run') options.dryRun = true;
    else if (name === '--deploy-webapp') options.deployWebapp = true;
    else if (['--project', '--files', '--deploy', '--description'].includes(name)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name}: 値が必要です`);
      options[name.slice(2)] = args[++i];
    } else throw new Error(`不明な引数: ${name}`);
  }
  if (!options.project || !options.files) throw new Error('--project と --files が必要です');
  if (options.deploy && options.deployWebapp) throw new Error('--deploy と --deploy-webapp は併用できません');
  options.files = [...new Set(options.files.split(',').map(s => s.trim()))];
  return options;
}

// Windows cannot spawn a .cmd file with shell:false. Resolve the npm shim's
// JavaScript entry point and run it with this Node executable instead.
export function resolveClasp(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command: 'clasp', prefix: [] };
  for (const directory of (env.PATH || env.Path || '').split(';')) {
    if (!directory) continue;
    const shim = path.join(directory.replace(/^"|"$/g, ''), 'clasp.cmd');
    if (!fs.existsSync(shim)) continue;
    const body = fs.readFileSync(shim, 'utf8');
    const match = body.match(/"%(?:dp0|~dp0)%?[\\/]([^"\r\n]+\.(?:js|cjs|mjs))"/i);
    if (!match) throw new Error(`clasp.cmd の Node エントリーポイントを解決できません: ${shim}`);
    const entry = path.resolve(path.dirname(shim), ...match[1].split(/[\\/]/));
    if (!fs.existsSync(entry)) throw new Error(`clasp エントリーポイントがありません: ${entry}`);
    return { command: process.execPath, prefix: [entry] };
  }
  throw new Error('PATH に clasp.cmd がありません');
}

export function claspRunner(args, { cwd }) {
  const { command, prefix } = resolveClasp();
  return spawnSync(command, [...prefix, ...args], {
    cwd, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function inside(base, relative, allowRoot = false) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || path.win32.isAbsolute(relative)
      || relative.includes('\\') || relative.split('/').includes('..')) {
    throw new Error(`安全でない相対パス: ${relative}`);
  }
  const resolved = path.resolve(base, relative);
  const rel = path.relative(base, resolved);
  if ((!allowRoot && !rel) || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`作業ディレクトリ外のパス: ${relative}`);
  }
  return resolved;
}

const normalize = text => text.replace(/\r\n/g, '\n');
const lines = text => text === '' ? [] : normalize(text).match(/[^\n]*\n|[^\n]+$/g);

// Hirschberg LCS: quadratic time, linear working memory even for large files.
function lengths(a, b) {
  let prev = new Uint32Array(b.length + 1);
  for (const line of a) {
    const next = new Uint32Array(b.length + 1);
    for (let j = 0; j < b.length; j++) next[j + 1] = line === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], next[j]);
    prev = next;
  }
  return prev;
}
function lcs(a, b) {
  if (!a.length || !b.length) return [];
  if (a.length === 1) return b.includes(a[0]) ? a : [];
  const mid = Math.floor(a.length / 2);
  const left = lengths(a.slice(0, mid), b);
  const right = lengths(a.slice(mid).reverse(), [...b].reverse());
  let split = 0;
  for (let j = 1; j <= b.length; j++) if (left[j] + right[b.length - j] > left[split] + right[b.length - split]) split = j;
  return [...lcs(a.slice(0, mid), b.slice(0, split)), ...lcs(a.slice(mid), b.slice(split))];
}
export function diff(before, after, file) {
  const a = lines(before), b = lines(after), operations = [];
  let i = 0, j = 0, added = 0, removed = 0;
  const emit = (sign, line) => {
    operations.push(sign + line.replace(/\n$/, ''));
    if (!line.endsWith('\n')) operations.push('\\ No newline at end of file');
  };
  for (const common of lcs(a, b)) {
    while (a[i] !== common) { emit('-', a[i++]); removed++; }
    while (b[j] !== common) { emit('+', b[j++]); added++; }
    emit(' ', common); i++; j++;
  }
  while (i < a.length) { emit('-', a[i++]); removed++; }
  while (j < b.length) { emit('+', b[j++]); added++; }
  return { added, removed, text: [`--- a/${file}`, `+++ b/${file}`, `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`, ...operations].slice(0, 80).join('\n') };
}

export function runOverlay(options, { runner = claspRunner, stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  const temporary = [];
  const result = { ok: false, pushed: [], unchanged: [], readBack: 'skipped', deployed: null };
  const printDiff = (before, after, file) => {
    const d = diff(before, after, file);
    stdout(`${file}: +${d.added} / -${d.removed}\n${d.text}\n`);
  };
  try {
    if (options.deploy && options.deployWebapp) throw new Error('--deploy と --deploy-webapp は併用できません');
    const project = path.resolve(options.project);
    const config = JSON.parse(fs.readFileSync(path.join(project, '.clasp.json'), 'utf8'));
    if (typeof config.scriptId !== 'string' || !config.scriptId.trim()) throw new Error('scriptId が必要です');
    const rootDir = config.rootDir ?? '';
    const sourceRoot = inside(project, rootDir, true);
    if (!Array.isArray(options.files) || !options.files.length) throw new Error('--files が必要です');
    const files = [...new Set(options.files)];
    const snapshots = new Map();
    for (const file of files) {
      const source = inside(sourceRoot, file);
      if (['.clasp.json', '.claspignore'].includes(path.basename(source))) throw new Error(`設定ファイルは指定できません: ${file}`);
      const real = fs.realpathSync(source);
      const rel = path.relative(fs.realpathSync(sourceRoot), real);
      if (rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`外部へのシンボリックリンク: ${file}`);
      if (!fs.statSync(source).isFile()) throw new Error(`ファイルではありません: ${file}`);
      snapshots.set(file, fs.readFileSync(source, 'utf8'));
    }
    const ignorePath = path.join(project, '.claspignore');
    const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath) : null;
    const makeWorkspace = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-overlay-push-'));
      temporary.push(dir);
      fs.writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify(config, null, 2));
      if (ignore !== null) fs.writeFileSync(path.join(dir, '.claspignore'), ignore);
      fs.mkdirSync(inside(dir, rootDir, true), { recursive: true });
      return dir;
    };
    const call = (args, cwd) => {
      const response = runner(args, { cwd });
      if (response.stdout) stdout(String(response.stdout) + (String(response.stdout).endsWith('\n') ? '' : '\n'));
      if (response.stderr) stderr(String(response.stderr));
      if (response.error || response.status !== 0) throw new Error(`clasp ${args[0]} 失敗: ${response.error?.message || response.signal || response.status}`);
      return String(response.stdout || '');
    };
    const work = makeWorkspace();
    call(['pull'], work);
    const workRoot = inside(work, rootDir, true);
    const changed = [];
    for (const file of files) {
      const target = inside(workRoot, file);
      const exists = fs.existsSync(target);
      const before = exists ? fs.readFileSync(target, 'utf8') : '';
      const after = snapshots.get(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, after);
      if (exists && normalize(before) === normalize(after)) {
        result.unchanged.push(file);
        stdout(`${file}: 変更なし\n`);
      } else {
        changed.push(file);
        printDiff(before, after, file);
      }
    }
    if (changed.length && !options.dryRun) {
      call(['push', '-f'], work);
      result.pushed = changed;
      const readBack = makeWorkspace();
      call(['pull'], readBack);
      const mismatched = [];
      for (const file of files) {
        const target = inside(inside(readBack, rootDir, true), file);
        const exists = fs.existsSync(target);
        const actual = exists ? fs.readFileSync(target, 'utf8') : '';
        if (!exists || normalize(actual) !== normalize(snapshots.get(file))) {
          mismatched.push(file);
          stdout(`read-back 不一致${exists ? '' : ' (ファイルなし)'}: ${file}\n`);
          printDiff(actual, snapshots.get(file), file);
        }
      }
      if (mismatched.length) { result.readBack = 'failed'; throw new Error(`read-back 不一致: ${mismatched.join(', ')}`); }
      result.readBack = 'ok';
      let deployment = options.deploy;
      if (options.deployWebapp) {
        const output = call(['deployments'], work);
        const ids = [...new Set([...output.matchAll(/^\s*-\s+(\S+)\s+@(\S+)/gm)].filter(m => m[2] !== 'HEAD').map(m => m[1]))];
        if (ids.length !== 1) throw new Error(`デプロイ候補 (${ids.length}): ${ids.join(', ') || 'なし'}。--deploy で明示してください`);
        deployment = ids[0];
      }
      if (deployment) {
        call(['deploy', '-i', deployment, '-d', options.description ?? 'gas-overlay-push'], work);
        result.deployed = deployment;
      }
    }
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    stderr(`${error.message}\n`);
  } finally {
    for (const dir of temporary) {
      try {
        const relative = path.relative(path.resolve(os.tmpdir()), dir);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`削除対象が tmpdir 外です: ${dir}`);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) { result.ok = false; result.error = error.message; stderr(`${error.message}\n`); }
    }
  }
  stdout(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = runOverlay(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
