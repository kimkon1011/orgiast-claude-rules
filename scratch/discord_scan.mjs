import fs from 'fs';
import os from 'os';
import path from 'path';

const tokenPath = path.join(os.homedir(), '.claude', 'orgiast-discord-bot-token.txt');
const token = fs.readFileSync(tokenPath, 'utf8').trim();
const UA = { 'Authorization': `Bot ${token}`, 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0)' };
const KIM_ID = '715210673642012733';
const threeDaysAgoMs = Date.now() - 3 * 24 * 60 * 60 * 1000;

function snowflakeToMs(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

async function get(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) {
    return { error: `${res.status} ${res.statusText}` };
  }
  return res.json();
}

async function main() {
  const guilds = await get('https://discord.com/api/v10/users/@me/guilds');
  if (guilds.error) { console.log(JSON.stringify({ error: 'guilds', detail: guilds })); return; }
  const results = [];
  let readable = 0;
  for (const g of guilds) {
    const channels = await get(`https://discord.com/api/v10/guilds/${g.id}/channels`);
    if (channels.error) continue;
    const textChannels = channels.filter(c => c.type === 0);
    for (const ch of textChannels) {
      const msgs = await get(`https://discord.com/api/v10/channels/${ch.id}/messages?limit=100`);
      if (msgs.error) continue;
      readable++;
      for (const m of msgs) {
        const ts = snowflakeToMs(m.id);
        if (ts < threeDaysAgoMs) continue;
        const mentioned = (m.mentions || []).some(u => u.id === KIM_ID);
        if (mentioned) {
          results.push({
            guildId: g.id, guildName: g.name, channelId: ch.id, channelName: ch.name,
            messageId: m.id, author: m.author?.username, content: (m.content || '').slice(0, 300),
            timestamp: m.timestamp,
            url: `https://discord.com/channels/${g.id}/${ch.id}/${m.id}`
          });
        }
      }
    }
  }
  console.log(JSON.stringify({ guildCount: guilds.length, readableChannels: readable, mentions: results }, null, 2));
}
main().catch(e => console.log(JSON.stringify({ error: String(e) })));
