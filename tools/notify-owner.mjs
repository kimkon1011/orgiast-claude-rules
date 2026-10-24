#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

export function resolveOwner({ home = os.homedir(), label = resolveFleetLabel(home), pcMap, gitEmail } = {}) {
  const map = pcMap ?? readJson(path.join(repo, 'fleet-pc-map.json'));
  const aliases = Object.entries(map).find(([, value]) => value && typeof value === 'object' && [value.hostname, value.sheetName, value.remoteName, ...(value.aliases || [])].includes(label));
  const configured = map[label] || aliases?.[1];
  if (configured?.account) return configured.account;
  try { return String(gitEmail ?? execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true })).trim(); } catch { return ''; }
}

export function resolveOwnerDiscordId(owner, { home = os.homedir(), directory } = {}) {
  const wanted = String(owner || '').trim().toLowerCase();
  const data = directory ?? readJson(path.join(home, '.claude', 'orgiast-discord-members.json'));
  const rows = Array.isArray(data) ? data : Object.values(data?.queries || data || {}).flatMap(v => Array.isArray(v?.members) ? v.members : []);
  const matches = [...new Set(rows.filter(row => wanted && (row.emails || []).some(email => String(email).toLowerCase() === wanted)).map(row => row.id).filter(Boolean).map(String))];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return '';
  const localOwner = resolveOwner({ home }).toLowerCase();
  return wanted && wanted === localOwner ? readText(path.join(home, '.claude', 'orgiast-discord-user-id.txt')) : '';
}

export async function notifyOwner(owner, text, options = {}) {
  owner = owner || resolveOwner(options);
  // Legacy rows may omit owner; the configured local DM still identifies its owner.
  if (!owner) {
    const localId = readText(path.join(options.home || os.homedir(), '.claude', 'orgiast-discord-user-id.txt'));
    if (localId) return (options.notify ?? notifyKim)(text, { ...options, userId: localId, webhookFallback: false });
  }
  const userId = options.userId ?? resolveOwnerDiscordId(owner, options);
  if (userId) return (options.notify ?? notifyKim)(text, { ...options, userId, webhookFallback: false });
  // 持ち主がそもそも未設定の PC では、kim へは実際に届く。従来は「宛先: 不明（DM 未解決）」と
  // 書いていたため、届いているのに未達に見える本文が通知・TODOへ流れていた（2026-10-25 実測）。
  const fallbackNote = owner ? `宛先: ${owner}（DM 未解決）` : '宛先: 不明（このPCの持ち主が未設定・kim へ送付）';
  return (options.notify ?? notifyKim)(`${fallbackNote}\n${text}`, { ...options, userId: KIM_DISCORD_USER_ID, webhookFallback: false });
}
