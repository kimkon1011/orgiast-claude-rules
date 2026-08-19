#!/usr/bin/env node
// GitHub 配布正本を CLAUDE.md の専用ブロックへ同期する。hookを壊さないため失敗は握る。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const targetArg = args.find((x) => x.startsWith('--target='));
const home = process.env.ORGIAST_HOME || os.homedir();
const target = targetArg ? targetArg.slice(9) : path.join(home, '.claude', 'CLAUDE.md');
const statePath = path.join(home, '.claude', '.onboarding-sync-state.json');
const repoStatePath = path.join(home, '.claude', '.repo-sync-state.json');
const keysStatePath = path.join(home, '.claude', '.keys-sync-state.json');
const repoPath = path.join(home, 'orgiast-claude-rules');
const logPath = path.join(home, '.claude', 'hooks', 'onboarding-sync.log');
const rawUrl = process.env.ORGIAST_ONBOARDING_URL || 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md';
const keyserveUrl = process.env.ORGIAST_KEYSERVE_URL || 'https://orgiast-keyserve.vercel.app/api/keys';
const beginPrefix = '<!-- BEGIN: オージャスト共通ルール';
const endMarker = '<!-- END: オージャスト共通ルール -->';

function log(message) {
  if (dryRun) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    let old = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    if (old.length > 10240) old = old.slice(-8192);
    const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).replace(',', '');
    fs.writeFileSync(logPath, `${old.replace(/[\r\n]+$/, '')}${old ? '\n' : ''}${stamp}\t${message}`, 'utf8');
  } catch {}
}
function state() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } }
function repoState() { try { return JSON.parse(fs.readFileSync(repoStatePath, 'utf8')); } catch { return null; } }
function keysState() { try { return JSON.parse(fs.readFileSync(keysStatePath, 'utf8')); } catch { return null; } }
function saveRepoState(now) {
  if (dryRun) return;
  try { fs.mkdirSync(path.dirname(repoStatePath), { recursive: true }); fs.writeFileSync(repoStatePath, `${JSON.stringify({ last: now.toISOString() }, null, 2)}\n`, 'utf8'); } catch {}
}
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
async function syncRepository(now) {
  try {
    if (!fs.existsSync(repoPath)) return;
    const previous = repoState();
    if (!force && previous?.last && now - new Date(previous.last) < 24 * 60 * 60 * 1000) return;
    if (dryRun) { console.log(`[dry-run] リポ日次更新対象: ${repoPath} (書き込み・取得なし)`); return; }
    saveRepoState(now);
    // バックアップはリポ外(~/.claude/repo-backups)に置く: リポ内だと git status を汚し、毎日積み上がる
    const backupRoot = path.join(home, '.claude', 'repo-backups');
    const backup = path.join(backupRoot, `tools.bak-${now.toISOString().slice(0, 10)}`);
    if (fs.existsSync(path.join(repoPath, 'tools')) && !fs.existsSync(backup)) copyTree(path.join(repoPath, 'tools'), backup);
    // 直近3世代だけ残す(古いものから削除)
    try {
      const olds = fs.readdirSync(backupRoot).filter((n) => n.startsWith('tools.bak-')).sort();
      for (const old of olds.slice(0, Math.max(0, olds.length - 3))) fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true });
    } catch {}
    let changed = false;
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      const before = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 60000 }).trim();
      execFileSync('git', ['-C', repoPath, 'pull', '--ff-only'], { stdio: 'pipe', timeout: 60000 });
      const after = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 60000 }).trim();
      changed = before !== after;
    } else {
      const response = await fetch('https://github.com/kimkon1011/orgiast-claude-rules/archive/refs/heads/main.zip', { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`repo zip HTTP ${response.status}`);
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-repo-sync-'));
      const zip = path.join(temp, 'main.zip'); fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
      const expanded = path.join(temp, 'expanded'); fs.mkdirSync(expanded);
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', zip, '-DestinationPath', expanded, '-Force'], { timeout: 60000 });
      else execFileSync('unzip', ['-q', zip, '-d', expanded], { timeout: 60000 });
      const root = path.join(expanded, 'orgiast-claude-rules-main');
      for (const name of ['tools', 'rules-extracted', 'skills']) if (fs.existsSync(path.join(root, name))) copyTree(path.join(root, name), path.join(repoPath, name));
      changed = true;
    }
    if (changed) { console.log('[onboarding-sync] updated repository tools/rules/skills'); log('updated repository tools/rules/skills'); }
    // 新しく配布された hook を全PCへ自動登録する(add-only・差分が無ければ何も書かない)。
    try {
      const registrar = path.join(repoPath, 'tools', 'register-hooks.mjs');
      if (fs.existsSync(registrar)) {
        const out = execFileSync(process.execPath, [registrar, '--hooks-only'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repoPath } }).trim();
        if (out.includes('追加')) { console.log(`[onboarding-sync] ${out.trim()}`); log(out.replace(/\s+/g, ' ')); }
      }
    } catch (e) { log(`hook registration failed: ${e.message}`); }
  } catch (e) { log(`repo sync failed: ${e.message}`); }
}
function readEnvValue(file, name) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] !== name) continue;
      const value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
      return value;
    }
  } catch {}
  return '';
}
function saveKeysState(now) {
  try {
    fs.mkdirSync(path.dirname(keysStatePath), { recursive: true });
    fs.writeFileSync(keysStatePath, `${JSON.stringify({ last: now.toISOString() }, null, 2)}\n`, 'utf8');
  } catch {}
}
async function provisionKeys(now) {
  if (dryRun) return;
  const previous = keysState();
  if (!force && previous?.last && now - new Date(previous.last) < 24 * 60 * 60 * 1000) return;
  let secret = process.env.ORGIAST_KEYSERVE_SECRET || '';
  if (!secret) secret = readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET');
  if (!secret) {
    secret = readEnvValue(path.join(home, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK');
    if (secret) log('legacy secret を使用中（keyserve.env 未受領）');
  }
  if (!secret) return;
  try {
    const ts = Math.floor(Date.now() / 1000).toString();
    const auth = crypto.createHmac('sha256', secret).update(ts).digest('hex');
    const response = await fetch(keyserveUrl, {
      method: 'POST',
      headers: { 'x-orgiast-ts': ts, 'x-orgiast-auth': auth },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload.files !== 'object' || payload.files === null || Array.isArray(payload.files)) throw new Error('invalid response');
    const provisioned = [];
    for (const [name, contents] of Object.entries(payload.files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..') || typeof contents !== 'string') continue;
      const destination = path.join(home, '.claude', name);
      if (fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      provisioned.push(name);
      log(`provisioned: ${name}`);
    }
    saveKeysState(now);
    if (provisioned.length) console.log(`[onboarding-sync] provisioned: ${provisioned.join(', ')}`);
  } catch (e) {
    log(`key provisioning failed: ${e.message}`);
  }
}
function save(hash, now) {
  if (dryRun) return;
  try { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, `${JSON.stringify({ lastCheck: now.toISOString(), hash }, null, 2)}\n`, 'utf8'); } catch {}
}
function build(current, body, label) {
  const block = `${beginPrefix} (自動同期 ${label}) -->\n${body}\n${endMarker}`;
  if (current === null) return { updated: block, action: '新規作成' };
  const lines = current.split(/\r?\n/);
  let begin = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // 行全体が開始マーカー形式そのものである場合だけ対象にする。
    if (begin < 0 && line.startsWith(beginPrefix) && line.endsWith('-->')) { begin = i; continue; }
    if (begin >= 0 && line === endMarker) { end = i; break; }
  }
  if (begin >= 0 && end >= 0) return { updated: [...lines.slice(0, begin), block, ...lines.slice(end + 1)].join('\n'), action: `行 ${begin + 1}-${end + 1} を置換` };
  return { updated: `${current.replace(/[\r\n]+$/, '')}\n\n${block}`, action: 'マーカーなし/不完全のため末尾へ追記' };
}

try {
  const now = new Date();
  await syncRepository(now);
  await provisionKeys(now);
  const oldState = state();
  if (!force && !dryRun && oldState?.lastCheck && now - new Date(oldState.lastCheck) < 20 * 60 * 60 * 1000) process.exit(0);
  let body;
  try {
    const response = await fetch(rawUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.text();
  } catch (e) { log(`fetch failed: ${e.message}`); process.exit(0); }
  if (!body) { log('fetch returned empty body, skip'); process.exit(0); }
  body = body.replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  if (!dryRun && oldState?.hash === hash) { save(hash, now); process.exit(0); }
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const result = build(current, body.replace(/\n$/, ''), now.toISOString().slice(0, 10));
  if (dryRun) {
    console.log(`[dry-run] 対象: ${target}`);
    console.log(`[dry-run] 変更: ${result.action}`);
    console.log(`[dry-run] hash: ${hash.slice(0, 8)} / 書き込み・バックアップ・state更新なし`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (current !== null) fs.copyFileSync(target, `${target}.bak.${now.toISOString().replace(/[-:T]/g, '').slice(0, 15)}`);
    fs.writeFileSync(target, result.updated, 'utf8');
    save(hash, now);
    console.log(`[onboarding-sync] updated CLAUDE.md (hash ${hash.slice(0, 8)})`);
    log(`updated (hash ${hash.slice(0, 8)})`);
  }
} catch (e) { log(`unexpected error: ${e.message}`); }
