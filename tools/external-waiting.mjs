#!/usr/bin/env node
// 社外の人を待たせている返信（受信の最後が社外）と、未送信のまま残った下書きを集めて状態ファイルへ書く。
// Gmail は DWD の読み取り専用のみ。送信・下書き作成・ラベル変更はしない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getDriveToken, defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { headerValue, extractBody } from './gmail-search.mjs';
import { isEntry } from './is-entry.mjs';
import { defaultHome, externalFile, stateDir, readJsonSafe, writeJsonAtomic, readSkips, isSkipped, addSkip } from './lib/external-waiting-state.mjs';

export const MAILBOXES = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
export const KIM = 'kim@orgiast.jp';
export const THREAD_QUERY = 'in:inbox newer_than:30d -category:promotions -category:social -category:forums';
export const HOUR = 3600_000;
export const WAIT_LIMIT_MS = 24 * HOUR;
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const META = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Message-ID', 'List-Unsubscribe', 'Auto-Submitted', 'Precedence'].map(h => `metadataHeaders=${h}`).join('&');
const MAX_PAGES = 5;
const NOTIFY_OK = ['dm', 'webhook', 'session-inbox'];
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const staffFile = path.join(toolsDir, '..', 'config', 'staff-addresses.json');

export const addressesOf = text => (String(text || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
export const isInternal = (address, staff) => /@orgiast\.jp$/.test(address) || staff.has(address);
export const normSubject = subject => String(subject || '').replace(/^\s*(?:(?:re|fw|fwd|返信|転送)\s*[:：]\s*)+/gi, '').replace(/\s+/g, ' ').trim();
function displayName(from) {
  const name = String(from).replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  return name && !name.includes('@') ? name : addressesOf(from)[0] || String(from);
}
export const makeId = (mailbox, key) => 'ex:' + createHash('sha256').update(`${mailbox}|${key}`).digest('hex').slice(0, 12);
export function loadStaff(file = staffFile) {
  return new Set((readJsonSafe(file, {}).addresses || []).map(value => String(value).toLowerCase()));
}

// 自動送信（返信不要）かどうか。
// 実データ（2026-11）で、ヘッダーに自動送信の印が無いまま届いた通知・領収・メルマガの送信元。
const AUTOMATED_DOMAINS = /@(?:[a-z0-9-]+\.)*(?:google\.com|stripe\.com|vercel\.com|supabase\.com|anthropic\.com|amazon\.co\.jp|paypay-bank\.co\.jp|povo\.jp|networkprint\.ne\.jp|makeleaps\.com|vpass\.ne\.jp|smbc\.co\.jp|eyez\.jp|seino\.co\.jp|jinjibu\.jp|jes24\.co\.jp|dekiteru\.jp)$/;
const AUTOMATED_SUBJECT = /自動返信|自動送信|auto-?reply|お問い合わせ(?:を)?受付|受付(?:完了|のお知らせ)/i;
export function isAutomated(headers) {
  const from = addressesOf(headers.from)[0] || '';
  if (/(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?|bounces?)|^(?:invoice|receipts?|failed-payments)\+/.test(from.split('@')[0] || '')) return true;
  if (AUTOMATED_DOMAINS.test(from) || AUTOMATED_SUBJECT.test(headers.subject || '')) return true;
  if (headers.listUnsubscribe) return true;
  if (headers.autoSubmitted && headers.autoSubmitted.toLowerCase() !== 'no') return true;
  return /^(?:bulk|list|junk)$/i.test(headers.precedence.trim());
}
const headersOf = message => ({
  from: headerValue(message.payload, 'from'), to: headerValue(message.payload, 'to'), cc: headerValue(message.payload, 'cc'), bcc: headerValue(message.payload, 'bcc'),
  subject: headerValue(message.payload, 'subject'), messageIdHeader: headerValue(message.payload, 'message-id'),
  listUnsubscribe: headerValue(message.payload, 'list-unsubscribe'), autoSubmitted: headerValue(message.payload, 'auto-submitted'), precedence: headerValue(message.payload, 'precedence'),
});
const dateOf = message => Number(message.internalDate) || Date.parse(headerValue(message.payload, 'date')) || 0;
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();

// お礼・了承だけの短文は返信が不要なことが多い。LLM に聞く対象かどうか。
export const isShortAck = snippet => {
  const text = clean(snippet);
  return text.length > 0 && text.length <= 60 && /ありがとう|承知|了解|かしこまり|拝受|確認(?:しました|いたしました)|お礼|助かり/.test(text) && !/[?？]|お願い|ください|下さい|いただけ|頂け/.test(text);
};

// スレッド1件を判定する。返信待ちなら項目、そうでなければ null。
export function analyzeThread(thread, { mailbox, staff = new Set() }) {
  const messages = (thread.messages || []).filter(message => !(message.labelIds || []).includes('DRAFT'));
  if (!messages.length) return null;
  const last = messages.reduce((a, b) => (dateOf(b) >= dateOf(a) ? b : a));
  const headers = headersOf(last), sender = addressesOf(headers.from)[0] || '';
  if (!sender || sender === mailbox || isInternal(sender, staff) || (last.labelIds || []).includes('SENT')) return null;
  if (isAutomated(headers)) return null;
  if (!addressesOf(headers.to).includes(mailbox)) return null;
  const snippet = clean(last.snippet);
  return {
    id: makeId(mailbox, thread.id), kind: 'reply', group: mailbox === KIM ? 'kim' : 'window', mailbox, who: displayName(headers.from), sender,
    subject: clean(headers.subject), since: new Date(dateOf(last)).toISOString(), ask: snippet.slice(0, 60) || '返信内容を決める',
    threadId: String(thread.id), lastMessageId: String(last.id), messageIdHeader: headers.messageIdHeader.trim(), needsCheck: isShortAck(snippet),
  };
}

// 24時間を超えて残る、社外宛の下書き。
export function analyzeDraft(draft, { mailbox, now = Date.now() }) {
  const message = draft.message || {};
  const headers = headersOf(message), since = dateOf(message);
  // 受信側と同じ30日窓に限る（数年前に放置された下書きまで通知しない）。
  if (!since || now - since <= WAIT_LIMIT_MS || now - since > 30 * 24 * HOUR) return null;
  const external = [headers.to, headers.cc, headers.bcc].flatMap(addressesOf).filter(address => !/@orgiast\.jp$/.test(address));
  if (!external.length) return null;
  return {
    id: makeId(mailbox, draft.id), kind: 'draft', group: mailbox === KIM ? 'kim' : 'window', mailbox, who: external[0], sender: external[0],
    subject: clean(headers.subject), since: new Date(since).toISOString(), ask: '送信するか決める', threadId: String(message.threadId || ''), lastMessageId: String(message.id || draft.id), messageIdHeader: '',
  };
}

// 窓口宛のメールは本文冒頭の宛名（「大平様」等）を担当として付ける。
export function addressee(body) {
  for (const line of String(body || '').split(/\r?\n/).map(clean).filter(Boolean).slice(0, 6)) {
    if (/御中/.test(line)) continue;
    const found = line.match(/([^\s　、,。「」()（）]{1,10}?)(様|さん)(?![ぁ-んァ-ヶ一-龠])/);
    if (found) return found[1] + found[2];
  }
  return '';
}

async function mapLimit(values, limit, fn) {
  const out = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (next < values.length) { const i = next++; out[i] = await fn(values[i]); } }));
  return out;
}

export async function scanMailbox(mailbox, { fetchImpl = gwsFetch, getToken = getDriveToken, staff, now = Date.now() }) {
  const token = await getToken({ scope: SCOPE, impersonate: mailbox, signal: AbortSignal.timeout(20_000) });
  const get = async (route, { optional = false } = {}) => {
    const response = await fetchImpl(`${API}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (optional && [404, 410].includes(response.status)) return null;
    if (!response.ok) throw new Error(`Gmail API ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
  const stubs = []; let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await get(`/threads?q=${encodeURIComponent(THREAD_QUERY)}&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    stubs.push(...(list.threads || []));
    if (!(pageToken = list.nextPageToken || '')) break;
  }
  const threads = (await mapLimit(stubs, 5, stub => get(`/threads/${stub.id}?format=metadata&${META}`, { optional: true }))).filter(Boolean);
  const items = threads.map(thread => analyzeThread(thread, { mailbox, staff })).filter(Boolean);
  if (mailbox !== KIM) {
    await mapLimit(items.filter(item => item.kind === 'reply'), 5, async item => {
      const full = await get(`/messages/${item.lastMessageId}?format=full`, { optional: true });
      item.assignee = full ? addressee(extractBody(full.payload, 1500)) : '';
    });
  }
  const drafts = (await get('/drafts?maxResults=100')).drafts || [];
  const detailed = await mapLimit(drafts, 5, stub => get(`/drafts/${stub.id}?format=metadata&${META}`, { optional: true }));
  items.push(...detailed.filter(Boolean).map(draft => analyzeDraft(draft, { mailbox, now })).filter(Boolean));
  return items;
}

// 同じメールが kim@ と seisaku-team@ の両方に届いている場合は1件にまとめる（kim 宛を優先）。
export function dedupe(items) {
  const seen = new Map();
  for (const item of [...items].sort((a, b) => (a.group === 'kim' ? 0 : 1) - (b.group === 'kim' ? 0 : 1))) {
    const key = item.kind === 'draft' ? `draft:${item.id}` : item.messageIdHeader || `${normSubject(item.subject)}|${item.sender}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

// 安価レーンに「返信が必要か」を聞く。失敗時は表示側に倒す（true）。
export function askLlm(item, { spawnImpl = spawnSync, tmpDir = os.tmpdir() } = {}) {
  const file = path.join(tmpDir, `external-waiting-${process.pid}-${item.lastMessageId}.txt`);
  try {
    fs.writeFileSync(file, `次の受信メールに、こちらから返信する必要はありますか。お礼や了承だけで返信不要なら no、質問・依頼・日程・確認などがあるなら yes。yes か no の1語だけで答えてください。\n\n件名: ${item.subject}\n本文: ${item.ask}\n`);
    const result = spawnImpl(process.execPath, [path.join(toolsDir, 'llm-ask.mjs'), '--provider', 'groq', '--category', 'classification', '--max', '10', '--prompt-file', file], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const answer = String(result.stdout || '').trim().toLowerCase();
    return result.status === 0 && /^no\b/.test(answer) ? false : true;
  } catch { return true; }
  finally { fs.rmSync(file, { force: true }); }
}

export function notifyText(items, now) {
  const mask = text => text.replace(/failed|failure|失敗|停止|異常|エラー|timeout|timed out|タイムアウト|未計測|取得不可/gi, '○');
  const lines = items.slice(0, 10).map(item => {
    const label = item.kind === 'draft' ? `下書きのまま未送信: ${item.who}` : item.who;
    return `・${mask(`${label}「${item.subject.slice(0, 40)}」`)}（${Math.floor((now - Date.parse(item.since)) / HOUR)}時間待ち・${item.group === 'kim' ? 'kim宛' : '制作チーム窓口'}）`;
  });
  return `【社外返信待ち】24時間以上お待たせしている社外の方が ${items.length} 件あります。\n${lines.join('\n')}${items.length > 10 ? `\nほか ${items.length - 10} 件` : ''}\n次のセッションの冒頭で返信下書きを用意します。`;
}

export async function scan({ home = defaultHome(), now = Date.now(), mailboxes = MAILBOXES, push = true, deps = {}, staff = loadStaff(), notify, classify = askLlm } = {}) {
  const previous = readJsonSafe(externalFile(home), {});
  const cacheFile = path.join(stateDir(home), 'external-waiting-llm-cache.json');
  const cache = readJsonSafe(cacheFile, {});
  const sources = {}, collected = [];
  for (const mailbox of mailboxes) {
    try { collected.push(...await scanMailbox(mailbox, { ...deps, staff, now })); sources[mailbox] = { ok: true }; }
    catch (error) {
      sources[mailbox] = { ok: false, error: String(error.message || error).slice(0, 300) };
      collected.push(...(previous.items || []).filter(item => item.mailbox === mailbox)); // 取得失敗を 0 件扱いにしない
    }
  }
  const skips = readSkips(home), kept = [];
  for (const item of dedupe(collected)) {
    if (isSkipped(skips, item)) continue;
    if (item.needsCheck) {
      if (!(item.lastMessageId in cache)) cache[item.lastMessageId] = classify(item);
      if (cache[item.lastMessageId] === false) continue;
    }
    const { needsCheck, ...rest } = item;
    kept.push(rest);
  }
  writeJsonAtomic(cacheFile, Object.fromEntries(Object.entries(cache).slice(-500)));
  const ids = new Set(kept.map(item => item.id));
  const pushed = Object.fromEntries(Object.entries(previous.pushed || {}).filter(([id, at]) => ids.has(id) && now - at < 7 * 24 * HOUR));
  let notified = null;
  if (push) {
    const due = kept.filter(item => now - Date.parse(item.since) >= WAIT_LIMIT_MS && !(pushed[item.id] && now - pushed[item.id] < WAIT_LIMIT_MS));
    if (due.length) {
      const send = notify || (async text => (await import('./notify-kim.mjs')).notifyKim(text, { kind: 'info', source: 'external-waiting', plainJa: false }));
      notified = await send(notifyText(due, now));
      if (NOTIFY_OK.includes(notified?.delivered)) for (const item of due) pushed[item.id] = now;
    }
  }
  const state = { generatedAt: new Date(now).toISOString(), sources, items: kept, pushed };
  writeJsonAtomic(externalFile(home), state);
  return { state, notified };
}

export function summarize(state) {
  const count = key => kept => kept.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
  return { sources: state.sources, total: state.items.length, byKind: count('kind')(state.items), byMailbox: count('mailbox')(state.items) };
}

if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
    if (args.includes('--skip')) {
      if (!value('--reason')) throw new Error('--reason required');
      addSkip(defaultHome(), value('--skip'), value('--reason'));
    } else if (args.includes('--scan')) {
      // DWD の鍵が無い PC では何もしない（鍵ありの PC だけが走査する）。
      if (!fs.existsSync(process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath())) { console.log('external-waiting: DWD の鍵が無いため何もしません'); }
      else {
        const { state, notified } = await scan({ push: !args.includes('--no-push') });
        console.log(JSON.stringify({ ...summarize(state), notified: notified?.delivered ?? null }, null, 1));
      }
    } else { console.error('使い方: node tools/external-waiting.mjs --scan [--no-push] | --skip <id> --reason <text>'); process.exitCode = 2; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
