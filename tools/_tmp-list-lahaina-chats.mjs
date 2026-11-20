import { listChats } from './beeper-api.mjs';

const needles = ['ラハイナ', '河本', '業務連絡', '引き継ぎ', '髙木', '高木', '黒田', '益田', 'lahaina', 'Lahaina', 'KAZUAKII', 'きむこん'];
function people(c) {
  const p = c.participants;
  const arr = Array.isArray(p) ? p : (p?.items || p?.chats || []);
  return arr.map(x => x.fullName || x.full_name || x.name || x.displayName || x.id);
}
const hits = [];
let cursor;
let pages = 0;
let total = 0;
do {
  const query = { limit: 100 };
  if (cursor) query.cursor = cursor;
  const res = await listChats(query);
  const arr = res.items || [];
  if (pages === 0) {
    const c0 = arr.find(x => x.participants) || arr[0];
    console.log('participantType', typeof c0.participants, 'keys', c0.participants && !Array.isArray(c0.participants) ? Object.keys(c0.participants) : 'array');
    console.log('previewKeys', c0.preview && Object.keys(c0.preview));
    console.log('samplePart', JSON.stringify(c0.participants).slice(0,500));
  }
  total += arr.length;
  for (const c of arr) {
    const title = String(c.title || '');
    const parts = people(c);
    const preview = (c.preview?.text || c.preview?.message || '').toString();
    const blob = [title, parts.join(' '), preview].join(' ');
    if (needles.some(n => blob.includes(n))) {
      hits.push({
        id: c.id,
        title,
        type: c.type,
        lastActivity: c.lastActivity,
        unread: c.unreadCount,
        preview: preview.slice(0,160),
        participants: parts.slice(0,15)
      });
    }
  }
  cursor = res.hasMore ? (res.oldestCursor || res.cursor) : null;
  pages++;
} while (cursor && pages < 50);
console.log('pages', pages, 'total', total, 'hits', hits.length);
console.log(JSON.stringify(hits, null, 2));
