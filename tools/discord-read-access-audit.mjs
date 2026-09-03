#!/usr/bin/env node
// Bot が各チャンネルの発言を読めるか（View Channel + Read Message History）を実測する。
// 「Bot を招待済み」だけでは読めない。private チャンネルの @everyone deny は
// ロール個別の allow か Administrator でしか越えられないため、権限の穴を先に可視化する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_HISTORY = 1n << 16n;

export function summarizeAccess(results) {
  const total = results.length;
  const readable = results.filter((r) => r.status === 'readable').length;
  const forbidden = results.filter((r) => r.status === 'forbidden').length;
  const errored = results.filter((r) => r.status === 'error').length;
  return { total, readable, forbidden, errored, coverage: total ? Number((readable / total).toFixed(3)) : 0 };
}

export function missingPermissionNames(permissions) {
  const bits = BigInt(permissions || 0n);
  if (bits & ADMINISTRATOR) return [];
  const missing = [];
  if (!(bits & VIEW_CHANNEL)) missing.push('チャンネルを見る');
  if (!(bits & READ_HISTORY)) missing.push('メッセージ履歴を読む');
  return missing;
}

async function api(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0)' } });
  return response;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const guildId = value('--guild', '715211007307284530');
  const sample = Math.max(1, Number(value('--sample', 40)) || 40);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
    || fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim();
  if (!token) throw new Error('Discord Bot トークンが見つかりません');

  const me = await (await api(`${API}/users/@me`, token)).json();
  const guild = await (await api(`${API}/guilds/${guildId}`, token)).json();
  const memberResponse = await api(`${API}/guilds/${guildId}/members/${me.id}`, token);
  const member = memberResponse.ok ? await memberResponse.json() : null;
  const rolesResponse = await api(`${API}/guilds/${guildId}/roles`, token);
  const roles = rolesResponse.ok ? await rolesResponse.json() : [];
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const botRoles = (member?.roles || []).map((id) => roleById.get(id)).filter(Boolean);
  const guildPermissions = botRoles.reduce((acc, role) => acc | BigInt(role.permissions || 0), 0n);

  const channels = (await (await api(`${API}/guilds/${guildId}/channels`, token)).json()).filter((c) => [0, 5].includes(c.type));
  const snowflakeMs = (id) => Number(BigInt(id) >> 22n) + 1420070400000;
  const ordered = channels
    .filter((c) => c.last_message_id)
    .sort((a, b) => snowflakeMs(b.last_message_id) - snowflakeMs(a.last_message_id))
    .slice(0, sample);

  const results = [];
  for (const channel of ordered) {
    const response = await api(`${API}/channels/${channel.id}/messages?limit=1`, token);
    let status = 'readable';
    if (response.status === 403) status = 'forbidden';
    else if (!response.ok) status = 'error';
    else await response.json();
    results.push({ id: channel.id, name: channel.name, status, http: response.status });
    if (response.status === 429) await new Promise((r) => setTimeout(r, 1000));
  }

  const summary = summarizeAccess(results);
  console.log(JSON.stringify({
    bot: { id: me.id, username: me.username },
    guild: { id: guildId, name: guild.name, ownerId: guild.owner_id },
    botRoles: botRoles.map((r) => ({ id: r.id, name: r.name })),
    guildPermissions: guildPermissions.toString(),
    administrator: Boolean(guildPermissions & ADMINISTRATOR),
    missingGuildPermissions: missingPermissionNames(guildPermissions),
    textChannels: channels.length,
    ...summary,
    forbiddenSample: results.filter((r) => r.status === 'forbidden').slice(0, 10).map((r) => r.name),
    readableSample: results.filter((r) => r.status === 'readable').slice(0, 10).map((r) => r.name),
  }, null, 2));
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
