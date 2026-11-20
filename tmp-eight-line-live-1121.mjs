import fs from 'node:fs';
import { listChats, listMessages, searchMessages } from './tools/beeper-api.mjs';

function slimMsg(m) {
  const ts = m.timestamp || m.ts || m.sentAt || m.date || m.createdAt || '';
  const sender = m.senderName || m.sender?.name || m.sender || m.author || m.user?.name || '';
  const text = m.text || m.body || m.content?.text || (typeof m.content === 'string' ? m.content : '') || '';
  const id = m.id || m.messageID || '';
  return { id, ts, sender, text: String(text).slice(0, 2000), kind: m.type || m.messageType || '' };
}

const out = { at: new Date().toISOString(), chats: [], search: {}, messages: [] };
try {
  const chats = await listChats({ limit: 80 });
  const items = chats.items || chats.chats || chats.data || (Array.isArray(chats) ? chats : []);
  out.chatCount = items.length;
  out.chatKeys = chats && typeof chats === 'object' ? Object.keys(chats) : [];
  const hits = [];
  for (const c of items) {
    const title = c.title || c.name || c.chatName || '';
    const id = c.id || c.chatID || '';
    const preview = (c.lastMessage || c.snippet || c.preview || '');
    if (/エイト|8grp|いけなが|池永|森田|eight/i.test(JSON.stringify({ title, id, preview }))) {
      hits.push({ id, title, network: c.network || c.accountID || '', last: slimMsg(typeof preview === 'object' ? preview : { text: String(preview) }) });
    }
  }
  out.chats = hits;

  for (const q of ['入れ替えしました', 'エイト様', '課題企業', '興味を持']) {
    try {
      const r = await searchMessages(q, { limit: 10 });
      const arr = r.items || r.messages || r.data || (Array.isArray(r) ? r : []);
      out.search[q] = { keys: r && typeof r === 'object' ? Object.keys(r) : [], n: arr.length, sample: arr.slice(0, 5).map(slimMsg) };
    } catch (e) {
      out.search[q] = { error: e.message };
    }
  }

  const chatId = hits[0]?.id;
  if (chatId) {
    const msgs = await listMessages(chatId, { limit: 40 });
    const arr = msgs.items || msgs.messages || msgs.data || (Array.isArray(msgs) ? msgs : []);
    out.messages = arr.map(slimMsg);
    out.messageKeys = msgs && typeof msgs === 'object' ? Object.keys(msgs) : [];
  }
} catch (e) {
  out.error = e.message;
  out.code = e.code || '';
}
fs.writeFileSync('C:/Users/user/terminals/gb-eight-line-live-1121.json', JSON.stringify(out, null, 2), 'utf8');
console.log('wrote', out.chats.length, 'chats', out.messages.length, 'msgs', out.error || 'ok');
