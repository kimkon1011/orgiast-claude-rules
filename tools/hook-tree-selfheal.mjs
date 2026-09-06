#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function contentEquals(left, right) {
  if (left === right) return true;
  if (left == null || right == null) return false;
  return Buffer.from(left).equals(Buffer.from(right));
}

export function decideAction({ working, head, main, lastWrittenSha }) {
  if (main == null) return { action: 'skipped', reason: 'origin/main に存在しない' };
  if (contentEquals(working, main)) return { action: 'uptodate', reason: 'origin/main と同一' };
  if (head != null && contentEquals(working, head)) return { action: 'updated', reason: '作業ツリーは HEAD と同一' };
  if (lastWrittenSha && sha256(working) === lastWrittenSha) return { action: 'updated', reason: '前回 selfheal が書いた内容' };
  return { action: 'skipped', reason: head == null ? '未追跡の作業ファイル' : '他セッションの未コミット作業' };
}

export function decideTreeAction({ dirty, detached, headSha, mainSha }) {
  if (!dirty && detached && headSha === mainSha) return { action: 'uptodate', reason: 'HEAD は origin/main と同一' };
  if (!dirty && detached) return { action: 'tree-advanced', reason: 'clean・detached のため origin/main へ前進' };
  if (dirty) return { action: 'per-file', reason: 'dirty なツリーのためファイル単位' };
  return { action: 'per-file', reason: 'ブランチ作業中のためファイル単位' };
}

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: options.encoding ?? 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] });
}

function gitContent(repo, ref, file) {
  try { return git(repo, ['show', `${ref}:${file}`], { encoding: 'buffer' }); } catch { return null; }
}

function hookCommands(settings) {
  const commands = [];
  for (const groups of Object.values(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) commands.push(String(hook?.command || ''));
  }
  return commands;
}

function nativePath(value) {
  if (process.platform !== 'win32') {
    const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
    if (match) return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
  }
  return path.normalize(value);
}

export function extractHookTreeRoots(settings, { realpath = false } = {}) {
  const roots = new Set();
  const pattern = /((?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]*?)[\\/]tools[\\/][A-Za-z0-9._-]+/g;
  for (const command of hookCommands(settings)) {
    for (const match of command.matchAll(pattern)) {
      let root = nativePath(match[1].trim().replace(/^node\s+/i, ''));
      if (realpath) {
        try { root = fs.realpathSync(root); } catch { continue; }
      }
      roots.add(root);
    }
  }
  return [...roots].sort();
}

export function discoverHookFiles(settings, repo) {
  const files = new Set();
  const root = fs.realpathSync(repo);
  const pattern = /((?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]*?)[\\/]tools[\\/]([A-Za-z0-9._-]+)/g;
  for (const command of hookCommands(settings)) {
    for (const match of command.matchAll(pattern)) {
      try {
        if (fs.realpathSync(nativePath(match[1].trim().replace(/^node\s+/i, ''))) === root) files.add(`tools/${match[2]}`);
      } catch {}
    }
  }
  const directFiles = [...files];
  const importPattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const file of directFiles) {
    const sources = [];
    try { sources.push(fs.readFileSync(path.join(repo, file), 'utf8')); } catch {}
    const mainSource = gitContent(repo, 'origin/main', file);
    if (mainSource != null) sources.push(mainSource.toString('utf8'));
    for (const source of sources) for (const match of source.matchAll(importPattern)) {
      const resolved = path.normalize(path.join(path.dirname(file), match[2])).replaceAll('\\', '/');
      if (!resolved.startsWith('../') && resolved.startsWith('tools/')) files.add(resolved);
    }
  }
  return [...files].sort();
}

function readLedger(file) {
  const result = new Map();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return result; }
  for (const line of raw.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      const key = `${record.tree || ''}\0${record.file}`;
      if (record.action === 'updated' && record.sha256) result.set(key, record.sha256);
      if (record.action === 'reverted') result.delete(key);
    } catch {}
  }
  return result;
}

function appendLedger(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch (error) { console.error(`[hook-tree-selfheal] 台帳書き込み失敗: ${error.message}`); }
}

function syntaxCheck(repo, file) {
  const check = spawnSync(process.execPath, ['--check', path.join(repo, file)], { encoding: 'utf8' });
  return check.status === 0 ? { ok: true, reason: '構文チェック成功' } : { ok: false, reason: `構文チェック失敗: ${(check.stderr || check.stdout || '').trim()}` };
}

function healthCheck(repo, file) {
  const syntax = syntaxCheck(repo, file);
  if (!syntax.ok) return syntax;
  const testFile = file.replace(/\.mjs$/i, '.test.mjs');
  if (testFile !== file && fs.existsSync(path.join(repo, testFile))) {
    const test = spawnSync(process.execPath, ['--test', path.join(repo, testFile)], { cwd: repo, encoding: 'utf8' });
    if (test.status !== 0) return { ok: false, reason: `同名テスト失敗: ${testFile}` };
  }
  return { ok: true, reason: '構文・同名テスト成功' };
}

function runPerFile({ tree, files, ledgerFile, lastWritten, dryRun, list }) {
  const results = [];
  for (const file of files) {
    const fullPath = path.join(tree, file);
    let working;
    try { working = fs.readFileSync(fullPath); } catch { working = Buffer.alloc(0); }
    const decision = decideAction({ working, head: gitContent(tree, 'HEAD', file), main: gitContent(tree, 'origin/main', file), lastWrittenSha: lastWritten.get(`${tree}\0${file}`) || null });
    const result = { tree, file, action: decision.action, reason: decision.reason, sha256: sha256(working) };
    results.push(result);
    if (dryRun || list) continue;
    if (decision.action !== 'updated') { appendLedger(ledgerFile, result); continue; }
    try {
      git(tree, ['checkout', 'origin/main', '--', file]);
      const health = healthCheck(tree, file);
      if (!health.ok) {
        if (gitContent(tree, 'HEAD', file) == null) fs.rmSync(fullPath, { force: true }); else fs.writeFileSync(fullPath, working);
        Object.assign(result, { action: 'reverted', reason: health.reason, sha256: sha256(working) });
      } else Object.assign(result, { reason: `${decision.reason}; ${health.reason}`, sha256: sha256(fs.readFileSync(fullPath)) });
    } catch (error) {
      try { fs.writeFileSync(fullPath, working); } catch {}
      Object.assign(result, { action: 'reverted', reason: `更新処理失敗: ${error.message}`, sha256: sha256(working) });
    }
    appendLedger(ledgerFile, result);
  }
  return results;
}

export function runSelfheal({ repo, home, dryRun = false, list = false, fetch = true } = {}) {
  const resolvedHome = home || process.env.ORGIAST_HOME || os.homedir();
  const ledgerFile = process.env.ORGIAST_SELFHEAL_LEDGER || path.join(resolvedHome, '.claude', 'hook-selfheal-ledger.jsonl');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(resolvedHome, '.claude', 'settings.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (dryRun || list) console.error(`[hook-tree-selfheal] settings 読み込み失敗: ${error.message}`); return []; }
  let trees = extractHookTreeRoots(settings, { realpath: true });
  if (repo) {
    const forced = fs.realpathSync(path.resolve(repo));
    trees = trees.includes(forced) ? [forced] : [];
  }
  const lastWritten = readLedger(ledgerFile);
  const allResults = [];
  for (const candidate of trees) {
    let tree;
    try { tree = fs.realpathSync(git(candidate, ['rev-parse', '--show-toplevel']).trim()); } catch { continue; }
    if (fetch) try { git(tree, ['fetch', 'origin', '--quiet']); } catch (error) { console.error(`[hook-tree-selfheal] ${tree}: git fetch 失敗（続行）: ${error.message}`); }
    const files = discoverHookFiles(settings, tree);
    const dirty = git(tree, ['status', '--porcelain']).trim() !== '';
    let detached = false;
    try { git(tree, ['symbolic-ref', '-q', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { detached = true; }
    const headSha = git(tree, ['rev-parse', 'HEAD']).trim();
    let mainSha;
    try { mainSha = git(tree, ['rev-parse', 'origin/main']).trim(); } catch { continue; }
    const treeDecision = decideTreeAction({ dirty, detached, headSha, mainSha });
    if (treeDecision.action === 'tree-advanced') {
      const result = { tree, action: 'tree-advanced', reason: treeDecision.reason, from: headSha, to: mainSha, files };
      allResults.push(result);
      if (!dryRun && !list) {
        try {
          git(tree, ['checkout', '--detach', 'origin/main']);
          const failed = files.map((file) => ({ file, health: syntaxCheck(tree, file) })).find(({ health }) => !health.ok);
          if (failed) {
            git(tree, ['checkout', '--detach', headSha]);
            Object.assign(result, { action: 'reverted', reason: `${failed.file}: ${failed.health.reason}` });
          }
        } catch (error) {
          try { git(tree, ['checkout', '--detach', headSha]); } catch {}
          Object.assign(result, { action: 'reverted', reason: `ツリー更新失敗: ${error.message}` });
        }
        appendLedger(ledgerFile, result);
      }
    } else {
      const results = runPerFile({ tree, files, ledgerFile, lastWritten, dryRun, list });
      allResults.push(...results);
      if ((dryRun || list) && treeDecision.action === 'uptodate' && results.every((item) => item.action === 'uptodate')) {
        // Per-file details retain exact counts while the header exposes the tree decision.
      }
    }
    if (dryRun || list) {
      const treeResults = allResults.filter((item) => item.tree === tree);
      console.log(`\nツリー ${tree} - ${treeDecision.action}: ${treeDecision.reason}`);
      for (const result of treeResults) {
        if (result.file) console.log(`${result.action.padEnd(8)} ${result.file} - ${result.reason}`);
      }
      const perFiles = treeResults.filter((item) => item.file);
      const counts = Object.fromEntries(['uptodate', 'updated', 'skipped'].map((action) => [action, perFiles.filter((item) => item.action === action).length]));
      const planned = treeDecision.action === 'tree-advanced' ? files.filter((file) => !contentEquals(gitContent(tree, 'HEAD', file), gitContent(tree, 'origin/main', file))).length : counts.updated;
      console.log(`合計 ${files.length}: uptodate=${treeDecision.action === 'tree-advanced' ? files.length - planned : counts.uptodate}, updated予定=${planned}, skipped=${counts.skipped}`);
    }
  }
  return allResults;
}

if (isEntry(import.meta.url)) runSelfheal({ dryRun: process.argv.includes('--dry-run'), list: process.argv.includes('--list') });
