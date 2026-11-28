import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const norm = value => String(value ?? '').normalize('NFKC').trim();
const groups = {
  write: /書[くいき]|記入|書き込/,
  submit: /投函|出[すし]|窓口|ポスト|提出|持って行|持参|届け/,
  place: /置[くいき]|入れ|しま[ういっ]|保管|持ち帰|戻[すし]/,
  send: /送[るっり]|送付|郵送/,
};
const done = /書いた|書きました|記入済|記入しました|済み|済|投函しておきます|投函しました|出しました|出しておきます|提出しました|完了|入れて(?:い)?ます|入れました|置いて(?:い)?ます|置きました|しまいました|持って行きました|送りました|保管して(?:い)?ます/;
const stopWords = new Set(['今日','明日','明後日','昨日','変更','訂正','正しく','大丈夫','お願い','確認','連絡','写真','画像','説明','書類','右上','手書き','記入','記入済','提出','提出済','投函','投函済','完了','窓口','ポスト','郵送','送付','法務局','郵便局','上段','下段','保管','番号','乙第','号証']);
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
function keywords(text) {
  const words = [...norm(text).matchAll(/乙第\d+号証|控え|置き場所|[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}|[A-Za-z0-9]{2,}/gu)].map(m => m[0]);
  for (const { segment, isWordLike } of segmenter.segment(norm(text))) if (isWordLike && segment.length >= 2 && /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(segment)) words.push(segment);
  return new Set(words.filter(w => !stopWords.has(w) && !Object.values(groups).some(re => re.test(w)) && !/^\d+$/.test(w)));
}
const commonObject = (a, b) => [...keywords(a)].some(w => keywords(b).has(w));
const actions = text => Object.keys(groups).filter(key => groups[key].test(text));
const sameAction = (a, b) => actions(a).some(g => actions(b).includes(g));
const directive = text => /ください|くれ|お願い|してね|送ってね|しておいて|書く|記入|投函|提出|コピー|持って行|持ち帰|入れ|置[くい]|送[るっ]|出して/.test(text)
  && !(/ました|済み|承知|了解|ありがとう/.test(text) && !/ください|くれ|お願い|してね|送ってね|しておいて/.test(text));

export function splitInstructions(draft) {
  return String(draft ?? '').replace(/[(（][^()（）\n]*AI[^()（）\n]*(?:代理|返信)[^()（）\n]*[)）]/gi, '')
    .split(/\r?\n|。/).map(s => s.replace(/^\s*(?:\d+[.．、)]|[・●\-])\s*/, '').trim()).filter(Boolean);
}

function dateParts(text, base) {
  const t = norm(text); const date = new Date(base); const jst = new Date(date.getTime() + 9 * 3600000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth(), d = jst.getUTCDate();
  const stamp = offset => new Date(Date.UTC(y, m, d + offset)).toISOString().slice(0, 10);
  let day;
  const relative = t.match(/明後日|明日|今日/);
  const explicit = t.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  const weekday = t.match(/([日月火水木金土])曜/);
  if (Number.isFinite(date.getTime())) {
    if (relative) day = stamp({ 今日: 0, 明日: 1, 明後日: 2 }[relative[0]]);
    else if (explicit) day = `${explicit[1] || y}-${explicit[2].padStart(2, '0')}-${explicit[3].padStart(2, '0')}`;
    else if (weekday) day = stamp(('日月火水木金土'.indexOf(weekday[1]) - jst.getUTCDay() + 7) % 7);
  }
  const time = t.match(/(?:(午前|午後)\s*)?(\d{1,2})(?:時(?:(\d{1,2})分|(半))?|:(\d{2}))/);
  return { day, time: time ? ((time[1] ? Number(time[2]) % 12 : Number(time[2])) + (time[1] === '午後' ? 12 : 0)) * 60 + Number(time[3] || time[5] || (time[4] ? 30 : 0)) : undefined };
}
function quantities(text) {
  return norm(text).split(/[、,。;\n・]|と(?=[\p{Script=Han}\p{Script=Katakana}])/u).flatMap(clause => {
    let previous = 0;
    return [...clause.matchAll(/(\d+)\s*(部数|部|枚|通|冊|個)/g)].map(m => {
      const object = clause.slice(previous, m.index); previous = m.index + m[0].length;
      return { number: Number(m[1]), unit: m[2], object };
    });
  });
}
function address(text) {
  const t = norm(text).replace(/[‐‑‒–—―−ー]/g, '-').replace(/\s/g, '');
  return { postal: t.match(/〒?(\d{3}-\d{4})/)?.[1], street: t.match(/(?:東京都|北海道|(?:京都|大阪)府|[^。、:「」]{2,3}県)[^。、「」]*?\d+(?:丁目|番地?|号|-)\d+(?:(?:番地?|号|-)[\d]+)?/)?.[0] };
}

function sameScope(a, b, kind) {
  const objects = text => {
    let value = norm(text).replace(/\s/g, '').replace(/[‐‑‒–—―−ー]/g, '-');
    if (kind === 'address') {
      const parsed = address(value);
      for (const part of Object.values(parsed)) if (part) value = value.replace(part, '');
      value = value.replace(/住所|郵便番号|訂正|正しくは|変わりました|送って|送付/g, '');
    }
    value = value.replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日|明後日|明日|今日|[日月火水木金土]曜日?|(?:午前|午後)?\d{1,2}(?:時(?:\d{1,2}分|半)?|:\d{2})|変えて|にして|変更|ずらして|日時|指定|予定/g, '');
    return keywords(value);
  };
  const x = objects(a), y = objects(b);
  return !x.size || !y.size || [...x].some(w => y.has(w));
}

export function normalizeHistory(messages, { chatID, chatTitle } = {}) {
  return messages.map(m => ({ ...m, chatID: m.chatID ?? chatID, chatTitle: m.chatTitle ?? chatTitle ?? chatID,
    at: m.at ?? m.timestamp, senderID: m.senderID ?? m.senderId, senderName: m.senderName ?? m.sender,
    isSender: m.isSender ?? m.side === 'self', text: m.text ?? '', attachments: m.attachments ?? [] }));
}

export function checkPreSendReply({ draft, messages = [], now = Date.now(), windowHours = 24 }) {
  const findings = [], sentences = splitInstructions(draft);
  const end = new Date(now).getTime(), start = end - windowHours * 3600000;
  const others = normalizeHistory(messages).filter(m => !m.isSender && (!m.at || (Date.parse(m.at) >= start && Date.parse(m.at) <= end))).sort((a,b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const readable = m => [m.text, ...m.attachments.map(a => a.description)].filter(Boolean).join('\n');
  const add = (code, sentence, m, reason, remove = false) => findings.push({ code, sentence,
    conflictWith: { chatID: m.chatID, chatTitle: m.chatTitle, at: m.at, senderName: m.senderName, text: readable(m) },
    fix: `${remove ? 'その文を削る' : '相手の発言に合わせる'}。${reason}` });
  const dateMessages = [...others].reverse().filter(m => /変えて|にして|変更|ずらして|日時は/.test(readable(m)) && Object.values(dateParts(readable(m), m.at || now)).some(v => v !== undefined));
  const addressMessages = [...others].reverse().filter(m => /住所は|正しくは|訂正|変わりました|〒/.test(readable(m)) && Object.values(address(readable(m))).some(Boolean));
  for (const m of others) {
    const content = norm(readable(m));
    // 「ここ」は画像を参照するキャプションであり、場所を読み取った説明ではない。
    if (m.attachments.some(a => !norm(a.description) && (!norm(m.text) || /ここ.*(?:入れて|置いて)/.test(m.text)))) {
      add('UNREAD_IMAGE', '', m, `未読の画像あり: ${m.chatTitle} ${m.at} ${m.senderName}。画像を開いて説明を付けてから再チェック`);
    }
    for (const sentence of sentences) {
      const s = norm(sentence), shared = commonObject(content, s);
      const committed = /しておきます/.test(content);
      if (directive(s) && shared && sameAction(content, s) && done.test(content)) add('DONE_REINSTRUCTED', sentence, m, committed ? '相手が引き受け済みです' : '相手が実施済みです', true);
      // 引受だけで対象名を省略した返答も、同系統の方法変更なら保留する。
      if (directive(s) && committed && sameAction(content, s) && (shared || keywords(content).size === 0) && /今日中|明日|窓口で|ポストで|郵便局で/.test(s)) add('METHOD_CHANGE_AFTER_COMMIT', sentence, m, `相手が引き受け済み: ${m.text}`);
      if (directive(s) && shared && /入れて|入れました|置いて|置きました|保管|置き場所|上段|下段/.test(content) && groups.place.test(s)) {
        const places = t => [...t.matchAll(/(?:[\p{Script=Han}\p{Script=Katakana}ー]{2,})(?:の(?:上段|下段))?(?=に|へ|で)|上段|下段/gu)].map(x => x[0]);
        if (/持ち帰|戻して/.test(s) || places(s).some(p => !places(content).includes(p))) add('PLACEMENT_CONFLICT', sentence, m, '記録された置き場所と異なる指示です');
      }
      if (m === dateMessages.find(row => sameScope(readable(row), s, 'date'))) {
        const a = dateParts(content, m.at || now), b = dateParts(s, now);
        if (['day','time'].some(k => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k])) add('DATETIME_CONFLICT', sentence, m, '最新の日時指定を反映してください');
      }
      if (quantities(content).some(a => quantities(s).some(b => a.unit === b.unit && a.number !== b.number && commonObject(a.object, b.object)))) add('QUANTITY_CONFLICT', sentence, m, '相手の数量指定と異なります');
      if (m === addressMessages.find(row => sameScope(readable(row), s, 'address'))) {
        const a = address(content), b = address(s);
        if (['postal','street'].some(k => a[k] && b[k] && a[k] !== b[k])) add('ADDRESS_CONFLICT', sentence, m, '最新の郵便番号・住所を反映してください');
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

const items = result => Array.isArray(result) ? result : result?.items || [];
const participants = chat => items(chat?.participants);
export async function collectBeeperContext({ chatID, now = Date.now(), windowHours = 24, api, saveDir, imageNotes = {} }) {
  api ||= await import('../beeper-api.mjs');
  const end = new Date(now).getTime(), start = end - windowHours * 3600000;
  if (!Number.isFinite(end) || !Number.isFinite(windowHours) || windowHours <= 0) throw new Error('履歴の取得期間が不正です');
  const recent = m => { const at = Date.parse(m.timestamp ?? m.at); return Number.isFinite(at) && at >= start && at <= end; };
  async function readMessages(id) {
    const rows = [], seen = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await api.listMessages(id, { limit: 100, direction: 'before', ...(cursor ? { cursor } : {}) });
      const batch = items(result); rows.push(...batch);
      if (!result.hasMore || batch.some(m => Date.parse(m.timestamp ?? m.at) < start)) return rows.filter(recent);
      cursor = result.oldestCursor;
      if (!cursor || seen.has(cursor)) throw new Error('Beeper履歴の続きが取得できません');
      seen.add(cursor);
    }
    throw new Error('Beeper履歴の上限を超えました');
  }
  const target = await api.getChat(chatID), targetMessages = await readMessages(chatID);
  const selfIDs = new Set([...participants(target).filter(p => p.isSelf || p.isSender).map(p => p.id ?? p.senderID), ...targetMessages.filter(m => m.isSender).map(m => m.senderID)].filter(Boolean));
  const keys = p => [p.senderID ?? p.id, norm(p.senderName ?? p.fullName ?? p.displayName ?? p.name)].filter(Boolean);
  const peers = new Set([...participants(target), ...targetMessages].filter(p => !p.isSelf && !p.isSender && !selfIDs.has(p.senderID ?? p.id)).flatMap(keys));
  const selected = [{ chat: { ...target, id: chatID }, rows: targetMessages }];
  for (const chat of items(await api.listChats({ limit: 50 }))) {
    // 過去時刻の再現でも、現在の最終活動が未来という理由で関連チャットを除外しない。
    const lastActivity = Date.parse(chat.lastActivity ?? chat.lastActivityAt ?? chat.lastMessage?.timestamp ?? chat.updatedAt);
    if (chat.id === chatID || !Number.isFinite(lastActivity) || lastActivity < start) continue;
    const detail = chat.participants ? chat : await api.getChat(chat.id);
    if (!participants(detail).some(p => !p.isSelf && !p.isSender && !selfIDs.has(p.senderID ?? p.id) && keys(p).some(k => peers.has(k)))) continue;
    selected.push({ chat: detail, rows: await readMessages(chat.id) });
  }
  const messages = [];
  for (const { chat, rows } of selected) for (const row of rows) {
    const m = normalizeHistory([row], { chatID: chat.id, chatTitle: chat.title ?? chat.id })[0];
    if (selfIDs.has(m.senderID)) m.isSender = true;
    m.attachments = await Promise.all(m.attachments.map(async (attachment, i) => {
      const a = { ...attachment, description: imageNotes[`${row.id}:${i}`] ?? imageNotes[row.id] ?? attachment.description };
      if (saveDir) try {
        const bytes = await api.downloadAttachment(attachment);
        const name = createHash('sha256').update(`${chat.id}\n${row.id}\n${i}`).digest('hex');
        fs.mkdirSync(saveDir, { recursive: true });
        a.savedPath = path.join(saveDir, name);
        fs.writeFileSync(a.savedPath, bytes);
      } catch { delete a.savedPath; }
      return a;
    }));
    messages.push(m);
  }
  return messages;
}

export async function checkBeeperReply({ draft, ...options }) {
  return checkPreSendReply({ draft, now: options.now, messages: await collectBeeperContext(options) });
}
export function assertReplyCheck(result) {
  if (!result?.ok) throw Object.assign(new Error(`送信前照合で停止: ${JSON.stringify(result?.findings || [])}`), { code: 'PRE_SEND_REPLY_BLOCKED', exitCode: 4, findings: result?.findings });
  return result;
}

export async function checkChannelReply({ channel, target, draft, messages, now, ...options }) {
  if (channel === 'beeper') return checkBeeperReply({ chatID: target, draft, now, ...options });
  if (!messages) {
    const { fetchHistory } = await import('../send-context-check.mjs');
    messages = (await fetchHistory(channel, target, options)).messages;
  }
  const notes = options.imageNotes || {};
  const normalized = normalizeHistory(messages, { chatID: target }).map(m => ({ ...m,
    attachments: m.attachments.map((a, i) => ({ ...a, description: notes[`${m.id}:${i}`] ?? notes[m.id] ?? a.description })) }));
  return checkPreSendReply({ draft, now, messages: normalized });
}
