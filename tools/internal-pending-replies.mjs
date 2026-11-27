#!/usr/bin/env node
// 社内の人の質問・返事で、こちらが返していないものを洗い出す CLI（読むだけ・送信しない）。
//
// 背景（kim 2026-11-27）: 労働審判の陳述書署名で、古川さんが 2026-11-26 18:19 に
// Discord DM で「自筆の署名も必要か」と質問したのに、11/27 19:53 まで返事が出なかった。
// 監視スクリプトは「写真が届いたか」だけを見て、自動返信は添付の取得失敗で kim-inbox
// （金さんの確認待ち）へ回し、その kim-inbox は誰にも表示されないまま止まっていた。
// このツールは「相手が何を聞いているか・何を待っているか」を毎回の見回りで拾うための入口。
// 見つかったものは、見回りの回のうちに AI が返事まで送る（rules/internal-reply-push.md）。
//
// 使い方:
//   node tools/internal-pending-replies.mjs [--min-minutes 30] [--max-days 7] [--out-dir <dir>] [--json]
// 出力: <out-dir>/internal-pending.json と latest-internal-pending.md（既定 ~/gb-reports）
// exit: 0 = 未返信なし / 3 = 未返信あり / 2 = Beeper に接続できない
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_EXCLUDE_TITLES = [
  'clawd-connector', 'orgiast-sales-report', 'Grok Bot', 'ChatGPT', 'Muse',
];
// 質問・依頼・確認待ちの言い回し（日本語の社内連絡で多いもの）
export const ASK_RX = /[?？]|ですか|ますか|でしょうか|よろしい|いいですか|良いですか|大丈夫です(か|でしょう)|どう(しますか|すれば|したら)|ください|下さい|お願い(します|いたします|致します|できますか)|ご確認|確認(お願い|して|ください)|ご指示|ご判断|教えて|いかが|必要(です)?か|かな[？?]?$/m;
// 返事が要らない締めのあいさつだけの発言
export const CLOSING_ONLY_RX = /^(了解(です|しました|いたしました|致しました)?|承知(しました|いたしました|致しました)|かしこまりました|ありがとうございます|ありがとうございました|よろしくお願い(します|いたします|致します)|お疲れ様です|お疲れさまです|はーい|はい|OKです|おけです|確認しました)[!！。.\s]*$/;

export function plain(text = '') {
  return String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
}
const ts = m => Date.parse(m?.timestamp || 0) || 0;

export function isAsk(text) {
  const t = plain(text);
  if (!t) return false;
  if (CLOSING_ONLY_RX.test(t)) return false;
  return ASK_RX.test(t);
}

// 1つの会話について、最後の自分の発言より後に来た相手の発言を見て、未返信なら1件返す。
export function pendingFromChat(chat, messages, { now = Date.now(), minMinutes = 30, maxDays = 7, excludeTitles = DEFAULT_EXCLUDE_TITLES, kimInboxOpen = new Map() } = {}) {
  const title = chat.title || '';
  if (excludeTitles.some(x => x && title.includes(x))) return null;
  const sorted = [...messages].filter(m => !m.isDeleted && !m.isHidden).sort((a, b) => ts(a) - ts(b));
  if (!sorted.length) return null;
  const lastSelfIdx = sorted.map(m => !!m.isSender).lastIndexOf(true);
  const inbound = sorted.slice(lastSelfIdx + 1).filter(m => !m.isSender);
  if (!inbound.length) return null;
  const latest = inbound.at(-1);
  const ageMin = (now - ts(latest)) / 60000;
  if (ageMin < minMinutes || ageMin > maxDays * 1440) return null;
  // グループは金さん宛て（メンション）の発言だけを対象にする（社員どうしのやり取りは拾わない）
  const toKim = m => /金功勇|きむこん|kimkon1011/.test(String(m.text || '')) || m.mentionsSelf || (m.mentions || []).some(x => /kimkon1011|715210673642012733/.test(String(x)));
  const relevant = chat.type === 'group' ? inbound.filter(toKim) : inbound;
  if (!relevant.length) return null;
  const asks = relevant.filter(m => isAsk(m.text));
  const attachments = relevant.reduce((n, m) => n + (m.attachments?.length || 0), 0);
  const inboxItem = relevant.map(m => kimInboxOpen.get(`${chat.id}:${m.id}`)).find(Boolean) || null;
  if (!asks.length && !inboxItem) return null;
  return {
    chatID: chat.localChatID || chat.id, roomID: chat.id, title, type: chat.type || '',
    network: chat.network || chat.accountID || '',
    latestAt: latest.timestamp, waitingMinutes: Math.round(ageMin),
    reason: inboxItem ? `kim-inbox で止まっている（${inboxItem.id}・${inboxItem.reason || '判断待ち'}）` : '相手の質問・依頼に未返信',
    kimInboxId: inboxItem?.id || null,
    attachments,
    asks: (asks.length ? asks : relevant).slice(-4).map(m => ({ id: m.id, at: m.timestamp, sender: m.senderName || '', text: plain(m.text).slice(0, 400) })),
  };
}

// kim-inbox の「Discord 判断待ち」で未回答のものを chatRoomID:messageID → item で返す
export function readKimInboxOpen(home, { maxDays = 7, now = Date.now() } = {}) {
  const dir = path.join(home, '.claude', 'kim-inbox');
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let item; try { item = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (item.status !== 'open' || !/discord/.test(item.source || '')) continue;
    if (now - Date.parse(item.createdAt || 0) > maxDays * 86400000) continue;
    const m = /^decision:[^:]+:(.+):([^:]+)$/.exec(item.dedupeKey || '');
    if (!m) continue;
    const reason = /判断理由: ([^\n]+)/.exec(item.text || '')?.[1] || '';
    map.set(`${m[1]}:${m[2]}`, { id: item.id, reason });
  }
  return map;
}

export function renderMarkdown(items, { now = Date.now() } = {}) {
  const jst = new Date(now + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
  const lines = [`# 社内の未返信（質問・依頼）${jst} JST  ${items.length}件`, '',
    '見回りの回のうちに、AI が返事まで送る（社内は確認不要・rules/internal-reply-push.md）。金さんにしか決められないことだけ、返事で「確認して○時までに返します」と伝えたうえで金さんに聞く。', ''];
  for (const it of items) {
    lines.push(`## ${it.title}（chat ${it.chatID}・${Math.round(it.waitingMinutes / 6) / 10}時間待ち）`);
    lines.push(`- 理由: ${it.reason}${it.attachments ? `／添付 ${it.attachments}件（中身を開いて確かめる）` : ''}`);
    for (const a of it.asks) lines.push(`- ${new Date(Date.parse(a.at) + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' ')} ${a.sender}: ${a.text.replace(/\n+/g, ' ')}`);
    lines.push('');
  }
  if (!items.length) lines.push('未返信はありません。');
  return lines.join('\n') + '\n';
}

async function main(argv = process.argv.slice(2)) {
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const minMinutes = Number(val('--min-minutes', 30));
  const maxDays = Number(val('--max-days', 7));
  const home = os.homedir();
  const outDir = val('--out-dir', process.env.GB_REPORTS || path.join(home, 'gb-reports'));
  let api;
  try { api = await import('./beeper-api.mjs'); } catch (e) { console.error(`beeper-api を読めません: ${e.message}`); return 2; }
  const now = Date.now();
  const kimInboxOpen = readKimInboxOpen(home, { maxDays, now });
  const items = [];
  try {
    const accts = await api.getAccounts();
    const list = Array.isArray(accts) ? accts : (accts.items || accts.accounts || []);
    const discord = list.filter(a => /discord/i.test(`${a.network || ''} ${a.accountID || ''}`));
    for (const a of discord) {
      let cursor;
      for (let page = 0; page < 20; page++) {
        const r = await api.listChats({ limit: 50, cursor, accountIDs: [a.accountID] });
        const chats = r.items || [];
        let old = false;
        for (const c of chats) {
          const last = Date.parse(c.lastActivity || c.preview?.timestamp || 0);
          if (last && now - last > maxDays * 86400000) { old = true; continue; }
          if (c.preview && c.preview.isSender) continue;
          let msgs = [];
          try { const m = await api.listMessages(c.id, { limit: 20 }); msgs = m.items || m.messages || []; } catch { continue; }
          const it = pendingFromChat({ ...c, network: a.network || 'Discord' }, msgs, { now, minMinutes, maxDays, kimInboxOpen });
          if (it) items.push(it);
        }
        if (old || !r.hasMore || !r.oldestCursor) break;
        cursor = r.oldestCursor;
      }
    }
  } catch (e) {
    console.error(`Beeper に接続できません: ${e.message}`);
    return 2;
  }
  items.sort((x, y) => y.waitingMinutes - x.waitingMinutes);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'internal-pending.json'), JSON.stringify({ checkedAt: new Date(now).toISOString(), items }, null, 2));
  const md = renderMarkdown(items, { now });
  fs.writeFileSync(path.join(outDir, 'latest-internal-pending.md'), md);
  if (argv.includes('--json')) console.log(JSON.stringify(items, null, 2)); else console.log(md);
  return items.length ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
