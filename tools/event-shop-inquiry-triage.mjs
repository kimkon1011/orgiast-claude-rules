import { readFile } from 'node:fs/promises';
import { isEntry } from './is-entry.mjs';

const DAY = 86400000;
const dateKey = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(value));
const time = value => new Date(value).getTime();
const bodyLines = message => String(message?.body ?? '').split(/\r?\n/).filter(line => !/^\s*>/.test(line)).map(line => line.trim()).filter(Boolean);
export function deduplicateMessages(messages) {
  const seen = new Set();
  return [...messages].sort((a, b) => time(b.received_at) - time(a.received_at)).filter(m => {
    const key = m.rfc822_message_id || `${m.received_at}|${m.direction}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function classifyLead(lead, messages, now = new Date()) {
  const unique = deduplicateMessages(messages);
  const lastIn = unique.find(m => m.direction === 'inbound');
  const lastOut = unique.find(m => m.direction === 'outbound');
  const past = Boolean(lead.preferred_date && lead.preferred_date < dateKey(now));
  const declined = /見送|改めてご連絡|必要な際は|今回は|辞退/.test(bodyLines(lastIn).join('\n'));
  // 登録上の開催日が過ぎていても、直近14日以内に顧客から未回答の返信があれば進行中として扱う。
  const activeReply = Boolean(lastIn && (!lastOut || time(lastIn.received_at) > time(lastOut.received_at)) && time(now) - time(lastIn.received_at) < 14 * DAY);
  let category, nextAction;
  if (declined || (past && !activeReply)) {
    category = '⚪ 終了候補';
    nextAction = past ? '開催日経過→管理画面で完了に' : '辞退の返信あり→管理画面で完了に';
  } else if (!lastOut || (lastIn && time(lastIn.received_at) > time(lastOut.received_at))) {
    category = '🔴 要返信';
    const excerpt = bodyLines(lastIn).find(line => !/^(お世話に|いつも|お待たせ|恐れ入)|^.{0,12}ありがとうございます。?$|です。$|様[、。]?$|^[-=＝―─*]+$/.test(line)) ?? '';
    nextAction = !lastOut
      ? `初回返信が未送信（下書き有無: ${lead.raw_payload?.event_shop?.draft_saved_at ? '下書きあり・未送信' : '下書きなし'}）`
      : `顧客の返信に未回答: ${Array.from(excerpt).slice(0, 60).join('')}`;
  } else {
    category = '🟡 顧客待ち';
    const days = Math.max(0, Math.floor((time(now) - time(lastOut.received_at)) / DAY));
    nextAction = `顧客の返信待ち（最終送信から ${days} 日）${days >= 7 ? '・追客候補' : ''}`;
  }
  return { ...lead, category, nextAction, lastIn: lastIn ?? null, lastOut: lastOut ?? null };
}
const excluded = lead => lead.raw_payload?.event_shop?.closed_at || String(lead.company_name ?? '').includes('連携テスト') || /@(orgiast\.jp|event-shop\.jp)$/i.test(lead.email ?? '');
export function deduplicateLeads(leads) {
  const kept = [];
  let duplicateCount = 0;
  for (const lead of [...leads].filter(l => !excluded(l)).sort((a, b) => time(b.created_at) - time(a.created_at))) {
    if (kept.some(other => String(other.email ?? '').toLowerCase() === String(lead.email ?? '').toLowerCase() && JSON.stringify(other.raw_payload?.product) === JSON.stringify(lead.raw_payload?.product) && Math.abs(time(other.created_at) - time(lead.created_at)) <= 2 * DAY)) duplicateCount++;
    else kept.push(lead);
  }
  return { leads: kept, duplicateCount };
}
export function sortLeads(leads) {
  const rank = { '🔴 要返信': 0, '🟡 顧客待ち': 1, '⚪ 終了候補': 2 };
  return [...leads].sort((a, b) => rank[a.category] - rank[b.category] || (a.category === '🔴 要返信' ? (a.preferred_date || '9999').localeCompare(b.preferred_date || '9999') : 0) || time(a.created_at) - time(b.created_at));
}
export async function loadCredentials(env = process.env) {
  const path = env.EVENT_SHOP_ENV_FILE || 'D:/Claude/event-shop/.env.local';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, path };
  let contents = '';
  try { contents = await readFile(path, 'utf8'); } catch { /* Missing credentials must not block session startup. */ }
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return { url: values.NEXT_PUBLIC_SUPABASE_URL || values.SUPABASE_URL, key: values.SUPABASE_SERVICE_ROLE_KEY || values.SUPABASE_SECRET_KEY, path };
}
const freeMail = /^(gmail\.com|googlemail\.com|yahoo\.(com|co\.jp)|ymail\.com|icloud\.com|me\.com|mac\.com|outlook\.(com|jp)|hotmail\.(com|co\.jp)|live\.(com|jp)|msn\.com|aol\.com)$/i;
export function messageQuery(lead) {
  const domain = String(lead.email ?? '').split('@')[1] || '';
  const pattern = encodeURIComponent(freeMail.test(domain) ? lead.email : domain);
  return `/rest/v1/channel_messages?select=received_at,direction,sender_identifier,subject,body,rfc822_message_id&received_at=gte.${String(lead.created_at).slice(0, 10)}&or=(sender_identifier.ilike.*${pattern}*,raw->>to.ilike.*${pattern}*,raw->>cc.ilike.*${pattern}*)&order=received_at.desc&limit=20`;
}
async function request(credentials, query, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(`${credentials.url.replace(/\/$/, '')}${query}`, { headers: { apikey: credentials.key, Authorization: `Bearer ${credentials.key}` }, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'APIエラー'}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('応答形式エラー');
    return data;
  } finally { clearTimeout(timer); }
}
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const shortDate = value => value ? String(value).slice(5, 10).replace('-', '/') : '未定';
export function renderMarkdown(leads, duplicateCount, now) {
  const counts = ['🔴 要返信', '🟡 顧客待ち', '⚪ 終了候補'].map(c => leads.filter(l => l.category === c).length);
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(now);
  const lines = [`## ${counts[0] ? '🔴' : '✅'} イベント百貨店 問合せ（${stamp} 時点）要返信 ${counts[0]} 件 / 顧客待ち ${counts[1]} 件 / 終了候補 ${counts[2]} 件`, ...(duplicateCount ? [`重複 ${duplicateCount} 件`] : []), '| 区分 | 会社 / 担当 | 受信(経過) | 開催日 | 最終やり取り | 次の一手 | 画面 |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const lead of leads) {
    const latest = [lead.lastIn, lead.lastOut].filter(Boolean).sort((a, b) => time(b.received_at) - time(a.received_at))[0];
    const ended = lead.category === '⚪ 終了候補';
    lines.push(`| ${lead.category} | ${cell(lead.company_name)}${ended ? '' : ` / ${cell(lead.contact_name)}`} | ${ended ? '' : `${shortDate(lead.created_at)} (${Math.max(0, Math.floor((time(now) - time(lead.created_at)) / DAY))}日)`} | ${ended ? '' : shortDate(lead.preferred_date)} | ${ended ? '' : latest ? `${latest.direction === 'inbound' ? '顧客' : '当社'} ${shortDate(latest.received_at)}` : 'なし'} | ${cell(lead.nextAction)} | https://event-shop.jp/admin/inquiries/${encodeURIComponent(lead.id)} |`);
  }
  return lines.join('\n');
}
export async function main({ env = process.env, args = process.argv.slice(2), now = new Date(), fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const credentials = await loadCredentials(env);
  if (!credentials.url || !credentials.key) { log(`イベント百貨店問合せ: 未確認（認証情報なし。試したパス: ${credentials.path}）`); return 0; }
  try {
    const since = dateKey(new Date(time(now) - 120 * DAY));
    const data = await request(credentials, `/rest/v1/quote_requests?select=id,company_name,contact_name,email,event_name,preferred_date,created_at,status,raw_payload&source=eq.event-shop.jp&created_at=gte.${since}&order=created_at.desc&limit=200`, fetchImpl);
    const { leads, duplicateCount } = deduplicateLeads(data);
    const results = [];
    for (const lead of leads) results.push(classifyLead(lead, await request(credentials, messageQuery(lead), fetchImpl), now));
    const sorted = sortLeads(results);
    if (args.includes('--quiet') && !sorted.some(l => l.category === '🔴 要返信')) return 0;
    log(args.includes('--json') ? JSON.stringify(sorted, null, 2) : renderMarkdown(sorted, duplicateCount, now));
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'タイムアウト' : String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 100);
    log(`イベント百貨店問合せ: 未確認（${reason}）`);
  }
  return 0;
}
if (isEntry(import.meta.url)) await main();
