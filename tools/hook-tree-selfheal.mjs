#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function contentEquals(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return leftBuffer.equals(rightBuffer);
}

export function decideAction({ working, head, main, lastWrittenSha }) {
  if (main === null || main === undefined) return { action: 'skipped', reason: 'origin/main に存在しない' };
  if (contentEquals(working, main)) return { action: 'uptodate', reason: 'origin/main と同一' };
  if (head !== null && head !== undefined && contentEquals(working, head)) return { action: 'updated', reason: '作業ツリーは HEAD と同一' };
  if (lastWrittenSha && sha256(working) === lastWrittenSha) return { action: 'updated', reason: '前回 selfheal が書いた内容' };
  return { action: 'skipped', reason: head === null || head === undefined ? '未追跡の作業ファイル' : '他セッションの未コミット作業' };
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
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) commands.push(String(hook?.command || ''));
    }
  }
  return commands;
}

export function discoverHookFiles(settings, repo) {
  const files = new Set();
  const commandPattern = /orgiast-claude-rules[\\/]+tools[\\/]+([A-Za-z0-9._-]+)/gi;
  for (const command of hookCommands(settings)) {
    for (const match of command.matchAll(commandPattern)) files.add(`tools/${match[1]}`);
  }
  const directFiles = [...files];
  const importPattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const file of directFiles) {
    const sources = [];
    try { sources.push(fs.readFileSync(path.join(repo, file), 'utf8')); } catch {}
    const mainSource = gitContent(repo, 'origin/main', file);
    if (mainSource !== null) sources.push(mainSource.toString('utf8'));
    for (const source of sources) {
      for (const match of source.matchAll(importPattern)) {
        const resolved = path.normalize(path.join(path.dirname(file), match[2])).replaceAll('\\', '/');
        if (!resolved.startsWith('../') && resolved.startsWith('tools/')) files.add(resolved);
      }
    }
  }
  return [...files].sort();
}

function readLedger(file) {
  const result = new Map();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return result; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.action === 'updated' && record.sha256) result.set(record.file, record.sha256);
      if (record.action === 'reverted') result.delete(record.file);
    } catch {}
  }
  return result;
}

function appendLedger(ledgerFile, record) {
  try {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.appendFileSync(ledgerFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch (error) {
    console.error(`[hook-tree-selfheal] 台帳書き込み失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function healthCheck(repo, file) {
  const syntax = spawnSync(process.execPath, ['--check', path.join(repo, file)], { encoding: 'utf8' });
  if (syntax.status !== 0) return { ok: false, reason: `構文チェック失敗: ${(syntax.stderr || syntax.stdout || '').trim()}` };
  const testFile = file.replace(/\.mjs$/i, '.test.mjs');
  if (testFile !== file && fs.existsSync(path.join(repo, testFile))) {
    const test = spawnSync(process.execPath, ['--test', path.join(repo, testFile)], { cwd: repo, encoding: 'utf8' });
    if (test.status !== 0) return { ok: false, reason: `同名テスト失敗: ${testFile}` };
  }
  return { ok: true, reason: '構文・同名テスト成功' };
}

function restoreFile(fullPath, content) {
  if (content === null) fs.rmSync(fullPath, { force: true });
  else fs.writeFileSync(fullPath, content);
}

export function runSelfheal({ repo, home, dryRun = false, list = false, fetch = true } = {}) {
  const resolvedRepo = path.resolve(repo || process.env.ORGIAST_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const resolvedHome = home || process.env.ORGIAST_HOME || os.homedir();
  const settingsFile = path.join(resolvedHome, '.claude', 'settings.json');
  const ledgerFile = process.env.ORGIAST_SELFHEAL_LEDGER || path.join(resolvedHome, '.claude', 'hook-selfheal-ledger.jsonl');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (dryRun || list) console.error(`[hook-tree-selfheal] settings 読み込み失敗: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (fetch) {
    try { git(resolvedRepo, ['fetch', 'origin', '--quiet']); } catch (error) {
      console.error(`[hook-tree-selfheal] git fetch 失敗（既存 origin/main で続行）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const lastWritten = readLedger(ledgerFile);
  const results = [];
  for (const file of discoverHookFiles(settings, resolvedRepo)) {
    const fullPath = path.join(resolvedRepo, file);
    let working;
    try { working = fs.readFileSync(fullPath); } catch { working = Buffer.alloc(0); }
    const head = gitContent(resolvedRepo, 'HEAD', file);
    const main = gitContent(resolvedRepo, 'origin/main', file);
    const decision = decideAction({ working, head, main, lastWrittenSha: lastWritten.get(file) || null });
    const result = { file, action: decision.action, reason: decision.reason, sha256: sha256(working) };
    results.push(result);
    if (dryRun || list) continue;
    if (decision.action !== 'updated') {
      appendLedger(ledgerFile, result);
      continue;
    }
    try {
      git(resolvedRepo, ['checkout', 'origin/main', '--', file]);
      const updated = fs.readFileSync(fullPath);
      const health = healthCheck(resolvedRepo, file);
      if (!health.ok) {
        restoreFile(fullPath, working);
        result.action = 'reverted';
        result.reason = health.reason;
        result.sha256 = sha256(working);
      } else {
        result.reason = `${decision.reason}; ${health.reason}`;
        result.sha256 = sha256(updated);
      }
    } catch (error) {
      try { restoreFile(fullPath, working); } catch {}
      result.action = 'reverted';
      result.reason = `更新処理失敗: ${error instanceof Error ? error.message : String(error)}`;
      result.sha256 = sha256(working);
    }
    appendLedger(ledgerFile, result);
  }
  if (dryRun || list) {
    for (const result of results) console.log(`${result.action.padEnd(8)} ${result.file} - ${result.reason}`);
    const counts = Object.fromEntries(['uptodate', 'updated', 'skipped'].map((action) => [action, results.filter((item) => item.action === action).length]));
    console.log(`合計 ${results.length}: uptodate=${counts.uptodate}, updated予定=${counts.updated}, skipped=${counts.skipped}`);
  } else {
    const changed = results.filter((result) => result.action === 'updated' || result.action === 'reverted');
    if (changed.length) console.log(`[hook-tree-selfheal] ${changed.map((item) => `${item.action}:${item.file}`).join(', ')}`);
  }
  return results;
}

if (isEntry(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const list = process.argv.includes('--list');
  runSelfheal({ dryRun, list });
}
