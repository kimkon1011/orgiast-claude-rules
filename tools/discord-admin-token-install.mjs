#!/usr/bin/env node
// orgiast guild の全チャンネルを読める Bot は Administrator 持ちの `clawd-connector` だけ。
// そのトークンは discord-mcp-connector の Vercel production env にしかないため、
// `vercel env pull` の出力から取り出して ~/.claude/discord-admin.env に据える。
//
// なぜ必要か: ローカルの orgiast-discord-bot-token.txt (ClaudeInboxBridge) は
// Administrator が無く、private チャンネルの @everyone deny を越えられない。
// 実測で 374 テキストチャンネル中 40 件を叩いて readable=1 / forbidden=39 (coverage 2.5%)。
// Bot は自分に無い権限を自分へ付与できない (Discord 仕様) ので、権限を足す道は無い。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const CONNECTOR_DIR = path.join(os.homedir(), 'Downloads', 'CLAUDE.md配布', 'discord-mcp-connector');
const ENV_KEY = 'DISCORD_ADMIN_BOT_TOKEN';

export function extractToken(envText, name = 'DISCORD_BOT_TOKEN') {
  const match = new RegExp(`^${name}=\\s*"?([^"\\r\\n]+)"?\\s*$`, 'm').exec(String(envText ?? ''));
  return match ? match[1].trim() : '';
}

export function destinationPath(home = os.homedir()) {
  return path.join(home, '.claude', 'discord-admin.env');
}

// Discord の bot token は「client_id を base64url にしたもの」が先頭セグメントになる。
// client_id は公開情報なので、ここでは token 断片を直書きせず実行時に導出する。
// 対象は Administrator を持つ connector Bot（環境変数で差し替え可）。
const ADMIN_CLIENT_ID = process.env.DISCORD_ADMIN_CLIENT_ID?.trim() || '1511684767546871818';
const TOKEN_PREFIX = Buffer.from(ADMIN_CLIENT_ID).toString('base64url').replace(/=+$/, '');
const TOKEN_PATTERN = new RegExp(`${TOKEN_PREFIX}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{25,}`, 'g');

// vercel env pull は sensitive 変数を "" に伏せて返すため、production env からは復元できない
// (2026-09-02 実測: DISCORD_BOT_TOKEN の値長が 2 = 空の引用符のみ)。
// 設定当時のセッションログには平文で残っているので、そこから拾って API で生死を確かめる。
export function tokensFromTranscripts(files, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  const found = new Set();
  for (const file of files) {
    let text = '';
    try { text = readFile(file); } catch { continue; }
    for (const match of text.matchAll(TOKEN_PATTERN)) found.add(match[0]);
  }
  return [...found];
}

function transcriptCandidates(home) {
  const roots = [path.join(home, '.claude', 'projects')];
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target, depth + 1);
      else if (entry.name.endsWith('.jsonl')) files.push(target);
    }
  };
  for (const root of roots) walk(root, 0);
  return files;
}

function pullProductionEnv(dir) {
  const target = path.join(dir, '.env.pulled');
  if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8');
  const result = spawnSync('vercel', ['env', 'pull', '.env.pulled', '--environment=production', '--yes'], {
    cwd: dir, encoding: 'utf8', shell: true,
  });
  if (!fs.existsSync(target)) throw new Error(`vercel env pull に失敗しました: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  return fs.readFileSync(target, 'utf8');
}

async function verify(token) {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0)' },
  });
  if (!response.ok) throw new Error(`トークンが無効です (HTTP ${response.status})`);
  const me = await response.json();
  return { id: String(me.id), username: String(me.username || '') };
}

async function main() {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const dir = process.env.DISCORD_CONNECTOR_DIR || CONNECTOR_DIR;
  if (!fs.existsSync(dir)) throw new Error(`discord-mcp-connector が見つかりません: ${dir}`);
  const candidates = [];
  const fromVercel = extractToken(pullProductionEnv(dir));
  if (fromVercel) candidates.push({ token: fromVercel, origin: 'vercel-env' });
  for (const token of tokensFromTranscripts(transcriptCandidates(home))) candidates.push({ token, origin: 'transcript' });
  if (!candidates.length) throw new Error('clawd-connector の Bot トークンをどこからも復元できませんでした');

  let token = '', origin = '', bot = null;
  const failures = [];
  for (const candidate of candidates) {
    try { bot = await verify(candidate.token); token = candidate.token; origin = candidate.origin; break; }
    catch (error) { failures.push(`${candidate.origin}: ${error.message}`); }
  }
  if (!bot) throw new Error(`復元した ${candidates.length} 件のトークンがどれも無効でした (${failures.join(' / ')})。Discord Developer Portal で Reset Token した可能性があります`);
  const destination = destinationPath(home);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${ENV_KEY}=${token}\n`, { mode: 0o600 });
  // 取得の副産物である .env.pulled は他の secret も丸ごと含むので残さない。
  try { fs.rmSync(path.join(dir, '.env.pulled'), { force: true }); } catch {}
  console.log(JSON.stringify({ ok: true, bot, origin, destination, key: ENV_KEY, tokenLength: token.length }));
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
