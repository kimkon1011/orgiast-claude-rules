import fs from 'node:fs';
import { listChats, listMessages } from './beeper-api.mjs';

function people(c) {
  const p = c.participants;
  const arr = Array.isArray(p) ? p : (p?.items || []);
  return arr.map(x => ({ name: x.fullName || x.name || x.id, isSelf: x.isSelf }));
}

function fmt(m) {
  return {
    id: m.id,
    ts: m.timestamp,
    sender: m.senderName || m.senderID,
    isSender: m.isSender,
    text: (m.text || '').toString().slice(0, 800)
  };
}

async function dump(chatID, label, limit=40) {
  const res = await listMessages(chatID, { limit });
  const items = (res.items || []).slice().sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
  return { label, chatID, count: items.length, hasMore: res.hasMore, messages: items.map(fmt) };
}

// also search chats for 益田
const masuda = [];
let cursor, pages=0;
do {
  const res = await listChats({ limit: 100, cursor });
  for (const c of (res.items||[])) {
    const title = String(c.title||'');
    const parts = people(c).map(p=>p.name).join(' ');
    if (title.includes('益田') || parts.includes('益田') || title.includes('妙子') || parts.includes('妙子') || title.includes('マスダ') || parts.includes('マスダ')) {
      masuda.push({ id:c.id, title, type:c.type, parts: people(c).map(p=>p.name), last:c.lastActivity });
    }
  }
  cursor = res.hasMore ? res.oldestCursor : null;
  pages++;
} while (cursor && pages < 50);

const a = await dump('!YEsQmu4evkHQzvpWmxXB:beeper.local', '業務連絡');
const b = await dump('!N4GtVKIFPZ010T8t0pK3:beeper.local', '株式会社ラハイナ');
const c = await dump('!0q3GETJBfU1pZOhobA6u:beeper.local', '河本DM', 20);

const out = { masuda, chats: [a,b,c] };
fs.writeFileSync('C:/Users/uers/agent-tools/lahaina-line-history.json', JSON.stringify(out, null, 2), 'utf8');
console.log('wrote history. masuda hits', masuda.length);
console.log(JSON.stringify(masuda,null,2));
console.log('業務連絡 msgs', a.count, 'first', a.messages[0]?.ts, 'last', a.messages.at(-1)?.ts);
console.log('ラハイナ msgs', b.count, 'first', b.messages[0]?.ts, 'last', b.messages.at(-1)?.ts);
console.log('河本DM msgs', c.count, 'first', c.messages[0]?.ts, 'last', c.messages.at(-1)?.ts);
