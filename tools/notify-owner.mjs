#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { resolveOwner } from './lib/owner-identity.mjs';
export { resolveOwner } from './lib/owner-identity.mjs';

const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };


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
  const userId = options.userId ?? resolveOwnerDiscordId(owner, options);
  if (userId) return (options.notify ?? notifyKim)(text, { ...options, userId, webhookFallback: false });
  return (options.notify ?? notifyKim)(`宛先: ${owner || '不明'}（DM 未解決）\n${text}`, { ...options, userId: KIM_DISCORD_USER_ID, webhookFallback: false });
}
