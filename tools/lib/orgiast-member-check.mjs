import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ORGIAST_GUILD_ID = '715211007307284530';
const readCache = file => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

export async function isOrgiastMember(userId, {
  token, fetchImpl = fetch, home = os.homedir(), now = Date.now(),
  ttlMs = 6 * 60 * 60 * 1000, persistCache = true,
} = {}) {
  if (typeof userId !== 'string' || !/^\d{15,22}$/.test(userId)) return null;
  const cacheFile = path.join(home, '.claude', 'orgiast-guild-member-cache.json');
  const entry = readCache(cacheFile)[userId];
  const age = now - Date.parse(entry?.fetched_at);
  if (typeof entry?.member === 'boolean' && age >= 0 && age < ttlMs) return entry.member;
  token = token?.trim() || process.env.DISCORD_BOT_TOKEN?.trim()
    || (() => { try { return fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim(); } catch { return ''; } })();
  if (!token) return null;
  let member;
  try {
    const response = await fetchImpl(`https://discord.com/api/v10/guilds/${ORGIAST_GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000),
    });
    member = response.status === 200 ? true : response.status === 404 ? false : null;
  } catch { return null; } // Never expose a credential-bearing fetch error.
  if (member !== null && persistCache) {
    try {
      const cache = readCache(cacheFile);
      cache[userId] = { member, fetched_at: new Date(now).toISOString() };
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    } catch { /* Cache persistence failure must not expose credentials. */ }
  }
  return member;
}
