#!/usr/bin/env node
// GitHub 配布正本を CLAUDE.md の専用ブロックへ同期する。hookを壊さないため失敗は握る。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const targetArg = args.find((x) => x.startsWith('--target='));
const home = process.env.ORGIAST_HOME || os.homedir();
const target = targetArg ? targetArg.slice(9) : path.join(home, '.claude', 'CLAUDE.md');
const statePath = path.join(home, '.claude', '.onboarding-sync-state.json');
const logPath = path.join(home, '.claude', 'hooks', 'onboarding-sync.log');
const rawUrl = process.env.ORGIAST_ONBOARDING_URL || 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md';
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
